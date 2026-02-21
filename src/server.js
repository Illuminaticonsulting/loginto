/**
 * LogInTo — Multi-User Dashboard & Relay Server
 *
 * Runs on DigitalOcean. Does NOT capture screens or inject input.
 * Instead, it RELAYS:
 *   - Screen frames FROM desktop agents TO phone viewers
 *   - Input events FROM phone viewers TO desktop agents
 *
 * Two roles connect via Socket.IO:
 *   - agent: runs on user's laptop (captures screen, injects input)
 *   - viewer: runs in user's phone browser (views screen, sends input)
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const users = require('./users');
const wol = require('wol');

// ─── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 3456;
const SESSION_SECRET = process.env.SESSION_SECRET || uuidv4();
const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5;
const LOCKOUT_MINUTES = parseInt(process.env.LOCKOUT_MINUTES) || 15;

// ─── App Setup ───────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 10e6,
  pingTimeout: 60000,
  pingInterval: 25000,
  perMessageDeflate: false  // JPEG is already compressed; deflate adds CPU cost
});

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

app.use(compression());           // gzip for static files + API responses
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rate limiting for login
const loginLimiter = rateLimit({
  windowMs: LOCKOUT_MINUTES * 60 * 1000,
  max: MAX_LOGIN_ATTEMPTS,
  message: { error: `Too many login attempts. Try again in ${LOCKOUT_MINUTES} minutes.` },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limit Wake-on-LAN — prevents UDP broadcast spam
const wakeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many wake attempts. Wait a minute.' },
  standardHeaders: true,
  legacyHeaders: false
});

// ─── State ───────────────────────────────────────────────
const sessions = new Map();  // token → { userId, created, lastActive }
const agents = new Map();    // agentKey → { socket, screenInfo, connected, userId, machineId, machineName }
const invites = new Map();   // inviteToken → { userId, machineId, machineName, displayName, expiresAt }
// Viewers now tracked via Socket.IO rooms: `viewers:${userId}`
// No Map needed — rooms handle multi-viewer broadcast efficiently

// ─── Session Cleanup (every 10 min, expire after 24h) ────
const SESSION_TTL = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, session] of sessions) {
    if (now - session.lastActive > SESSION_TTL) {
      sessions.delete(token);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} expired sessions (${sessions.size} active)`);
}, 10 * 60 * 1000);

function isValidSession(token) {
  const session = sessions.get(token);
  if (!session) return false;
  const now = Date.now();
  // Expire if inactive for 24h (not just since creation)
  if (now - session.lastActive > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  session.lastActive = now;
  return true;
}

function getSession(token) {
  return sessions.get(token) || null;
}

// ─── HTTP Routes ─────────────────────────────────────────

// Health check — for load balancers / uptime monitoring
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    sessions: sessions.size,
    agents: agents.size,
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB'
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Login endpoint
app.post('/api/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  const user = await users.authenticateByPassword(password);
  if (!user) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  const token = uuidv4();
  sessions.set(token, {
    userId: user.id,
    created: Date.now(),
    lastActive: Date.now()
  });

  console.log(`✅ ${user.displayName} logged in`);
  res.json({ token, userId: user.id, displayName: user.displayName });
});

// Logout endpoint — invalidate session
app.post('/api/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// Session check
app.get('/api/session', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) {
    return res.status(401).json({ valid: false });
  }
  const session = getSession(token);
  const user = users.getById(session.userId);
  res.json({ valid: true, userId: session.userId, displayName: user?.displayName });
});

// Agent status — now returns all machines with status
app.get('/api/user-status/:userId', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const machines = users.getMachines(req.params.userId);
  const result = machines.map(m => ({
    id: m.id,
    name: m.name,
    connected: agents.get(m.agentKey)?.connected || false
  }));
  // Legacy compat
  const anyConnected = result.some(m => m.connected);
  res.json({ agentConnected: anyConnected, machines: result });
});

// Machines list
app.get('/api/machines/:userId', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const machines = users.getMachines(req.params.userId);
  const result = machines.map(m => ({
    ...m,
    connected: agents.get(m.agentKey)?.connected || false
  }));
  res.json({ machines: result });
});

// Add machine
app.post('/api/machines/:userId', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const { name } = req.body;
  const machine = users.addMachine(req.params.userId, name || 'New Machine');
  if (!machine) return res.status(400).json({ error: 'Could not add machine' });
  res.json({ machine });
});

// Delete machine
app.delete('/api/machines/:userId/:machineId', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const ok = users.removeMachine(req.params.userId, req.params.machineId);
  if (!ok) return res.status(404).json({ error: 'Machine not found' });
  res.json({ ok: true });
});

// Rename machine
app.patch('/api/machines/:userId/:machineId', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const ok = users.renameMachine(req.params.userId, req.params.machineId, name);
  if (!ok) return res.status(404).json({ error: 'Machine not found' });
  res.json({ ok: true });
});

// Agent key — returns all machines
app.get('/api/agent-info/:userId', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const machines = users.getMachines(req.params.userId);
  // Legacy compat: also return first agentKey
  res.json({ agentKey: machines[0]?.agentKey || null, machines });
});

// Setup script — one-liner install for desktop agent
app.get('/api/setup/:agentKey', (req, res) => {
  const user = users.getByAgentKey(req.params.agentKey);
  if (!user) return res.status(404).send('# Invalid agent key');

  // Always use HTTPS (Nginx terminates SSL, so req.protocol might be 'http')
  const serverURL = `https://${req.get('host')}`;
  const key = req.params.agentKey;

  const script = `#!/bin/bash
set -e

echo ""
echo "═══════════════════════════════════════════"
echo "   LogInTo — Desktop Agent Installer"
echo "═══════════════════════════════════════════"
echo ""

# Check for Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js is not installed."
  echo ""
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "   Install it with:  brew install node"
    echo "   Or download from: https://nodejs.org"
  else
    echo "   Install it with:  sudo apt install -y nodejs npm"
    echo "   Or download from: https://nodejs.org"
  fi
  echo ""
  exit 1
fi

echo "✅ Node.js found: $(node -v)"

# Create agent directory
AGENT_DIR="$HOME/loginto-agent"
mkdir -p "$AGENT_DIR"
cd "$AGENT_DIR"
echo "📁 Agent directory: $AGENT_DIR"

# Write package.json
cat > package.json << 'PKGJSON'
{
  "name": "loginto-agent",
  "version": "1.0.0",
  "description": "LogInTo Desktop Agent",
  "main": "agent.js",
  "scripts": { "start": "node agent.js", "install-service": "node install-service.js" },
  "dependencies": {
    "dotenv": "^16.4.1",
    "screenshot-desktop": "^1.12.7",
    "sharp": "^0.33.2",
    "socket.io-client": "^4.7.4"
  },
  "optionalDependencies": { "robotjs": "^0.6.0" }
}
PKGJSON

# Write .env
cat > .env << ENVFILE
SERVER_URL=${serverURL}
AGENT_KEY=${key}
CAPTURE_QUALITY=92
CAPTURE_FPS=20
CAPTURE_SCALE=1.0
ENVFILE

# Download agent files from server
echo "📥 Downloading agent files..."
curl -sfL "${serverURL}/agent-files/agent.js"           -o agent.js
curl -sfL "${serverURL}/agent-files/capture.js"          -o capture.js
curl -sfL "${serverURL}/agent-files/input.js"            -o input.js
curl -sfL "${serverURL}/agent-files/install-service.js"  -o install-service.js

# Install dependencies
echo "📦 Installing dependencies (this may take a minute)..."
npm install --no-fund --no-audit 2>&1 | tail -1

echo ""
echo "═══════════════════════════════════════════"
echo "   ✅ Agent installed successfully!"
echo "═══════════════════════════════════════════"
echo ""
echo "   Starting agent..."
echo ""

# macOS permissions reminder
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo "   ⚠️  macOS: Grant permissions if prompted:"
  echo "      System Settings → Privacy → Screen Recording → Terminal"
  echo "      System Settings → Privacy → Accessibility → Terminal"
  echo ""
fi

node agent.js
`;

  res.type('text/plain').send(script);
});

// ─── Windows Setup Script (PowerShell) ──────────────────
app.get('/api/setup-win/:agentKey', (req, res) => {
  const user = users.getByAgentKey(req.params.agentKey);
  if (!user) return res.status(404).send('# Invalid agent key');

  const serverURL = `https://${req.get('host')}`;
  const key = req.params.agentKey;

  const script = `
# LogInTo Agent - Windows PowerShell Installer
# Run this in PowerShell (as Administrator recommended)

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   LogInTo - Desktop Agent Installer (Win)"   -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVersion = node -v
    Write-Host "[OK] Node.js $nodeVersion found" -ForegroundColor Green
} catch {
    Write-Host "[!] Node.js is NOT installed." -ForegroundColor Red
    Write-Host ""
    Write-Host "    Download from: https://nodejs.org/en/download" -ForegroundColor Yellow
    Write-Host "    Install the Windows Installer (.msi), then re-run this script."
    Write-Host ""
    pause
    exit 1
}

# Create agent directory
$agentDir = "$env:USERPROFILE\\loginto-agent"
if (!(Test-Path $agentDir)) { New-Item -ItemType Directory -Path $agentDir | Out-Null }
Set-Location $agentDir
Write-Host "[OK] Agent directory: $agentDir" -ForegroundColor Green

# Write package.json
@'
{
  "name": "loginto-agent",
  "version": "1.0.0",
  "description": "LogInTo Desktop Agent",
  "main": "agent.js",
  "scripts": { "start": "node agent.js", "install-service": "node install-service.js" },
  "dependencies": {
    "dotenv": "^16.4.1",
    "screenshot-desktop": "^1.12.7",
    "sharp": "^0.33.2",
    "socket.io-client": "^4.7.4"
  }
}
'@ | Set-Content -Path "package.json" -Encoding UTF8

# Write .env
@"
SERVER_URL=${serverURL}
AGENT_KEY=${key}
CAPTURE_QUALITY=92
CAPTURE_FPS=20
CAPTURE_SCALE=1.0
"@ | Set-Content -Path ".env" -Encoding UTF8

# Download agent files
Write-Host "Downloading agent files..." -ForegroundColor Yellow
Invoke-WebRequest -Uri "${serverURL}/agent-files/agent.js"           -OutFile "agent.js"           -UseBasicParsing
Invoke-WebRequest -Uri "${serverURL}/agent-files/capture.js"          -OutFile "capture.js"          -UseBasicParsing
Invoke-WebRequest -Uri "${serverURL}/agent-files/input.js"            -OutFile "input.js"            -UseBasicParsing
Invoke-WebRequest -Uri "${serverURL}/agent-files/install-service.js"  -OutFile "install-service.js"  -UseBasicParsing

# Clean any broken sharp install and reinstall everything
Write-Host "Installing dependencies..." -ForegroundColor Yellow
if (Test-Path "node_modules\\sharp") { Remove-Item -Recurse -Force "node_modules\\sharp" 2>$null }
if (Test-Path "node_modules\\@img") { Remove-Item -Recurse -Force "node_modules\\@img" 2>$null }
& npm install --no-fund --no-audit 2>&1 | Where-Object { $_ -notmatch "^npm warn" }
# Explicitly install sharp's Windows native binary
& npm install @img/sharp-win32-x64 --no-fund --no-audit 2>&1 | Where-Object { $_ -notmatch "^npm warn" }
Write-Host "[OK] Dependencies installed" -ForegroundColor Green

# Try robotjs (optional — usually fails without C++ build tools, that's OK)
Write-Host "Trying robotjs (optional)..." -ForegroundColor Yellow
& npm install robotjs 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[i] robotjs skipped - using PowerShell fallback (works fine)" -ForegroundColor Yellow
} else {
    Write-Host "[OK] robotjs installed" -ForegroundColor Green
}

# Create start script
@"
@echo off
title LogInTo Agent
cd /d "%~dp0"
node agent.js
pause
"@ | Set-Content -Path "start-agent.bat" -Encoding ASCII

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "   Agent installed successfully!"              -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host "   Starting agent..." -ForegroundColor Cyan
Write-Host ""

node agent.js
`;

  res.type('text/plain').send(script);
});

// Serve agent source files (for the setup script to download)
app.use('/agent-files', express.static(path.join(__dirname, '..', 'agent'), {
  index: false,
  dotfiles: 'ignore',
  extensions: ['js']
}));

// ─── Wake-on-LAN ─────────────────────────────────────────

// Send WoL magic packet to wake a sleeping machine
app.post('/api/machines/:userId/:machineId/wake', wakeLimiter, async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const machine = users.getMachine(req.params.userId, req.params.machineId);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  if (!machine.macAddress) {
    return res.status(400).json({ error: 'No MAC address configured for this machine' });
  }

  // Already online — no need to wake
  const agent = agents.get(machine.agentKey);
  if (agent?.connected) {
    return res.json({ ok: true, alreadyOnline: true, message: 'Machine is already online' });
  }

  const broadcastAddress = machine.broadcastAddress || '255.255.255.255';

  try {
    await new Promise((resolve, reject) => {
      wol.wake(machine.macAddress, { address: broadcastAddress, port: 9 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log(`WoL: magic packet sent to ${machine.macAddress} via ${broadcastAddress}`);
    res.json({ ok: true, message: `Wake-on-LAN packet sent to ${machine.macAddress}` });
  } catch (err) {
    console.error('WoL error:', err);
    res.status(500).json({ error: 'Failed to send WoL packet: ' + err.message });
  }
});

// Set or clear Wake-on-LAN MAC address for a machine
app.patch('/api/machines/:userId/:machineId/mac', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const { macAddress, broadcastAddress } = req.body;

  if (macAddress) {
    const macRegex = /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/;
    if (!macRegex.test(macAddress)) {
      return res.status(400).json({ error: 'Invalid MAC address. Use format: AA:BB:CC:DD:EE:FF' });
    }
  }

  if (broadcastAddress) {
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(broadcastAddress)) {
      return res.status(400).json({ error: 'Invalid broadcast IP address' });
    }
  }

  const ok = users.setMacAddress(
    req.params.userId, req.params.machineId,
    macAddress || null, broadcastAddress || null
  );
  if (!ok) return res.status(404).json({ error: 'Machine not found' });
  res.json({ ok: true });
});

// ─── Invite Links ────────────────────────────────────────

const INVITE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// Create invite link for a machine
app.post('/api/invites/:userId/:machineId', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const machine = users.getMachine(req.params.userId, req.params.machineId);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });

  const user = users.getById(req.params.userId);
  const inviteToken = uuidv4();
  const expiresAt   = Date.now() + INVITE_TTL;

  invites.set(inviteToken, {
    userId:      req.params.userId,
    machineId:   req.params.machineId,
    machineName: machine.name,
    displayName: user?.displayName || req.params.userId,
    expiresAt
  });

  const host = `${req.protocol}://${req.get('host')}`;
  res.json({
    inviteToken,
    inviteUrl: `${host}/viewer.html?invite=${inviteToken}`,
    expiresAt
  });
});

// Public invite info (no auth — viewer page uses this to show whose machine it is)
app.get('/api/invite-info/:inviteToken', (req, res) => {
  const inv = invites.get(req.params.inviteToken);
  if (!inv || Date.now() > inv.expiresAt) {
    return res.status(404).json({ error: 'Invalid or expired invite link' });
  }
  res.json({
    userId:      inv.userId,
    displayName: inv.displayName,
    machineName: inv.machineName,
    expiresAt:   inv.expiresAt
  });
});

// Revoke an invite
app.delete('/api/invites/:userId/:inviteToken', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const inv = invites.get(req.params.inviteToken);
  if (!inv || inv.userId !== req.params.userId) return res.status(404).json({ error: 'Invite not found' });

  invites.delete(req.params.inviteToken);
  res.json({ ok: true });
});

// ─── Catch-All: redirect unknown routes to login ─────────
app.get('*', (req, res) => {
  res.redirect('/');
});

// ─── Socket.IO Auth Middleware ───────────────────────────
io.use((socket, next) => {
  const { token, role, agentKey, inviteToken } = socket.handshake.auth;

  if (role === 'agent') {
    if (!agentKey) return next(new Error('Agent key required'));
    const user = users.getByAgentKey(agentKey);
    if (!user) return next(new Error('Invalid agent key'));
    socket.userId = user.id;
    socket.displayName = user.displayName;
    socket.agentKey = agentKey;
    socket.machineId = user.machineId;
    socket.machineName = user.machineName;
    socket.role = 'agent';
    next();
  } else if (inviteToken) {
    const inv = invites.get(inviteToken);
    if (!inv || Date.now() > inv.expiresAt) return next(new Error('Invalid or expired invite link'));
    socket.userId = inv.userId;
    socket.role = 'viewer';
    socket.machineId = inv.machineId;
    socket.isInvited = true;
    next();
  } else {
    if (!isValidSession(token)) return next(new Error('Authentication required'));
    const session = getSession(token);
    socket.userId = session.userId;
    socket.role = role || 'viewer';
    // Viewer specifies which machine to connect to
    socket.machineId = socket.handshake.auth.machineId || null;
    next();
  }
});

// ─── Room helpers ────────────────────────────────────────
function viewerRoom(agentKey) { return `viewers:${agentKey}`; }
function userRoom(userId)     { return `user:${userId}`; }

// ─── Socket.IO Connection Handler ────────────────────────
io.on('connection', (socket) => {

  // ═══ AGENT ═══
  if (socket.role === 'agent') {
    console.log(`🖥️  Agent online: ${socket.displayName} — ${socket.machineName}`);

    const existing = agents.get(socket.agentKey);
    if (existing?.connected) {
      existing.socket.emit('kicked', { reason: 'Another agent connected for this machine' });
      existing.socket.disconnect();
    }

    agents.set(socket.agentKey, {
      socket,
      screenInfo: null,
      connected: true,
      userId: socket.userId,
      machineId: socket.machineId,
      machineName: socket.machineName
    });

    // Notify viewers watching this machine + dashboard
    io.to(viewerRoom(socket.agentKey)).emit('agent-status', { connected: true });
    io.to(userRoom(socket.userId)).emit('machine-status', {
      machineId: socket.machineId, connected: true
    });

    socket.on('screen-info', (info) => {
      const agent = agents.get(socket.agentKey);
      if (agent) agent.screenInfo = info;
      io.to(viewerRoom(socket.agentKey)).emit('screen-info', info);
    });

    // Frame relay — uses volatile + room broadcast (O(1) lookup instead of O(n) forEach)
    socket.on('frame', (frameData) => {
      io.to(viewerRoom(socket.agentKey)).volatile.emit('frame', frameData);
    });

    // Relay displays-list from agent → viewers
    socket.on('displays-list', (displays) => {
      io.to(viewerRoom(socket.agentKey)).emit('displays-list', displays);
    });

    // Relay clipboard-content from agent → viewers
    socket.on('clipboard-content', (data) => {
      io.to(viewerRoom(socket.agentKey)).emit('clipboard-content', data);
    });

    socket.on('disconnect', () => {
      console.log(`🖥️  Agent offline: ${socket.displayName} — ${socket.machineName || socket.agentKey}`);
      agents.delete(socket.agentKey);
      io.to(viewerRoom(socket.agentKey)).emit('agent-status', { connected: false });
      io.to(userRoom(socket.userId)).emit('machine-status', {
        machineId: socket.machineId, connected: false
      });
    });
  }

  // ═══ VIEWER ═══
  else if (socket.role === 'viewer') {
    // Resolve agentKey from machineId
    let agentKey = null;
    if (socket.machineId) {
      const machine = users.getMachine(socket.userId, socket.machineId);
      if (machine) agentKey = machine.agentKey;
    }
    if (!agentKey) {
      // Fallback: use first machine's agentKey (legacy / single-machine compat)
      const machines = users.getMachines(socket.userId);
      if (machines.length > 0) agentKey = machines[0].agentKey;
    }

    socket.agentKey = agentKey;
    console.log(`📱 Viewer connected: ${socket.userId} → machine ${socket.machineId || 'default'}`);

    // Join rooms (supports multiple concurrent viewers per machine)
    if (agentKey) socket.join(viewerRoom(agentKey));
    socket.join(userRoom(socket.userId));

    const agent = agentKey ? agents.get(agentKey) : null;
    if (agent?.connected) {
      socket.emit('agent-status', { connected: true });
      agent.socket.emit('start-streaming');
      if (agent.screenInfo) socket.emit('screen-info', agent.screenInfo);
    } else {
      socket.emit('agent-status', { connected: false });
    }

    // ─── Input Validation Helpers ─────────────────────────
    function validCoord(v) { return typeof v === 'number' && isFinite(v) && v >= -10 && v <= 100000; }
    function validButton(v) { return ['left', 'right', 'middle'].includes(v); }
    function validMouse(d) { return d && validCoord(d.x) && validCoord(d.y); }
    function validScroll(d) { return validMouse(d) && typeof d.deltaX === 'number' && typeof d.deltaY === 'number'; }
    function validKey(d) { return d && typeof d.key === 'string' && d.key.length <= 20; }

    // Relay input → agent (with validation)
    ['mouse-move', 'mouse-click', 'mouse-double-click',
     'mouse-right-click', 'mouse-down', 'mouse-up'
    ].forEach(event => {
      socket.on(event, (data) => {
        if (!validMouse(data)) return;
        if (data.button && !validButton(data.button)) return;
        const agent = socket.agentKey ? agents.get(socket.agentKey) : null;
        if (agent?.connected) agent.socket.emit(event, data);
      });
    });

    socket.on('mouse-scroll', (data) => {
      if (!validScroll(data)) return;
      const agent = socket.agentKey ? agents.get(socket.agentKey) : null;
      if (agent?.connected) agent.socket.emit('mouse-scroll', data);
    });

    socket.on('key-press', (data) => {
      if (!validKey(data)) return;
      if (data.modifiers && !Array.isArray(data.modifiers)) return;
      const agent = socket.agentKey ? agents.get(socket.agentKey) : null;
      if (agent?.connected) agent.socket.emit('key-press', data);
    });

    socket.on('key-type', (data) => {
      if (!data || typeof data.text !== 'string' || data.text.length > 500) return;
      const agent = socket.agentKey ? agents.get(socket.agentKey) : null;
      if (agent?.connected) agent.socket.emit('key-type', data);
    });

    socket.on('update-quality', (data) => {
      if (!data || typeof data.quality !== 'number' || data.quality < 10 || data.quality > 100) return;
      const a = socket.agentKey ? agents.get(socket.agentKey) : null;
      if (a?.connected) a.socket.emit('update-quality', data);
    });
    socket.on('update-fps', (data) => {
      if (!data || typeof data.fps !== 'number' || data.fps < 1 || data.fps > 60) return;
      const a = socket.agentKey ? agents.get(socket.agentKey) : null;
      if (a?.connected) a.socket.emit('update-fps', data);
    });

    // Multi-monitor
    socket.on('list-screens', () => {
      const a = socket.agentKey ? agents.get(socket.agentKey) : null;
      if (a?.connected) a.socket.emit('list-screens');
    });
    socket.on('switch-screen', (data) => {
      const a = socket.agentKey ? agents.get(socket.agentKey) : null;
      if (a?.connected) a.socket.emit('switch-screen', data);
    });

    // Clipboard sync
    socket.on('clipboard-write', (data) => {
      const a = socket.agentKey ? agents.get(socket.agentKey) : null;
      if (a?.connected) a.socket.emit('clipboard-write', data);
    });
    socket.on('clipboard-read', () => {
      const a = socket.agentKey ? agents.get(socket.agentKey) : null;
      if (a?.connected) a.socket.emit('clipboard-read');
    });

    // Latency ping — viewer sends 'latency-ping', server echoes back immediately
    socket.on('latency-ping', (data) => {
      socket.emit('latency-pong', data);
    });

    socket.on('disconnect', () => {
      console.log(`📱 Viewer disconnected: ${socket.userId}`);
      // Room membership auto-cleaned by Socket.IO on disconnect
      // Stop streaming only if no viewers left in the room
      if (socket.agentKey) {
        const room = io.sockets.adapter.rooms.get(viewerRoom(socket.agentKey));
        if (!room || room.size === 0) {
          const agent = agents.get(socket.agentKey);
          if (agent?.connected) agent.socket.emit('stop-streaming');
        }
      }
    });
  }

  // ═══ DASHBOARD (lightweight status listener) ═══
  else if (socket.role === 'dashboard') {
    socket.join(userRoom(socket.userId));
    // Send initial status for all machines
    const machines = users.getMachines(socket.userId);
    for (const m of machines) {
      const agent = agents.get(m.agentKey);
      socket.emit('machine-status', {
        machineId: m.id,
        connected: agent?.connected || false
      });
    }
    socket.on('disconnect', () => { /* room auto-cleaned */ });
  }
});

// ─── Start Server ────────────────────────────────────────
async function start() {
  await users.init();

  server.listen(PORT, '0.0.0.0', () => {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let localIP = 'localhost';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIP = iface.address;
          break;
        }
      }
    }

    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('   🖥️  LogInTo — Dashboard Server Running');
    console.log('═══════════════════════════════════════════');
    console.log('');
    console.log(`   Local:   http://localhost:${PORT}`);
    console.log(`   Network: http://${localIP}:${PORT}`);
    console.log('');
    console.log('   Users: kingpin, tez');
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('');
  });
}

start().catch(console.error);

// ─── Graceful Shutdown ───────────────────────────────────
function shutdown(signal) {
  console.log(`\n🛑 ${signal} received — shutting down gracefully...`);
  // Notify all connected sockets
  io.emit('server-shutdown', { message: 'Server restarting' });
  // Stop accepting new connections
  server.close(() => {
    console.log('   HTTP server closed');
    process.exit(0);
  });
  // Force exit after 5s if connections won't close
  setTimeout(() => { console.log('   Force exit'); process.exit(1); }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
