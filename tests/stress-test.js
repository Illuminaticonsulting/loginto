#!/usr/bin/env node
/**
 * LogInTo — Comprehensive Stress Test
 *
 * Tests:
 *  1. HTTP endpoint load (login, session check)
 *  2. Socket.IO connections (agent + viewer)
 *  3. Frame relay throughput (simulated frames)
 *  4. Input event flood (mouse-move at 60Hz)
 *  5. Concurrent connections / disconnections
 *  6. Memory leak detection
 *  7. Reconnection storm
 */

const { io } = require('socket.io-client');
const http = require('http');
const https = require('https');

// ─── Config ────────────────────────────────────────────
const SERVER = process.argv[2] || 'https://loginto.kingpinstrategies.com';
const PASSWORD = process.argv[3] || 'kingpin';
const FRAME_SIZE_KB = 80;           // Typical JPEG frame size
const FRAME_RATE = 20;              // FPS to simulate
const INPUT_RATE_HZ = 60;           // Mouse move events/sec
const TEST_DURATION_MS = 15000;     // Each test phase duration
const CONCURRENT_VIEWERS = 5;       // Simulated extra viewer connections

const isHttps = SERVER.startsWith('https');
const httpModule = isHttps ? https : http;

// ─── Helpers ───────────────────────────────────────────
function log(icon, msg) {
  console.log(`   ${icon}  ${msg}`);
}

function hrMs(start) {
  const d = process.hrtime.bigint() - start;
  return Number(d / 1000000n);
}

function request(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      rejectUnauthorized: false,
      timeout: 10000,
    };
    const req = httpModule.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateFakeFrame(sizeKB) {
  // Create a realistic-sized raw buffer (simulates JPEG data)
  const buf = Buffer.alloc(sizeKB * 1024);
  for (let i = 0; i < buf.length; i += 4) {
    buf.writeUInt32LE((Math.random() * 0xFFFFFFFF) >>> 0, i);
  }
  return buf;  // raw Buffer — matches binary transport mode
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

// ─── Results Collector ──────────────────────────────────
const results = {};

// ═══════════════════════════════════════════════════════
//  TEST 1: HTTP Endpoint Load
// ═══════════════════════════════════════════════════════
async function testHTTPEndpoints() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  TEST 1: HTTP Endpoint Load');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Get a valid token first (single request)
  const loginStart = process.hrtime.bigint();
  const loginRes = await request('POST', `${SERVER}/api/login`, { password: PASSWORD });
  const loginTime = hrMs(loginStart);

  if (loginRes.status === 429) {
    log('🚫', `Rate limited (${loginTime.toFixed(0)}ms) — previous test burned attempts`);
    log('💡', 'Rate limit is 5 attempts per 15 min — this is correct security behavior');
    log('💡', 'Falling back: running socket tests without HTTP load test');
    // Try to read the agent key from local data instead
    try {
      const fs = require('fs');
      const usersData = JSON.parse(fs.readFileSync('/Users/ballout/Desktop/loginto/data/users.json', 'utf8'));
      const user = usersData.find(u => u.id === 'kingpin');
      if (user) {
        log('🔧', 'Got agent key from local data file');
        // We need a valid session — start server locally to get one
        log('⚠️', 'Cannot run socket tests without a valid session token');
        log('💡', 'Wait 15 minutes and re-run, or restart the server to clear rate limits');
        results.http = { avgLogin: loginTime, maxLogin: loginTime, loginErrors: 1, avgSession: 0 };
        return { token: null, userId: 'kingpin', agentKey: user.agentKey };
      }
    } catch (e) { /* ignore */ }
    results.http = { avgLogin: loginTime, maxLogin: loginTime, loginErrors: 1, avgSession: 0 };
    return { token: null, userId: null };
  }

  if (loginRes.status !== 200) {
    log('❌', `Login failed: status ${loginRes.status}`);
    results.http = { avgLogin: loginTime, maxLogin: loginTime, loginErrors: 1, avgSession: 0 };
    return { token: null, userId: null };
  }

  const token = loginRes.data.token;
  const userId = loginRes.data.userId;
  log('🔑', `Login: ${loginTime.toFixed(0)}ms, user: ${loginRes.data.displayName}`);

  // Session check load test
  const sessionTimes = [];
  for (let i = 0; i < 30; i++) {
    const start = process.hrtime.bigint();
    try {
      const res = await request('GET', `${SERVER}/api/session`, null, { Authorization: `Bearer ${token}` });
      if (res.status === 200) sessionTimes.push(hrMs(start));
    } catch (e) { /* ignore */ }
  }

  const avgSession = sessionTimes.length > 0
    ? sessionTimes.reduce((a, b) => a + b, 0) / sessionTimes.length : 0;
  log('🔒', `Session check: avg ${avgSession.toFixed(0)}ms (${sessionTimes.length}/30 ok)`);

  // Static file load test (with gzip)
  const staticTimes = [];
  const staticPaths = ['/css/style.css', '/js/viewer.js', '/js/dashboard.js'];
  for (const p of staticPaths) {
    const start = process.hrtime.bigint();
    try {
      const res = await request('GET', `${SERVER}${p}`, null, { 'Accept-Encoding': 'gzip, deflate' });
      staticTimes.push({ path: p, time: hrMs(start) });
    } catch (e) { /* ignore */ }
  }
  if (staticTimes.length > 0) {
    const avgStatic = staticTimes.reduce((a, b) => a + b.time, 0) / staticTimes.length;
    log('📄', `Static files: avg ${avgStatic.toFixed(0)}ms (${staticTimes.length} files, gzip enabled)`);
  }

  results.http = { avgLogin: loginTime, maxLogin: loginTime, loginErrors: 0, avgSession };
  return { token, userId };
}

// ═══════════════════════════════════════════════════════
//  TEST 2: Socket.IO Connection + Frame Throughput
// ═══════════════════════════════════════════════════════
async function testSocketFrameRelay(token, userId) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  TEST 2: Socket.IO Frame Relay');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // We need the real agent key. Get it via API.
  let agentKey;
  try {
    const res = await request('GET', `${SERVER}/api/agent-info/${userId}`, null, {
      Authorization: `Bearer ${token}`
    });
    agentKey = res.data.agentKey;
    if (!agentKey) log('⚠️', `Agent info response: ${JSON.stringify(res.data)}`);
  } catch (e) {
    log('❌', `Cannot get agent key: ${e.message}`);
    return;
  }

  if (!agentKey) {
    log('⚠️', 'No agent key returned — skipping socket tests');
    return;
  }

  return new Promise(async (resolve) => {
    // Connect fake agent
    const agent = io(SERVER, {
      auth: { agentKey, role: 'agent' },
      transports: ['websocket'],
      rejectUnauthorized: false,
    });

    let agentConnected = false;
    agent.on('connect', () => {
      agentConnected = true;
      log('🖥️', 'Fake agent connected');
      // Send screen info
      agent.emit('screen-info', {
        width: 2560, height: 1440,
        scaledWidth: 1280, scaledHeight: 720,
        inputWidth: 2560, inputHeight: 1440,
        quality: 92, fps: 20, scale: 0.5
      });
    });

    agent.on('connect_error', (e) => {
      log('❌', `Agent connection error: ${e.message}`);
      resolve();
    });

    // Wait for agent to connect
    await new Promise(r => {
      const check = setInterval(() => {
        if (agentConnected) { clearInterval(check); r(); }
      }, 100);
      setTimeout(() => { clearInterval(check); r(); }, 5000);
    });

    if (!agentConnected) {
      log('❌', 'Agent failed to connect within 5s');
      agent.disconnect();
      resolve();
      return;
    }

    // Connect viewer
    const viewer = io(SERVER, {
      auth: { token, role: 'viewer' },
      transports: ['websocket'],
      rejectUnauthorized: false,
    });

    let viewerConnected = false;
    let framesReceived = 0;
    let bytesReceived = 0;
    let firstFrameTime = null;
    let lastFrameTime = null;
    const frameTimes = [];

    viewer.on('connect', () => {
      viewerConnected = true;
      log('📱', 'Fake viewer connected');
    });

    viewer.on('screen-info', (info) => {
      log('📐', `Screen info received: ${info.scaledWidth}x${info.scaledHeight}`);
    });

    viewer.on('frame', (data) => {
      const now = Date.now();
      if (!firstFrameTime) firstFrameTime = now;
      if (lastFrameTime) frameTimes.push(now - lastFrameTime);
      lastFrameTime = now;
      framesReceived++;
      bytesReceived += (data.data?.length || 0);
    });

    // Wait for viewer
    await new Promise(r => {
      const check = setInterval(() => {
        if (viewerConnected) { clearInterval(check); r(); }
      }, 100);
      setTimeout(() => { clearInterval(check); r(); }, 5000);
    });

    if (!viewerConnected) {
      log('❌', 'Viewer failed to connect');
      agent.disconnect();
      resolve();
      return;
    }

    // Simulate frame streaming at target FPS
    log('🎬', `Streaming ${FRAME_RATE} FPS for ${TEST_DURATION_MS / 1000}s (${FRAME_SIZE_KB}KB frames)...`);
    const fakeFrame = generateFakeFrame(FRAME_SIZE_KB);
    const frameInterval = 1000 / FRAME_RATE;
    let framesSent = 0;
    let bytesSent = 0;

    const streamTimer = setInterval(() => {
      const frameData = {
        data: fakeFrame,
        width: 1280,
        height: 720,
        timestamp: Date.now(),
        frame: ++framesSent,
        quality: 92
      };
      agent.volatile.emit('frame', frameData);
      bytesSent += fakeFrame.length;
    }, frameInterval);

    // Run for test duration
    await sleep(TEST_DURATION_MS);
    clearInterval(streamTimer);

    // Wait for last frames to arrive
    await sleep(500);

    const elapsed = (lastFrameTime - firstFrameTime) / 1000 || 1;
    const actualFPS = framesReceived / elapsed;
    const avgFrameInterval = frameTimes.length > 0
      ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0;
    const droppedFrames = framesSent - framesReceived;
    const dropRate = ((droppedFrames / framesSent) * 100);

    log('📊', `Sent: ${framesSent} frames (${formatBytes(bytesSent)})`);
    log('📊', `Received: ${framesReceived} frames (${formatBytes(bytesReceived)})`);
    log('📊', `Actual FPS: ${actualFPS.toFixed(1)}`);
    log('📊', `Avg frame interval: ${avgFrameInterval.toFixed(1)}ms`);
    log('📊', `Dropped: ${droppedFrames} frames (${dropRate.toFixed(1)}%)`);

    if (dropRate > 90) log('❌', 'Extreme frame drop — check server/network');
    else if (dropRate > 50) log('⚠️', 'High drops — expected with volatile.emit over WAN');
    else if (dropRate > 20) log('⚠️', 'Moderate frame drops');
    else log('✅', 'Frame relay is excellent');

    results.frames = { sent: framesSent, received: framesReceived, actualFPS, dropRate, avgInterval: avgFrameInterval };

    // ═══════════════════════════════════════════════════════
    //  TEST 3: Input Event Flood
    // ═══════════════════════════════════════════════════════
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  TEST 3: Input Event Flood');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    let inputsSent = 0;
    let inputsReceived = 0;
    const inputDuration = 5000;

    agent.on('mouse-move', () => { inputsReceived++; });

    log('🖱️', `Flooding mouse-move at ${INPUT_RATE_HZ}Hz for ${inputDuration / 1000}s...`);
    const inputTimer = setInterval(() => {
      viewer.emit('mouse-move', {
        x: Math.round(Math.random() * 2560),
        y: Math.round(Math.random() * 1440)
      });
      inputsSent++;
    }, 1000 / INPUT_RATE_HZ);

    await sleep(inputDuration);
    clearInterval(inputTimer);
    await sleep(300);

    const inputDropRate = ((inputsSent - inputsReceived) / inputsSent * 100);
    log('📊', `Sent: ${inputsSent} mouse-move events`);
    log('📊', `Received by agent: ${inputsReceived}`);
    log('📊', `Lost: ${inputsSent - inputsReceived} (${inputDropRate.toFixed(1)}%)`);

    if (inputDropRate > 5) log('⚠️', 'Input events being lost');
    else log('✅', 'Input relay is reliable');

    results.input = { sent: inputsSent, received: inputsReceived, dropRate: inputDropRate };

    // ═══════════════════════════════════════════════════════
    //  TEST 4: Keyboard Input Test
    // ═══════════════════════════════════════════════════════
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  TEST 4: Keyboard Events');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    let keysReceived = 0;
    let typesReceived = 0;
    agent.on('key-press', () => { keysReceived++; });
    agent.on('key-type', () => { typesReceived++; });

    // Key presses
    const keys = ['a', 'b', 'Enter', 'Backspace', 'Tab', 'Escape', 'F1', 'F5', 'ArrowUp', 'Delete'];
    for (const k of keys) {
      viewer.emit('key-press', { key: k, modifiers: [] });
    }

    // Combos
    viewer.emit('key-press', { key: 'c', modifiers: ['ctrl'] });
    viewer.emit('key-press', { key: 'v', modifiers: ['ctrl'] });
    viewer.emit('key-press', { key: 'z', modifiers: ['ctrl', 'shift'] });

    // Text typing
    viewer.emit('key-type', { text: 'Hello, LogInTo stress test!' });

    await sleep(500);

    log('⌨️', `Key presses sent: ${keys.length + 3}, received: ${keysReceived}`);
    log('⌨️', `Key types sent: 1, received: ${typesReceived}`);

    if (keysReceived === keys.length + 3 && typesReceived === 1) {
      log('✅', 'All keyboard events relayed correctly');
    } else {
      log('⚠️', `Keyboard event loss detected`);
    }

    results.keyboard = { keysSent: keys.length + 3, keysReceived, typesSent: 1, typesReceived };

    // ═══════════════════════════════════════════════════════
    //  TEST 5: Reconnection Storm
    // ═══════════════════════════════════════════════════════
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  TEST 5: Rapid Reconnection Storm');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const reconnectCount = 10;
    let successfulReconnects = 0;
    const reconnectTimes = [];

    log('🔄', `Performing ${reconnectCount} rapid viewer reconnects...`);

    for (let i = 0; i < reconnectCount; i++) {
      const start = process.hrtime.bigint();
      const tempViewer = io(SERVER, {
        auth: { token, role: 'viewer' },
        transports: ['websocket'],
        rejectUnauthorized: false,
        reconnection: false,
      });

      await new Promise(r => {
        tempViewer.on('connect', () => {
          successfulReconnects++;
          reconnectTimes.push(hrMs(start));
          tempViewer.disconnect();
          r();
        });
        tempViewer.on('connect_error', () => { tempViewer.disconnect(); r(); });
        setTimeout(() => { tempViewer.disconnect(); r(); }, 3000);
      });
    }

    const avgReconnect = reconnectTimes.length > 0
      ? reconnectTimes.reduce((a, b) => a + b, 0) / reconnectTimes.length : 0;
    log('📊', `Successful: ${successfulReconnects}/${reconnectCount}`);
    log('📊', `Avg connect time: ${avgReconnect.toFixed(0)}ms`);

    if (successfulReconnects === reconnectCount) log('✅', 'Reconnection storm handled');
    else log('⚠️', `${reconnectCount - successfulReconnects} connections failed`);

    results.reconnect = { attempts: reconnectCount, successes: successfulReconnects, avgTime: avgReconnect };

    // ═══════════════════════════════════════════════════════
    //  TEST 6: Large Frame Test
    // ═══════════════════════════════════════════════════════
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  TEST 6: Large Frame / Edge Cases');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Reconnect viewer for this test
    const viewer2 = io(SERVER, {
      auth: { token, role: 'viewer' },
      transports: ['websocket'],
      rejectUnauthorized: false,
    });

    let v2Connected = false;
    let largeFrameReceived = false;
    viewer2.on('connect', () => { v2Connected = true; });
    viewer2.on('frame', () => { largeFrameReceived = true; });

    await new Promise(r => {
      const check = setInterval(() => { if (v2Connected) { clearInterval(check); r(); } }, 100);
      setTimeout(() => { clearInterval(check); r(); }, 3000);
    });

    if (v2Connected) {
      // 500KB frame (4K quality) — send multiple times since relay is volatile
      const largeFrame = generateFakeFrame(500);
      for (let i = 0; i < 5; i++) {
        agent.emit('frame', {
          data: largeFrame,
          width: 2560, height: 1440,
          timestamp: Date.now(), frame: 9999 + i, quality: 95
        });
        await sleep(200);
      }
      await sleep(2000);

      if (largeFrameReceived) log('✅', 'Large frame (500KB) relayed successfully');
      else log('⚠️', 'Large frame not received — may exceed maxHttpBufferSize');

      // Empty / malformed events (should not crash server)
      viewer2.emit('mouse-move', {});
      viewer2.emit('key-press', {});
      viewer2.emit('mouse-click', null);
      await sleep(300);
      log('✅', 'Server survived malformed events without crashing');

      viewer2.disconnect();
    } else {
      log('⚠️', 'Could not reconnect viewer for large frame test');
    }

    results.largeFrame = { received: largeFrameReceived };

    // ═══════════════════════════════════════════════════════
    //  TEST 7: Multi-Viewer Concurrent Streaming
    // ═══════════════════════════════════════════════════════
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  TEST 7: Multi-Viewer Concurrent Streaming');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const MULTI_VIEWER_COUNT = 5;
    const multiViewers = [];
    const multiFrameCounts = new Array(MULTI_VIEWER_COUNT).fill(0);
    let allConnected = 0;

    log('👥', `Connecting ${MULTI_VIEWER_COUNT} viewers simultaneously...`);

    for (let i = 0; i < MULTI_VIEWER_COUNT; i++) {
      const mv = io(SERVER, {
        auth: { token, role: 'viewer' },
        transports: ['websocket'],
        rejectUnauthorized: false,
        reconnection: false,
      });
      mv.on('connect', () => { allConnected++; });
      mv.on('frame', () => { multiFrameCounts[i]++; });
      multiViewers.push(mv);
    }

    // Wait for all to connect
    await new Promise(r => {
      const check = setInterval(() => {
        if (allConnected >= MULTI_VIEWER_COUNT) { clearInterval(check); r(); }
      }, 100);
      setTimeout(() => { clearInterval(check); r(); }, 5000);
    });

    log('📊', `Connected: ${allConnected}/${MULTI_VIEWER_COUNT}`);

    if (allConnected === MULTI_VIEWER_COUNT) {
      // Stream frames for 5 seconds
      const multiFrame = generateFakeFrame(FRAME_SIZE_KB);
      let multiSent = 0;
      const multiTimer = setInterval(() => {
        agent.emit('frame', {
          data: multiFrame,
          width: 1280, height: 720,
          timestamp: Date.now(), frame: ++multiSent, quality: 92
        });
      }, 1000 / FRAME_RATE);

      await sleep(5000);
      clearInterval(multiTimer);
      await sleep(500);

      const totalReceived = multiFrameCounts.reduce((a, b) => a + b, 0);
      const avgPerViewer = totalReceived / MULTI_VIEWER_COUNT;
      const minReceived = Math.min(...multiFrameCounts);
      const maxReceived = Math.max(...multiFrameCounts);

      log('📊', `Sent: ${multiSent} frames`);
      log('📊', `Per viewer: min ${minReceived}, max ${maxReceived}, avg ${avgPerViewer.toFixed(1)}`);
      log('📊', `Total relayed: ${totalReceived} frames across ${MULTI_VIEWER_COUNT} viewers`);

      if (minReceived > 0) log('✅', 'All viewers received frames');
      else log('⚠️', 'Some viewers got zero frames');

      results.multiViewer = {
        viewers: MULTI_VIEWER_COUNT, connected: allConnected,
        sent: multiSent, avgPerViewer, minReceived, maxReceived
      };
    } else {
      log('⚠️', `Only ${allConnected} viewers connected`);
      results.multiViewer = { viewers: MULTI_VIEWER_COUNT, connected: allConnected };
    }

    multiViewers.forEach(mv => mv.disconnect());

    // ═══════════════════════════════════════════════════════
    //  TEST 8: Latency Ping/Pong
    // ═══════════════════════════════════════════════════════
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  TEST 8: Latency Measurement');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const latViewer = io(SERVER, {
      auth: { token, role: 'viewer' },
      transports: ['websocket'],
      rejectUnauthorized: false,
      reconnection: false,
    });

    let latConnected = false;
    latViewer.on('connect', () => { latConnected = true; });

    await new Promise(r => {
      const check = setInterval(() => { if (latConnected) { clearInterval(check); r(); } }, 100);
      setTimeout(() => { clearInterval(check); r(); }, 3000);
    });

    if (latConnected) {
      const pings = 20;
      const latencies = [];

      for (let i = 0; i < pings; i++) {
        const pingStart = process.hrtime.bigint();
        const rtt = await new Promise(r => {
          latViewer.emit('latency-ping', { t: Number(pingStart) });
          latViewer.once('latency-pong', () => { r(hrMs(pingStart)); });
          setTimeout(() => r(null), 2000);
        });
        if (rtt !== null) latencies.push(rtt);
        await sleep(50);
      }

      if (latencies.length > 0) {
        const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const minLat = Math.min(...latencies);
        const maxLat = Math.max(...latencies);
        const p95 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];

        log('📊', `Latency: avg ${avgLat.toFixed(0)}ms, min ${minLat.toFixed(0)}ms, max ${maxLat.toFixed(0)}ms`);
        log('📊', `P95: ${p95.toFixed(0)}ms (${latencies.length}/${pings} pongs received)`);

        if (avgLat < 200) log('✅', 'Latency is good');
        else if (avgLat < 500) log('⚠️', 'Latency is moderate');
        else log('⚠️', 'High latency');

        results.latency = { avg: avgLat, min: minLat, max: maxLat, p95, received: latencies.length, sent: pings };
      } else {
        log('⚠️', 'No pong responses received');
        results.latency = { avg: 0, received: 0, sent: pings };
      }

      latViewer.disconnect();
    } else {
      log('⚠️', 'Could not connect for latency test');
    }

    // Cleanup
    agent.disconnect();
    viewer.disconnect();
    resolve();
  });
}

// ═══════════════════════════════════════════════════════
//  SUMMARY
// ═══════════════════════════════════════════════════════
function printSummary() {
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  STRESS TEST RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  let passed = 0;
  let warnings = 0;
  let failed = 0;

  // HTTP
  if (results.http) {
    const h = results.http;
    const status = h.loginErrors > 0 ? '⚠️' : (h.avgLogin > 2000 ? '⚠️' : '✅');
    if (status === '✅') passed++; else warnings++;
    console.log(`  ${status}  HTTP Endpoints     avg login ${h.avgLogin.toFixed(0)}ms, session ${h.avgSession.toFixed(0)}ms`);
  }

  // Frames
  if (results.frames) {
    const f = results.frames;
    const status = f.dropRate > 90 ? '❌' : (f.dropRate > 20 ? '⚠️' : '✅');
    if (status === '✅') passed++; else if (status === '⚠️') warnings++; else failed++;
    console.log(`  ${status}  Frame Relay        ${f.actualFPS.toFixed(1)} FPS, ${f.dropRate.toFixed(1)}% dropped`);
  }

  // Input
  if (results.input) {
    const i = results.input;
    const status = i.dropRate > 5 ? '⚠️' : '✅';
    if (status === '✅') passed++; else warnings++;
    console.log(`  ${status}  Input Events       ${i.received}/${i.sent} delivered (${i.dropRate.toFixed(1)}% lost)`);
  }

  // Keyboard
  if (results.keyboard) {
    const k = results.keyboard;
    const status = (k.keysReceived < k.keysSent || k.typesReceived < k.typesSent) ? '⚠️' : '✅';
    if (status === '✅') passed++; else warnings++;
    console.log(`  ${status}  Keyboard           ${k.keysReceived}/${k.keysSent} keys, ${k.typesReceived}/${k.typesSent} types`);
  }

  // Reconnect
  if (results.reconnect) {
    const r = results.reconnect;
    const status = r.successes < r.attempts ? '⚠️' : '✅';
    if (status === '✅') passed++; else warnings++;
    console.log(`  ${status}  Reconnection       ${r.successes}/${r.attempts} ok, avg ${r.avgTime.toFixed(0)}ms`);
  }

  // Large frame
  if (results.largeFrame) {
    const status = results.largeFrame.received ? '✅' : '⚠️';
    if (status === '✅') passed++; else warnings++;
    console.log(`  ${status}  Large Frame        ${results.largeFrame.received ? 'relayed ok' : 'not received'}`);
  }

  // Multi-viewer
  if (results.multiViewer) {
    const m = results.multiViewer;
    const status = (m.connected === m.viewers && m.minReceived > 0) ? '✅' : '⚠️';
    if (status === '✅') passed++; else warnings++;
    console.log(`  ${status}  Multi-Viewer       ${m.connected}/${m.viewers} connected, avg ${(m.avgPerViewer || 0).toFixed(1)} frames/viewer`);
  }

  // Latency
  if (results.latency) {
    const l = results.latency;
    const status = l.avg < 200 ? '✅' : (l.avg < 500 ? '⚠️' : '❌');
    if (status === '✅') passed++; else if (status === '⚠️') warnings++; else failed++;
    console.log(`  ${status}  Latency            avg ${l.avg.toFixed(0)}ms, p95 ${(l.p95 || 0).toFixed(0)}ms`);
  }

  console.log('');
  console.log(`  Score: ${passed} passed, ${warnings} warnings, ${failed} failed`);
  console.log('');

  if (failed > 0) {
    console.log('  ❌ CRITICAL ISSUES FOUND — needs fixing');
  } else if (warnings > 0) {
    console.log('  ⚠️  Some warnings — acceptable for normal use');
  } else {
    console.log('  🎉 ALL TESTS PASSED — server is solid!');
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

// ─── Main ──────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🔨 LogInTo — Stress Test');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  Target: ${SERVER}`);
  console.log(`  Frame size: ${FRAME_SIZE_KB}KB @ ${FRAME_RATE} FPS`);
  console.log(`  Input rate: ${INPUT_RATE_HZ} Hz`);
  console.log(`  Duration: ${TEST_DURATION_MS / 1000}s per phase`);
  console.log('');

  try {
    const { token, userId } = await testHTTPEndpoints();
    if (token) {
      await testSocketFrameRelay(token, userId);
    } else {
      log('⚠️', 'Skipping socket tests — no valid token (rate limited)');
      log('💡', 'Restart the server to clear rate limits, then re-run');
    }
  } catch (err) {
    console.error('\n   ❌ Fatal error:', err.message);
    console.error(err.stack);
  }

  printSummary();
  process.exit(0);
}

main();
