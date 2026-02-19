/**
 * LogInTo — Personal Remote Desktop Server
 *
 * Runs on your laptop. Serves the web client to your phone.
 * Captures your screen and streams it via WebSocket.
 * Receives mouse/keyboard input from your phone and injects it.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const ScreenCapture = require('./capture');
const InputHandler = require('./input');

// ─── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 3456;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'changeme123';
const SESSION_SECRET = process.env.SESSION_SECRET || uuidv4();
const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5;
const LOCKOUT_MINUTES = parseInt(process.env.LOCKOUT_MINUTES) || 15;
const CAPTURE_QUALITY = parseInt(process.env.CAPTURE_QUALITY) || 60;
const CAPTURE_FPS = parseInt(process.env.CAPTURE_FPS) || 15;
const CAPTURE_SCALE = parseFloat(process.env.CAPTURE_SCALE) || 0.5;

// ─── App Setup ───────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 10e6, // 10MB max for screen frames
  pingTimeout: 60000,
  pingInterval: 25000
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

// ─── Auth State ──────────────────────────────────────────
const sessions = new Map(); // token → { created, lastActive }
let passwordHash = null;

async function initPassword() {
  passwordHash = await bcrypt.hash(ACCESS_PASSWORD, 12);
  console.log('🔒 Password protection enabled');
}

function isValidSession(token) {
  const session = sessions.get(token);
  if (!session) return false;
  // Sessions expire after 24 hours
  if (Date.now() - session.created > 24 * 60 * 60 * 1000) {
    sessions.delete(token);
    return false;
  }
  session.lastActive = Date.now();
  return true;
}

// ─── Routes ──────────────────────────────────────────────

// Login page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Login endpoint
app.post('/api/login', loginLimiter, async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  const valid = await bcrypt.compare(password, passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  const token = uuidv4();
  sessions.set(token, { created: Date.now(), lastActive: Date.now() });

  console.log('✅ New session authenticated');
  res.json({ token });
});

// Session check
app.get('/api/session', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (isValidSession(token)) {
    res.json({ valid: true });
  } else {
    res.status(401).json({ valid: false });
  }
});

// Get screen info
app.get('/api/screen-info', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidSession(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const info = screenCapture.getScreenInfo();
  res.json(info);
});

// ─── Screen Capture ──────────────────────────────────────
const screenCapture = new ScreenCapture({
  quality: CAPTURE_QUALITY,
  fps: CAPTURE_FPS,
  scale: CAPTURE_SCALE
});

// ─── Input Handler ───────────────────────────────────────
const inputHandler = new InputHandler();

// ─── Socket.IO Connection ────────────────────────────────
let activeViewer = null;

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (isValidSession(token)) {
    next();
  } else {
    next(new Error('Authentication required'));
  }
});

io.on('connection', (socket) => {
  console.log(`📱 Device connected: ${socket.id}`);

  if (activeViewer) {
    // Disconnect previous viewer (only 1 at a time for personal use)
    activeViewer.emit('kicked', { reason: 'Another device connected' });
    activeViewer.disconnect();
  }
  activeViewer = socket;

  // Start streaming screen
  screenCapture.startStreaming((frameData) => {
    if (socket.connected) {
      socket.volatile.emit('frame', frameData);
    }
  });

  // Send initial screen info
  socket.emit('screen-info', screenCapture.getScreenInfo());

  // ─── Handle Input Events from Phone ────────────────
  socket.on('mouse-move', (data) => {
    inputHandler.moveMouse(data.x, data.y);
  });

  socket.on('mouse-click', (data) => {
    inputHandler.click(data.x, data.y, data.button || 'left');
  });

  socket.on('mouse-double-click', (data) => {
    inputHandler.doubleClick(data.x, data.y);
  });

  socket.on('mouse-right-click', (data) => {
    inputHandler.rightClick(data.x, data.y);
  });

  socket.on('mouse-scroll', (data) => {
    inputHandler.scroll(data.x, data.y, data.deltaX || 0, data.deltaY || 0);
  });

  socket.on('key-press', (data) => {
    inputHandler.keyPress(data.key, data.modifiers || []);
  });

  socket.on('key-type', (data) => {
    inputHandler.typeText(data.text);
  });

  // Settings updates
  socket.on('update-quality', (data) => {
    screenCapture.setQuality(data.quality);
  });

  socket.on('update-fps', (data) => {
    screenCapture.setFPS(data.fps);
  });

  socket.on('disconnect', () => {
    console.log(`📱 Device disconnected: ${socket.id}`);
    if (activeViewer === socket) {
      activeViewer = null;
      screenCapture.stopStreaming();
    }
  });
});

// ─── Start Server ────────────────────────────────────────
async function start() {
  await initPassword();

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
    console.log('   🖥️  LogInTo — Remote Desktop Running');
    console.log('═══════════════════════════════════════════');
    console.log('');
    console.log(`   Local:   http://localhost:${PORT}`);
    console.log(`   Network: http://${localIP}:${PORT}`);
    console.log('');
    console.log('   📱 Open the Network URL on your phone');
    console.log('      (when on same WiFi)');
    console.log('');
    console.log('   🌐 For remote access, run:');
    console.log('      npm run tunnel');
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('');
  });
}

start().catch(console.error);
