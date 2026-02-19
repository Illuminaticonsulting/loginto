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

// ─── State ───────────────────────────────────────────────
const sessions = new Map();  // token → { userId, created, lastActive }
const agents = new Map();    // userId → { socket, screenInfo, connected }
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

// Agent status
app.get('/api/user-status/:userId', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const agent = agents.get(req.params.userId);
  res.json({ agentConnected: agent?.connected || false });
});

// Agent key
app.get('/api/agent-info/:userId', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (session.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });

  const agentKey = users.getAgentKey(req.params.userId);
  res.json({ agentKey });
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
  "scripts": { "start": "node agent.js" },
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
curl -sfL "${serverURL}/agent-files/agent.js"  -o agent.js
curl -sfL "${serverURL}/agent-files/capture.js" -o capture.js
curl -sfL "${serverURL}/agent-files/input.js"   -o input.js

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

$ErrorActionPreference = "Stop"

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
  "scripts": { "start": "node agent.js" },
  "dependencies": {
    "dotenv": "^16.4.1",
    "screenshot-desktop": "^1.12.7",
    "sharp": "^0.33.2",
    "socket.io-client": "^4.7.4"
  },
  "optionalDependencies": { "robotjs": "^0.6.0" }
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
Invoke-WebRequest -Uri "${serverURL}/agent-files/agent.js"  -OutFile "agent.js"  -UseBasicParsing
Invoke-WebRequest -Uri "${serverURL}/agent-files/capture.js" -OutFile "capture.js" -UseBasicParsing
Invoke-WebRequest -Uri "${serverURL}/agent-files/input.js"   -OutFile "input.js"   -UseBasicParsing

# Install dependencies (skip robotjs if it fails)
Write-Host "Installing dependencies..." -ForegroundColor Yellow
npm install --no-optional --no-fund --no-audit 2>$null
Write-Host "[OK] Core dependencies installed" -ForegroundColor Green

# Try robotjs (optional)
Write-Host "Trying robotjs (optional)..." -ForegroundColor Yellow
npm install robotjs 2>$null
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

// ─── Catch-All: redirect unknown routes to login ─────────
app.get('*', (req, res) => {
  res.redirect('/');
});

// ─── Socket.IO Auth Middleware ───────────────────────────
io.use((socket, next) => {
  const { token, role, agentKey } = socket.handshake.auth;

  if (role === 'agent') {
    if (!agentKey) return next(new Error('Agent key required'));
    const user = users.getByAgentKey(agentKey);
    if (!user) return next(new Error('Invalid agent key'));
    socket.userId = user.id;
    socket.displayName = user.displayName;
    socket.role = 'agent';
    next();
  } else {
    if (!isValidSession(token)) return next(new Error('Authentication required'));
    const session = getSession(token);
    socket.userId = session.userId;
    socket.role = role || 'viewer';
    next();
  }
});

// ─── Room helpers ────────────────────────────────────────
// Room naming: "viewers:<userId>" for all viewers of a user
//              "user:<userId>" for all sockets (viewers + dashboards) of a user
function viewerRoom(userId) { return `viewers:${userId}`; }
function userRoom(userId)   { return `user:${userId}`; }

// ─── Socket.IO Connection Handler ────────────────────────
io.on('connection', (socket) => {

  // ═══ AGENT ═══
  if (socket.role === 'agent') {
    console.log(`🖥️  Agent online: ${socket.displayName}`);

    const existing = agents.get(socket.userId);
    if (existing?.connected) {
      existing.socket.emit('kicked', { reason: 'Another agent connected' });
      existing.socket.disconnect();
    }

    agents.set(socket.userId, { socket, screenInfo: null, connected: true });

    // Notify all viewers/dashboards for this user via room
    io.to(userRoom(socket.userId)).emit('agent-status', { connected: true });

    socket.on('screen-info', (info) => {
      const agent = agents.get(socket.userId);
      if (agent) agent.screenInfo = info;
      io.to(viewerRoom(socket.userId)).emit('screen-info', info);
    });

    // Frame relay — uses volatile + room broadcast (O(1) lookup instead of O(n) forEach)
    socket.on('frame', (frameData) => {
      io.to(viewerRoom(socket.userId)).volatile.emit('frame', frameData);
    });

    // Relay displays-list from agent → viewers
    socket.on('displays-list', (displays) => {
      io.to(viewerRoom(socket.userId)).emit('displays-list', displays);
    });

    // Relay clipboard-content from agent → viewers
    socket.on('clipboard-content', (data) => {
      io.to(viewerRoom(socket.userId)).emit('clipboard-content', data);
    });

    socket.on('disconnect', () => {
      console.log(`🖥️  Agent offline: ${socket.displayName || socket.userId}`);
      agents.delete(socket.userId);
      io.to(userRoom(socket.userId)).emit('agent-status', { connected: false });
    });
  }

  // ═══ VIEWER ═══
  else if (socket.role === 'viewer') {
    console.log(`📱 Viewer connected: ${socket.userId}`);

    // Join rooms (supports multiple concurrent viewers per user)
    socket.join(viewerRoom(socket.userId));
    socket.join(userRoom(socket.userId));

    const agent = agents.get(socket.userId);
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
        const agent = agents.get(socket.userId);
        if (agent?.connected) agent.socket.emit(event, data);
      });
    });

    socket.on('mouse-scroll', (data) => {
      if (!validScroll(data)) return;
      const agent = agents.get(socket.userId);
      if (agent?.connected) agent.socket.emit('mouse-scroll', data);
    });

    socket.on('key-press', (data) => {
      if (!validKey(data)) return;
      if (data.modifiers && !Array.isArray(data.modifiers)) return;
      const agent = agents.get(socket.userId);
      if (agent?.connected) agent.socket.emit('key-press', data);
    });

    socket.on('key-type', (data) => {
      if (!data || typeof data.text !== 'string' || data.text.length > 500) return;
      const agent = agents.get(socket.userId);
      if (agent?.connected) agent.socket.emit('key-type', data);
    });

    socket.on('update-quality', (data) => {
      if (!data || typeof data.quality !== 'number' || data.quality < 10 || data.quality > 100) return;
      const a = agents.get(socket.userId);
      if (a?.connected) a.socket.emit('update-quality', data);
    });
    socket.on('update-fps', (data) => {
      if (!data || typeof data.fps !== 'number' || data.fps < 1 || data.fps > 60) return;
      const a = agents.get(socket.userId);
      if (a?.connected) a.socket.emit('update-fps', data);
    });

    // Multi-monitor
    socket.on('list-screens', () => {
      const a = agents.get(socket.userId);
      if (a?.connected) a.socket.emit('list-screens');
    });
    socket.on('switch-screen', (data) => {
      const a = agents.get(socket.userId);
      if (a?.connected) a.socket.emit('switch-screen', data);
    });

    // Clipboard sync
    socket.on('clipboard-write', (data) => {
      const a = agents.get(socket.userId);
      if (a?.connected) a.socket.emit('clipboard-write', data);
    });
    socket.on('clipboard-read', () => {
      const a = agents.get(socket.userId);
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
      const room = io.sockets.adapter.rooms.get(viewerRoom(socket.userId));
      if (!room || room.size === 0) {
        const agent = agents.get(socket.userId);
        if (agent?.connected) agent.socket.emit('stop-streaming');
      }
    });
  }

  // ═══ DASHBOARD (lightweight status listener) ═══
  else if (socket.role === 'dashboard') {
    socket.join(userRoom(socket.userId));
    const agent = agents.get(socket.userId);
    socket.emit('agent-status', { connected: agent?.connected || false });
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
