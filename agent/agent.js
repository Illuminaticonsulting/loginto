#!/usr/bin/env node

/**
 * LogInTo — Desktop Agent
 *
 * Runs on your laptop/desktop. Connects to the LogInTo server,
 * captures your screen, and relays input events from your phone.
 *
 * Usage:
 *   1. Copy .env.example to .env
 *   2. Paste your AGENT_KEY from the dashboard
 *   3. npm install
 *   4. npm start
 */

require('dotenv').config();
const { io } = require('socket.io-client');
const ScreenCapture = require('./capture');
const InputHandler = require('./input');

// ─── Config ──────────────────────────────────────────────
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3456';
const AGENT_KEY = process.env.AGENT_KEY;
const CAPTURE_QUALITY = parseInt(process.env.CAPTURE_QUALITY) || 80;
const CAPTURE_FPS = parseInt(process.env.CAPTURE_FPS) || 20;
const CAPTURE_SCALE = parseFloat(process.env.CAPTURE_SCALE) || 0.75;

if (!AGENT_KEY) {
  console.error('');
  console.error('  ❌ AGENT_KEY is required!');
  console.error('');
  console.error('  1. Log into your dashboard at ' + SERVER_URL);
  console.error('  2. Copy the Agent Key shown on the dashboard');
  console.error('  3. Create a .env file in this folder with:');
  console.error('');
  console.error('     SERVER_URL=' + SERVER_URL);
  console.error('     AGENT_KEY=your-key-here');
  console.error('');
  process.exit(1);
}

// ─── Modules ─────────────────────────────────────────────
const capture = new ScreenCapture({
  quality: CAPTURE_QUALITY,
  fps: CAPTURE_FPS,
  scale: CAPTURE_SCALE
});

const input = new InputHandler();

// ─── Socket Connection ───────────────────────────────────
let socket = null;
let reconnectAttempts = 0;

function connect() {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('   🖥️  LogInTo — Desktop Agent');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('   Server: ' + SERVER_URL);
  console.log('   Connecting...');
  console.log('');

  socket = io(SERVER_URL, {
    auth: {
      agentKey: AGENT_KEY,
      role: 'agent'
    },
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
    reconnectionAttempts: Infinity,
    timeout: 10000
  });

  socket.on('connect', () => {
    reconnectAttempts = 0;
    console.log('   ✅ Connected to server!');
    console.log('   Waiting for viewer to connect...');
    console.log('');

    // Send screen info
    const screenInfo = capture.getScreenInfo();
    socket.emit('screen-info', screenInfo);
  });

  socket.on('disconnect', (reason) => {
    console.log('   ⚠️  Disconnected: ' + reason);
    capture.stopStreaming();
  });

  socket.on('connect_error', (err) => {
    reconnectAttempts++;
    if (reconnectAttempts === 1) {
      console.error('   ❌ Connection failed: ' + err.message);
      if (err.message === 'Invalid agent key') {
        console.error('');
        console.error('   Your AGENT_KEY is invalid or expired.');
        console.error('   Get a new one from your dashboard.');
        process.exit(1);
      }
      console.log('   Retrying...');
    }
  });

  socket.on('kicked', (data) => {
    console.log('   ⚠️  Kicked: ' + (data.reason || 'Another agent connected'));
    capture.stopStreaming();
  });

  // ─── Streaming Control ─────────────────────────────────
  socket.on('start-streaming', () => {
    console.log('   📱 Viewer connected — streaming started');
    capture.startStreaming((frameData) => {
      if (socket.connected) {
        socket.volatile.emit('frame', frameData);
      }
    });
  });

  socket.on('stop-streaming', () => {
    console.log('   📱 Viewer disconnected — streaming stopped');
    capture.stopStreaming();
  });

  // ─── Quality/FPS Updates ───────────────────────────────
  socket.on('update-quality', (data) => {
    capture.setQuality(data.quality);
  });

  socket.on('update-fps', (data) => {
    capture.setFPS(data.fps);
  });

  // ─── Input Relay ───────────────────────────────────────
  socket.on('mouse-move', (data) => {
    input.moveMouse(data.x, data.y);
  });

  socket.on('mouse-click', (data) => {
    input.click(data.x, data.y, data.button || 'left');
  });

  socket.on('mouse-double-click', (data) => {
    input.doubleClick(data.x, data.y);
  });

  socket.on('mouse-right-click', (data) => {
    input.rightClick(data.x, data.y);
  });

  socket.on('mouse-scroll', (data) => {
    input.scroll(data.x, data.y, data.deltaX, data.deltaY);
  });

  socket.on('mouse-down', (data) => {
    input.mouseDown(data.x, data.y, data.button || 'left');
  });

  socket.on('mouse-up', (data) => {
    input.mouseUp(data.x, data.y, data.button || 'left');
  });

  socket.on('key-press', (data) => {
    input.keyPress(data.key, data.modifiers || []);
  });

  socket.on('key-type', (data) => {
    input.typeText(data.text);
  });
}

// ─── Graceful Shutdown ───────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n   Shutting down...');
  capture.stopStreaming();
  if (socket) socket.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  capture.stopStreaming();
  if (socket) socket.disconnect();
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────
connect();
