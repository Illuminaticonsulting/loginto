/**
 * LogInTo — Remote Desktop Viewer v4
 *
 * What LogMeIn does right (and we now replicate):
 *  1. Full-resolution frames with 4:4:4 chroma (no color blur on text)
 *  2. Math-based coordinate mapping (not relying on getBoundingClientRect + transforms)
 *  3. Auto-pan when zoomed: cursor movement auto-scrolls the viewport
 *  4. Smooth pinch-to-zoom centered on fingers
 *  5. No CSS transitions on anything interactive (zero lag)
 *  6. Canvas rendered with explicit transform (no max-width/max-height CSS)
 */
(function () {
  'use strict';

  const token = localStorage.getItem('loginto_token');
  const userId = localStorage.getItem('loginto_userId');
  if (!token || !userId) { window.location.href = '/'; return; }

  // ─── Constants ──────────────────────────────────────────
  const TRACKPAD_SPEED = 1.8;
  const SCROLL_SPEED = 3;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 8;
  const MOVE_THROTTLE_MS = 16;  // ~60 Hz mouse-move emit rate
  const EDGE_MARGIN = 0.12;     // 12% of viewport as auto-pan zone
  const PAN_LERP = 0.35;        // auto-pan smoothing factor (0=frozen, 1=instant)
  const TOUCH_SMOOTH = 0.6;     // touch delta EMA smoothing (0=raw, 1=max smooth)

  // ─── State ──────────────────────────────────────────────
  const S = {
    socket: null, connected: false,
    screenInfo: null,

    // Rendering
    baseScale: 1,    // scale factor to fit canvas in container
    zoom: 1,         // user zoom (1 = fit-to-screen)
    panX: 0, panY: 0,

    // Remote cursor (in screen-native coordinates)
    cursorX: 0, cursorY: 0,

    // Mode
    mode: localStorage.getItem('loginto_mode') || 'trackpad',
    rightClickMode: false,
    isDragging: false,
    activeModifiers: new Set(),

    // Touch tracking
    touchStartX: 0, touchStartY: 0,
    touchStartTime: 0, touchMoved: false,
    lastTapTime: 0,
    longPressTimer: null, longPressFired: false,
    prevTouchX: 0, prevTouchY: 0,

    // Two-finger
    pinchStartDist: 0, pinchStartZoom: 1,
    pinchMidX: 0, pinchMidY: 0,
    twoFingerAction: null,
    scrollAccX: 0, scrollAccY: 0,

    // Performance
    fpsCounter: 0, currentFPS: 0,
    lastFrameTime: 0, avgInterval: 50,
    lastMoveEmit: 0,
    currentQuality: 92, currentFPSSetting: 20,

    // Panels
    panelOpen: null,
  };

  // ─── DOM ────────────────────────────────────────────────
  const $ = sel => document.querySelector(sel);
  const $$ = sel => document.querySelectorAll(sel);

  const canvas   = $('#remote-canvas');
  const ctx      = canvas.getContext('2d', { alpha: false });
  const box      = $('#canvas-container');
  const cursor   = $('#cursor-indicator');
  const overlay  = $('#offline-overlay');
  const statText = $('#status-text');
  const statDot  = $('.status-dot');
  const fpsEl    = $('#fps-display');
  const latEl    = $('#latency-display');
  const zoomEl   = $('#zoom-indicator');
  const modeBdg  = $('#mode-badge');
  const backdrop = $('#panel-backdrop');
  const toolbar  = $('#toolbar');
  const keysPanel = $('#special-keys');
  const qualSlider = $('#quality-slider');
  const qualVal   = $('#quality-value');
  const fpsSlider = $('#fps-slider');
  const fpsVal    = $('#fps-value');
  const kbInput   = $('#keyboard-input');
  const displaysPanel = $('#displays-panel');
  const displaysList  = $('#displays-list');
  const clipboardPanel = $('#clipboard-panel');
  const clipboardText  = $('#clipboard-text');

  // Frame rendering pipeline
  const img = new Image();
  let framePending = false;
  let pendingFrameData = null;       // queues the LATEST frame while one is decoding
  let rafId = null;
  let transformDirty = false;

  // Cached container rect (avoid per-event getBoundingClientRect)
  let cachedBoxRect = { x: 0, y: 0 };
  function updateBoxRect() {
    const r = box.getBoundingClientRect();
    cachedBoxRect = { x: r.left, y: r.top };
  }
  window.addEventListener('resize', updateBoxRect);
  window.addEventListener('scroll', updateBoxRect, true);
  setTimeout(updateBoxRect, 0);

  // Touch smoothing state (EMA)
  let smoothDX = 0, smoothDY = 0;

  // Auto-pan target (for lerp smoothing)
  let panTargetX = 0, panTargetY = 0;
  let autoPanActive = false;

  // ───────────────────────────────────────────────────────
  //  INIT
  // ───────────────────────────────────────────────────────

  qualSlider.value = S.currentQuality;
  qualVal.textContent = S.currentQuality + '%';
  fpsSlider.value = S.currentFPSSetting;
  fpsVal.textContent = S.currentFPSSetting;

  fetch('/api/session', { headers: { Authorization: 'Bearer ' + token } })
    .then(r => { if (!r.ok) { localStorage.clear(); window.location.href = '/'; } else initSocket(); })
    .catch(() => initSocket());

  // Recompute fit on resize
  window.addEventListener('resize', () => { if (S.screenInfo) computeFit(); updateBoxRect(); });

  // ───────────────────────────────────────────────────────
  //  SOCKET
  // ───────────────────────────────────────────────────────

  function initSocket() {
    S.socket = io({
      auth: { token, role: 'viewer' },
      reconnection: true, reconnectionDelay: 1000,
      reconnectionDelayMax: 5000, reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling'],
    });

    S.socket.on('connect', () => {
      S.connected = true; setStatus('Connected', false); updateBoxRect();
      if (S._wasDisconnected) { showToast('Reconnected'); S._wasDisconnected = false; }
    });
    S.socket.on('disconnect', () => {
      S.connected = false; S._wasDisconnected = true;
      setStatus('Reconnecting…', true); showToast('Connection lost — reconnecting…', true);
    });
    S.socket.on('connect_error', err => {
      if (err.message === 'Authentication required') { localStorage.clear(); window.location.href = '/'; }
    });
    S.socket.on('kicked', () => { alert('Another device connected.'); window.location.href = '/dashboard.html'; });

    S.socket.on('agent-status', d => {
      if (d.connected) { overlay.style.display = 'none'; setStatus('Connected', false); }
      else { overlay.style.display = 'flex'; setStatus('Machine Offline', true); }
    });

    S.socket.on('screen-info', info => {
      S.screenInfo = info;
      canvas.width = info.scaledWidth;
      canvas.height = info.scaledHeight;
      S.cursorX = (info.inputWidth || info.width) / 2;
      // Show cursor immediately at center
      setTimeout(() => updateCursor(), 100);
      S.cursorY = (info.inputHeight || info.height) / 2;
      S.zoom = 1;
      computeFit();
      S.socket.emit('update-quality', { quality: S.currentQuality });
      S.socket.emit('update-fps', { fps: S.currentFPSSetting });
    });

    S.socket.on('frame', onFrame);

    // Latency measurement — real roundtrip ping/pong
    S.socket.on('latency-pong', (data) => {
      if (data && data.t) {
        const rtt = performance.now() - data.t;
        latEl.textContent = Math.round(rtt) + 'ms';
      }
    });

    // Multi-monitor: receive display list from agent
    S.socket.on('displays-list', displays => {
      renderDisplays(displays);
    });

    // Clipboard: receive remote clipboard content
    S.socket.on('clipboard-content', data => {
      if (clipboardText) clipboardText.value = data.text || '';
      // Also copy to local clipboard if possible
      if (navigator.clipboard && data.text) {
        navigator.clipboard.writeText(data.text).catch(() => {});
      }
    });

    setInterval(() => {
      S.currentFPS = S.fpsCounter; S.fpsCounter = 0;
      fpsEl.textContent = S.currentFPS + ' FPS';
    }, 1000);

    // Latency ping every 2 seconds
    setInterval(() => {
      if (S.socket && S.connected) S.socket.emit('latency-ping', { t: performance.now() });
    }, 2000);
  }

  function setStatus(t, err) {
    statText.textContent = t;
    statDot.classList.toggle('error', err);
  }

  // ───────────────────────────────────────────────────────
  //  FRAME RENDERING
  // ───────────────────────────────────────────────────────

  function onFrame(data) {
    const now = performance.now();
    S.avgInterval = S.avgInterval * 0.9 + (now - S.lastFrameTime) * 0.1;
    S.lastFrameTime = now;
    S.fpsCounter++;

    // Update quality slider to show adaptive quality from agent
    if (data.quality && Math.abs(data.quality - S.currentQuality) > 1) {
      S.currentQuality = data.quality;
      qualSlider.value = data.quality;
      qualVal.textContent = data.quality + '%';
    }

    // Queue latest frame — if one is already decoding, keep the newest
    if (framePending) {
      pendingFrameData = data;
      return;
    }

    decodeAndRender(data);
  }

  function decodeAndRender(data) {
    framePending = true;

    // Prefer createImageBitmap for off-thread decode (huge mobile perf win)
    if (typeof createImageBitmap === 'function' && (data.data instanceof ArrayBuffer || data.data instanceof Uint8Array)) {
      const blob = new Blob([data.data], { type: 'image/jpeg' });
      createImageBitmap(blob).then(bmp => {
        paintFrame(bmp, data.width, data.height);
        bmp.close();
        finishFrame();
      }).catch(() => { finishFrame(); });
      return;
    }

    // Fallback: Blob URL for binary, base64 data URL for legacy
    let blobUrl;
    if (data.data instanceof ArrayBuffer || data.data instanceof Uint8Array) {
      const blob = new Blob([data.data], { type: 'image/jpeg' });
      blobUrl = URL.createObjectURL(blob);
    }

    img.onload = () => {
      paintFrame(img, data.width, data.height);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      finishFrame();
    };
    img.onerror = () => { if (blobUrl) URL.revokeObjectURL(blobUrl); finishFrame(); };
    img.src = blobUrl || ('data:image/jpeg;base64,' + data.data);
  }

  function paintFrame(source, w, h) {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      computeFit();
    }
    ctx.drawImage(source, 0, 0);
    scheduleTransform();
  }

  function finishFrame() {
    framePending = false;
    // If a newer frame was queued while we were decoding, render it now
    if (pendingFrameData) {
      const next = pendingFrameData;
      pendingFrameData = null;
      decodeAndRender(next);
    }
  }

  // ───────────────────────────────────────────────────────
  //  TRANSFORM ENGINE
  //  Canvas uses position:absolute + transform only.
  //  No CSS max-width/max-height (which fights transforms).
  // ───────────────────────────────────────────────────────

  function computeFit() {
    const bw = box.clientWidth, bh = box.clientHeight;
    const cw = canvas.width, ch = canvas.height;
    if (!cw || !ch) return;
    S.baseScale = Math.min(bw / cw, bh / ch);
    S.panX = 0; S.panY = 0;
    panTargetX = 0; panTargetY = 0;
    autoPanActive = false;
    applyTransformImmediate();
  }

  function totalScale() { return S.baseScale * S.zoom; }

  // Batch all transform updates into a single rAF (prevents layout thrashing)
  function scheduleTransform() {
    if (!transformDirty) {
      transformDirty = true;
      rafId = requestAnimationFrame(flushTransform);
    }
  }

  function flushTransform() {
    transformDirty = false;

    // Smooth auto-pan lerp
    if (autoPanActive) {
      S.panX += (panTargetX - S.panX) * PAN_LERP;
      S.panY += (panTargetY - S.panY) * PAN_LERP;
      // Keep animating until close enough
      if (Math.abs(panTargetX - S.panX) > 0.5 || Math.abs(panTargetY - S.panY) > 0.5) {
        scheduleTransform();
      } else {
        S.panX = panTargetX;
        S.panY = panTargetY;
        autoPanActive = false;
      }
    }

    applyTransformImmediate();
  }

  function applyTransformImmediate() {
    const ts = totalScale();
    clampPan(ts);
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = 'translate3d(' + S.panX + 'px,' + S.panY + 'px,0) scale(' + ts + ')';
    updateCursor();
  }

  // Legacy: direct apply (used by zoom/pinch where we need instant response)
  function applyTransform() {
    scheduleTransform();
  }

  function clampPan(ts) {
    const bw = box.clientWidth, bh = box.clientHeight;
    const vw = canvas.width * ts, vh = canvas.height * ts;
    S.panX = vw <= bw ? (bw - vw) / 2 : Math.min(0, Math.max(bw - vw, S.panX));
    S.panY = vh <= bh ? (bh - vh) / 2 : Math.min(0, Math.max(bh - vh, S.panY));
  }

  function zoomTo(newZ, focusX, focusY) {
    // focusX/Y are in container coordinates
    const old = totalScale();
    S.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZ));
    const nts = totalScale();
    const ratio = nts / old;
    S.panX = focusX - (focusX - S.panX) * ratio;
    S.panY = focusY - (focusY - S.panY) * ratio;
    applyTransformImmediate();  // instant for zoom (no rAF delay)
    flashZoom();
  }

  function resetView() { S.zoom = 1; computeFit(); flashZoom(); }

  function flashZoom() {
    if (!zoomEl) return;
    zoomEl.textContent = Math.round(S.zoom * 100) + '%';
    zoomEl.classList.add('visible');
    clearTimeout(zoomEl._t);
    zoomEl._t = setTimeout(() => zoomEl.classList.remove('visible'), 800);
  }

  // ───────────────────────────────────────────────────────
  //  COORDINATE MAPPING (math-based, no getBoundingClientRect)
  //
  //  The canvas is drawn at position (panX, panY) inside the
  //  container, scaled by totalScale(). So:
  //    canvasPixelX = (screenX - containerLeft - panX) / totalScale
  //    remoteX = canvasPixelX / canvas.width * screenInfo.width
  // ───────────────────────────────────────────────────────

  function containerOffset() {
    return cachedBoxRect;
  }

  function clientToRemote(cx, cy) {
    const off = containerOffset();
    const ts = totalScale();
    const px = (cx - off.x - S.panX) / ts;
    const py = (cy - off.y - S.panY) / ts;
    if (!S.screenInfo) return { x: Math.round(px), y: Math.round(py) };
    // Map to INPUT coordinates (logical/robotjs), not capture coordinates
    const iw = S.screenInfo.inputWidth || S.screenInfo.width;
    const ih = S.screenInfo.inputHeight || S.screenInfo.height;
    return {
      x: Math.round(Math.max(0, Math.min(iw, px / canvas.width  * iw))),
      y: Math.round(Math.max(0, Math.min(ih, py / canvas.height * ih)))
    };
  }

  // ───────────────────────────────────────────────────────
  //  CURSOR POSITION (display + emit)
  // ───────────────────────────────────────────────────────

  function updateCursor() {
    if (!S.screenInfo || !cursor) return;
    const ts = totalScale();
    const iw = S.screenInfo.inputWidth || S.screenInfo.width;
    const ih = S.screenInfo.inputHeight || S.screenInfo.height;
    const x = S.cursorX / iw * canvas.width  * ts + S.panX;
    const y = S.cursorY / ih * canvas.height * ts + S.panY;
    cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    showCursor();
    cursor.classList.toggle('dragging', S.isDragging);
  }

  function showCursor() {
    if (cursor && cursor.style.display !== 'block') cursor.style.display = 'block';
  }

  function flashCursorClick() {
    cursor.classList.add('clicking');
    setTimeout(() => cursor.classList.remove('clicking'), 200);
  }

  function emitMove() {
    const now = performance.now();
    if (now - S.lastMoveEmit < MOVE_THROTTLE_MS) return;
    S.lastMoveEmit = now;
    S.socket?.emit('mouse-move', { x: Math.round(S.cursorX), y: Math.round(S.cursorY) });
  }

  function moveCursorDelta(dx, dy) {
    if (!S.screenInfo) return;
    // EMA smoothing on touch deltas — reduces jitter on mobile
    smoothDX = smoothDX * TOUCH_SMOOTH + dx * (1 - TOUCH_SMOOTH);
    smoothDY = smoothDY * TOUCH_SMOOTH + dy * (1 - TOUCH_SMOOTH);
    const iw = S.screenInfo.inputWidth || S.screenInfo.width;
    const ih = S.screenInfo.inputHeight || S.screenInfo.height;
    S.cursorX = Math.max(0, Math.min(iw, S.cursorX + smoothDX * TRACKPAD_SPEED));
    S.cursorY = Math.max(0, Math.min(ih, S.cursorY + smoothDY * TRACKPAD_SPEED));
    emitMove();
    autoPan();
    scheduleTransform();
  }

  // ───────────────────────────────────────────────────────
  //  AUTO-PAN (when zoomed, view follows cursor)
  //
  //  Like LogMeIn: as cursor approaches viewport edge, the
  //  view scrolls to keep cursor in a safe center zone.
  // ───────────────────────────────────────────────────────

  function autoPan() {
    if (S.zoom <= 1.01) return;
    const bw = box.clientWidth, bh = box.clientHeight;
    const ts = totalScale();

    // Cursor position in container pixel coordinates
    const iw = S.screenInfo.inputWidth || S.screenInfo.width;
    const ih = S.screenInfo.inputHeight || S.screenInfo.height;
    const cx = S.cursorX / iw * canvas.width  * ts + S.panX;
    const cy = S.cursorY / ih * canvas.height * ts + S.panY;

    const mx = bw * EDGE_MARGIN;
    const my = bh * EDGE_MARGIN;

    // Compute target pan with smooth lerp instead of instant snap
    let tx = S.panX, ty = S.panY;
    if (cx < mx)       tx += (mx - cx);
    if (cx > bw - mx)  tx -= (cx - (bw - mx));
    if (cy < my)       ty += (my - cy);
    if (cy > bh - my)  ty -= (cy - (bh - my));

    if (tx !== S.panX || ty !== S.panY) {
      panTargetX = tx;
      panTargetY = ty;
      autoPanActive = true;
      scheduleTransform();
    }
  }

  // ───────────────────────────────────────────────────────
  //  PANEL MANAGEMENT
  // ───────────────────────────────────────────────────────

  function openPanel(name) {
    closeAllPanels();
    S.panelOpen = name;
    backdrop.classList.add('visible');
    if (name === 'toolbar')   toolbar.classList.remove('hidden');
    if (name === 'keys')      keysPanel.classList.remove('hidden');
    if (name === 'displays')  displaysPanel.classList.remove('hidden');
    if (name === 'clipboard') clipboardPanel.classList.remove('hidden');
  }

  function closeAllPanels() {
    S.panelOpen = null;
    backdrop.classList.remove('visible');
    toolbar.classList.add('hidden');
    keysPanel.classList.add('hidden');
    displaysPanel.classList.add('hidden');
    clipboardPanel.classList.add('hidden');
  }

  backdrop.addEventListener('click', closeAllPanels);
  backdrop.addEventListener('touchstart', e => { e.preventDefault(); closeAllPanels(); }, { passive: false });

  // ───────────────────────────────────────────────────────
  //  TOUCH INPUT (mobile)
  // ───────────────────────────────────────────────────────

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches;

    if (S.panelOpen) { closeAllPanels(); return; }

    if (t.length === 1) {
      const p = t[0];
      S.touchStartX = S.prevTouchX = p.clientX;
      S.touchStartY = S.prevTouchY = p.clientY;
      S.touchStartTime = Date.now();
      S.touchMoved = false;
      S.longPressFired = false;

      clearTimeout(S.longPressTimer);
      S.longPressTimer = setTimeout(() => {
        if (!S.touchMoved) {
          S.longPressFired = true;
          if (navigator.vibrate) navigator.vibrate(25);
          if (S.mode === 'trackpad') {
            S.isDragging = true;
            S.socket?.emit('mouse-down', { x: Math.round(S.cursorX), y: Math.round(S.cursorY), button: 'left' });
            updateCursor();
          } else {
            S.socket?.emit('mouse-right-click', clientToRemote(p.clientX, p.clientY));
            flashCursorClick();
          }
        }
      }, 400);

      if (S.mode === 'direct') {
        const c = clientToRemote(p.clientX, p.clientY);
        S.cursorX = c.x; S.cursorY = c.y;
        emitMove(); updateCursor();
      }
    }

    if (t.length === 2) {
      clearTimeout(S.longPressTimer);
      const d = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      S.pinchStartDist = d;
      S.pinchStartZoom = S.zoom;
      S.pinchMidX = (t[0].clientX + t[1].clientX) / 2;
      S.pinchMidY = (t[0].clientY + t[1].clientY) / 2;
      S.scrollAccX = 0; S.scrollAccY = 0;
      S.twoFingerAction = null;
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches;

    // ── Two fingers ──
    if (t.length === 2) {
      const d = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      const mx = (t[0].clientX + t[1].clientX) / 2;
      const my = (t[0].clientY + t[1].clientY) / 2;

      if (!S.twoFingerAction) {
        if (Math.abs(d - S.pinchStartDist) > 20) S.twoFingerAction = 'pinch';
        else if (Math.hypot(mx - S.pinchMidX, my - S.pinchMidY) > 10) S.twoFingerAction = 'scroll';
      }

      if (S.twoFingerAction === 'pinch') {
        const off = containerOffset();
        zoomTo(S.pinchStartZoom * (d / S.pinchStartDist), mx - off.x, my - off.y);
        // Also pan to follow midpoint
        S.panX += (mx - S.pinchMidX);
        S.panY += (my - S.pinchMidY);
        applyTransformImmediate();  // instant for pinch (no rAF delay)
        S.pinchMidX = mx; S.pinchMidY = my;
      } else if (S.twoFingerAction === 'scroll') {
        S.scrollAccX += (S.pinchMidX - mx) * SCROLL_SPEED;
        S.scrollAccY += (S.pinchMidY - my) * SCROLL_SPEED;
        if (Math.abs(S.scrollAccX) > 2 || Math.abs(S.scrollAccY) > 2) {
          S.socket?.emit('mouse-scroll', {
            x: Math.round(S.cursorX), y: Math.round(S.cursorY),
            deltaX: S.scrollAccX, deltaY: S.scrollAccY
          });
          S.scrollAccX = 0; S.scrollAccY = 0;
        }
        S.pinchMidX = mx; S.pinchMidY = my;
      }
      return;
    }

    // ── Single finger ──
    if (t.length === 1) {
      const p = t[0];
      const dx = p.clientX - S.touchStartX;
      const dy = p.clientY - S.touchStartY;
      const mx = p.clientX - S.prevTouchX;
      const my = p.clientY - S.prevTouchY;
      S.prevTouchX = p.clientX;
      S.prevTouchY = p.clientY;

      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        S.touchMoved = true;
        if (!S.longPressFired) clearTimeout(S.longPressTimer);
      }

      if (S.mode === 'trackpad') {
        // ALWAYS move cursor in trackpad mode (even when zoomed)
        // Auto-pan handles keeping cursor visible
        if (S.isDragging || S.touchMoved) {
          moveCursorDelta(mx, my);
        }
      } else {
        // Direct mode: cursor follows finger
        if (S.touchMoved || S.longPressFired) {
          const c = clientToRemote(p.clientX, p.clientY);
          S.cursorX = c.x; S.cursorY = c.y;
          emitMove(); updateCursor();
        }
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    clearTimeout(S.longPressTimer);
    const prev = e.touches.length + e.changedTouches.length;
    const now  = e.touches.length;

    if (prev >= 2 && now < 2 && S.twoFingerAction) {
      S.twoFingerAction = null;
      // If zooming ended below 1, snap back
      if (S.zoom < 1) resetView();
      return;
    }

    if (S.isDragging && now === 0) {
      S.isDragging = false;
      S.socket?.emit('mouse-up', { x: Math.round(S.cursorX), y: Math.round(S.cursorY), button: 'left' });
      updateCursor();
      return;
    }

    // Tap
    if (now === 0 && !S.longPressFired && prev === 1) {
      const dur = Date.now() - S.touchStartTime;
      if (!S.touchMoved && dur < 300) {
        flashCursorClick();
        const ts = Date.now();

        if (ts - S.lastTapTime < 300) {
          // Double-tap
          const pos = S.mode === 'trackpad'
            ? { x: Math.round(S.cursorX), y: Math.round(S.cursorY) }
            : clientToRemote(S.touchStartX, S.touchStartY);
          S.socket?.emit('mouse-double-click', pos);
          S.lastTapTime = 0;
        } else {
          // Single tap
          const evt = S.rightClickMode ? 'mouse-right-click' : 'mouse-click';
          const pos = S.mode === 'trackpad'
            ? { x: Math.round(S.cursorX), y: Math.round(S.cursorY) }
            : clientToRemote(S.touchStartX, S.touchStartY);
          if (evt === 'mouse-click') pos.button = 'left';
          S.socket?.emit(evt, pos);
          S.lastTapTime = ts;
        }
      }
    }
  }, { passive: false });

  // ───────────────────────────────────────────────────────
  //  DESKTOP MOUSE + KEYBOARD
  // ───────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────
  //  POINTER EVENTS (unified: mouse, touch-on-desktop, Vision Pro gaze+pinch)
  //  Falls back to mouse events for older browsers.
  // ───────────────────────────────────────────────────────

  const hasPointerEvents = 'PointerEvent' in window;
  let desktopDragging = false;
  let desktopDragMoved = false;

  if (hasPointerEvents) {
    // Pointer events cover mouse, pen, and Vision Pro gaze+pinch
    canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return; // handled by touchmove
      const c = clientToRemote(e.clientX, e.clientY);
      S.cursorX = c.x; S.cursorY = c.y;
      if (desktopDragging) desktopDragMoved = true;
      emitMove(); updateCursor();
    });

    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return; // handled by touchstart
      if (e.button === 0) {
        desktopDragging = true;
        desktopDragMoved = false;
        canvas.setPointerCapture(e.pointerId);
        const c = clientToRemote(e.clientX, e.clientY);
        S.cursorX = c.x; S.cursorY = c.y;
        S.socket?.emit('mouse-down', { x: c.x, y: c.y, button: 'left' });
        updateCursor();
      }
    });

    canvas.addEventListener('pointerup', e => {
      if (e.pointerType === 'touch') return;
      if (!desktopDragging) return;
      desktopDragging = false;
      const c = clientToRemote(e.clientX, e.clientY);
      S.socket?.emit('mouse-up', { x: c.x, y: c.y, button: 'left' });
      if (!desktopDragMoved) {
        S.socket?.emit('mouse-click', { x: c.x, y: c.y, button: 'left' });
        flashCursorClick();
      }
    });

    canvas.addEventListener('pointercancel', () => {
      if (desktopDragging) {
        desktopDragging = false;
        S.socket?.emit('mouse-up', { x: Math.round(S.cursorX), y: Math.round(S.cursorY), button: 'left' });
      }
    });
  } else {
    // Fallback: plain mouse events
    canvas.addEventListener('mousemove', e => {
      const c = clientToRemote(e.clientX, e.clientY);
      S.cursorX = c.x; S.cursorY = c.y;
      emitMove(); updateCursor();
    });

    canvas.addEventListener('mousedown', e => {
      if (e.button === 0) {
        desktopDragging = true;
        desktopDragMoved = false;
        const c = clientToRemote(e.clientX, e.clientY);
        S.cursorX = c.x; S.cursorY = c.y;
        S.socket?.emit('mouse-down', { x: c.x, y: c.y, button: 'left' });
        updateCursor();
      }
    });

    document.addEventListener('mousemove', e => {
      if (!desktopDragging) return;
      desktopDragMoved = true;
      const c = clientToRemote(e.clientX, e.clientY);
      S.cursorX = c.x; S.cursorY = c.y;
      emitMove(); updateCursor();
    });

    document.addEventListener('mouseup', e => {
      if (!desktopDragging) return;
      desktopDragging = false;
      const c = clientToRemote(e.clientX, e.clientY);
      S.socket?.emit('mouse-up', { x: c.x, y: c.y, button: 'left' });
      if (!desktopDragMoved) {
        S.socket?.emit('mouse-click', { x: c.x, y: c.y, button: 'left' });
        flashCursorClick();
      }
    });
  }

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    S.socket?.emit('mouse-right-click', clientToRemote(e.clientX, e.clientY));
    flashCursorClick();
  });

  canvas.addEventListener('dblclick', e => {
    S.socket?.emit('mouse-double-click', clientToRemote(e.clientX, e.clientY));
    flashCursorClick();
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const off = containerOffset();
      zoomTo(S.zoom * (1 - e.deltaY * 0.003), e.clientX - off.x, e.clientY - off.y);
    } else {
      S.socket?.emit('mouse-scroll', {
        ...clientToRemote(e.clientX, e.clientY),
        deltaX: e.deltaX, deltaY: e.deltaY
      });
    }
  }, { passive: false });

  document.addEventListener('keydown', e => {
    if (e.target === kbInput) return;
    if ((e.ctrlKey || e.metaKey) && ['r','t','w','l','n'].includes(e.key.toLowerCase())) return;
    e.preventDefault();
    const m = [];
    if (e.ctrlKey) m.push('ctrl');
    if (e.altKey) m.push('alt');
    if (e.shiftKey) m.push('shift');
    if (e.metaKey) m.push('meta');
    if (e.key.length === 1 && m.length === 0) S.socket?.emit('key-type', { text: e.key });
    else S.socket?.emit('key-press', { key: e.key, modifiers: m });
  });

  // ───────────────────────────────────────────────────────
  //  VIRTUAL KEYBOARD
  // ───────────────────────────────────────────────────────

  kbInput.addEventListener('input', () => {
    const t = kbInput.value;
    if (t) {
      if (S.activeModifiers.size > 0) {
        S.socket?.emit('key-press', { key: t, modifiers: [...S.activeModifiers] });
        clearMods();
      } else {
        S.socket?.emit('key-type', { text: t });
      }
      kbInput.value = '';
    }
  });

  kbInput.addEventListener('keydown', e => {
    const special = ['Enter','Backspace','Tab','Escape','Delete',
      'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'];
    if (special.includes(e.key)) {
      e.preventDefault();
      const m = [];
      if (e.ctrlKey) m.push('ctrl');
      if (e.altKey) m.push('alt');
      if (e.shiftKey) m.push('shift');
      if (e.metaKey) m.push('meta');
      S.socket?.emit('key-press', { key: e.key, modifiers: [...m, ...S.activeModifiers] });
      if (S.activeModifiers.size > 0) clearMods();
    }
  });

  // Special keys panel
  $$('.skey[data-key]').forEach(b => b.addEventListener('click', () => {
    S.socket?.emit('key-press', { key: b.dataset.key, modifiers: [...S.activeModifiers] });
    if (S.activeModifiers.size > 0) clearMods();
    b.classList.add('pressed'); setTimeout(() => b.classList.remove('pressed'), 150);
  }));

  $$('.skey.mod').forEach(b => b.addEventListener('click', () => {
    const m = b.dataset.mod;
    if (S.activeModifiers.has(m)) { S.activeModifiers.delete(m); b.classList.remove('active'); }
    else { S.activeModifiers.add(m); b.classList.add('active'); }
  }));

  $$('.skey.combo').forEach(b => b.addEventListener('click', () => {
    const parts = b.dataset.combo.split('+');
    const key = parts.pop();
    const mods = [...parts];
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) {
      const i = mods.indexOf('ctrl'); if (i !== -1) mods[i] = 'meta';
    }
    S.socket?.emit('key-press', { key, modifiers: mods });
    b.classList.add('pressed'); setTimeout(() => b.classList.remove('pressed'), 150);
  }));

  function clearMods() {
    S.activeModifiers.clear();
    $$('.skey.mod').forEach(b => b.classList.remove('active'));
  }

  // ───────────────────────────────────────────────────────
  //  ACTION BAR
  // ───────────────────────────────────────────────────────

  function updateModeUI() {
    if (modeBdg) modeBdg.textContent = S.mode === 'trackpad' ? 'Trackpad' : 'Direct';
    const btn = $('#btn-mode');
    if (btn) {
      const lbl = btn.querySelector('.action-label');
      if (lbl) lbl.textContent = S.mode === 'trackpad' ? 'Trackpad' : 'Direct';
    }
  }
  updateModeUI();

  on('btn-mode', () => {
    S.mode = S.mode === 'trackpad' ? 'direct' : 'trackpad';
    localStorage.setItem('loginto_mode', S.mode);
    updateModeUI();
  });

  on('btn-keyboard', () => { closeAllPanels(); kbInput.focus(); kbInput.click(); });

  on('btn-screens', () => {
    if (S.panelOpen === 'displays') { closeAllPanels(); return; }
    S.socket?.emit('list-screens');
    openPanel('displays');
  });

  on('btn-keys', () => {
    if (S.panelOpen === 'keys') closeAllPanels(); else openPanel('keys');
  });

  on('btn-settings', () => {
    if (S.panelOpen === 'toolbar') closeAllPanels(); else openPanel('toolbar');
  });

  on('btn-rclick', () => {
    S.rightClickMode = !S.rightClickMode;
    const b = $('#btn-rclick');
    if (b) b.classList.toggle('active', S.rightClickMode);
  });

  on('btn-clipboard', () => {
    if (S.panelOpen === 'clipboard') { closeAllPanels(); return; }
    openPanel('clipboard');
  });

  on('clipboard-send', () => {
    const text = clipboardText?.value;
    if (text) {
      S.socket?.emit('clipboard-write', { text });
      clipboardText.value = '';
      closeAllPanels();
    }
  });

  on('clipboard-fetch', () => {
    S.socket?.emit('clipboard-read');
  });

  on('btn-fullscreen', () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)?.call(document.documentElement);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  });

  on('btn-disconnect', () => {
    if (confirm('Disconnect?')) { S.socket?.disconnect(); window.location.href = '/dashboard.html'; }
  });

  // Double-tap status bar to reset zoom
  let stTap = 0;
  const stBar = $('#status-bar');
  if (stBar) stBar.addEventListener('click', () => {
    const n = Date.now();
    if (n - stTap < 400) { resetView(); stTap = 0; } else stTap = n;
  });

  // Toolbar sliders
  qualSlider.addEventListener('input', () => { qualVal.textContent = qualSlider.value + '%'; });
  qualSlider.addEventListener('change', () => {
    S.currentQuality = +qualSlider.value;
    S.socket?.emit('update-quality', { quality: S.currentQuality });
  });
  fpsSlider.addEventListener('input', () => { fpsVal.textContent = fpsSlider.value; });
  fpsSlider.addEventListener('change', () => {
    S.currentFPSSetting = +fpsSlider.value;
    S.socket?.emit('update-fps', { fps: S.currentFPSSetting });
  });

  $$('.panel-close').forEach(b => b.addEventListener('click', closeAllPanels));

  // Helpers
  function on(id, fn) { const el = $('#' + id); if (el) el.addEventListener('click', fn); }

  // ───────────────────────────────────────────────────────
  //  MULTI-MONITOR DISPLAY PICKER
  // ───────────────────────────────────────────────────────

  function renderDisplays(displays) {
    if (!displaysList) return;
    if (!displays || displays.length === 0) {
      displaysList.innerHTML = '<p class="text-muted text-sm">No displays detected</p>';
      return;
    }
    displaysList.innerHTML = '';
    displays.forEach((d, i) => {
      const btn = document.createElement('button');
      btn.className = 'display-btn' + (d.active ? ' active' : '');
      btn.innerHTML =
        '<span class="display-icon">' + (d.active ? '🟢' : '🖥️') + '</span>' +
        '<span class="display-name">' + (d.name || ('Display ' + (i + 1))) + '</span>';
      btn.addEventListener('click', () => {
        if (d.active) { closeAllPanels(); return; }
        // Show switching state
        displaysList.querySelectorAll('.display-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        btn.querySelector('.display-icon').textContent = '⏳';
        S.socket?.emit('switch-screen', { displayId: d.id });
        setTimeout(closeAllPanels, 600);
      });
      displaysList.appendChild(btn);
    });
  }

  // ───────────────────────────────────────────────────────
  //  TOAST NOTIFICATIONS
  // ───────────────────────────────────────────────────────
  let toastEl = null;
  let toastTimer = null;

  function showToast(msg, persistent) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'viewer-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    if (!persistent) {
      toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2500);
    }
  }

  // Prevent iOS pinch-zoom on the page itself
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());

  // ───────────────────────────────────────────────────────
  //  WAKE LOCK — prevent screen from dimming during viewing
  // ───────────────────────────────────────────────────────
  let wakeLock = null;

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* user denied or not supported */ }
  }

  // Acquire on connect, re-acquire when tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.connected) requestWakeLock();
  });

  // Initial request after first frame
  const origOnFrame = onFrame;
  let wakeLockRequested = false;
  // Patch onFrame to request wake lock once
  const _origDecodeAndRender = decodeAndRender;

  // Request wake lock when we first connect
  const _origSetStatus = setStatus;
  function setStatusWithWake(t, err) {
    _origSetStatus(t, err);
    if (!err && !wakeLockRequested) { wakeLockRequested = true; requestWakeLock(); }
  }
  // Can't easily override — just request on first frame arrival
  if (S.connected) requestWakeLock();
  // Also request after socket connects
  setTimeout(() => { if (S.connected) requestWakeLock(); }, 2000);

  // ───────────────────────────────────────────────────────
  //  VISIBILITY API — pause streaming when tab is hidden
  // ───────────────────────────────────────────────────────
  document.addEventListener('visibilitychange', () => {
    if (!S.socket || !S.connected) return;
    if (document.visibilityState === 'hidden') {
      S.socket.emit('update-fps', { fps: 1 });   // drop to 1 FPS when hidden
    } else {
      S.socket.emit('update-fps', { fps: S.currentFPSSetting }); // restore
      requestWakeLock();
    }
  });

})();
