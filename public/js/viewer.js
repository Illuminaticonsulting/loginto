/**
 * LogInTo — Remote Desktop Viewer v3
 *
 * Complete rewrite focusing on:
 * - Responsive panels that never get stuck
 * - Smooth, lag-free cursor in both trackpad & direct mode
 * - High quality streaming with smart adaptive
 * - Clean bottom action bar for mobile
 * - Pinch-to-zoom + pan when zoomed
 * - Proper drag support
 */
(function() {
  'use strict';

  const token = localStorage.getItem('loginto_token');
  const userId = localStorage.getItem('loginto_userId');
  if (!token || !userId) { window.location.href = '/'; return; }

  // ─── Config ────────────────────────────────────────────
  const TRACKPAD_SPEED = 2.2;
  const SCROLL_SPEED = 4;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 6;

  // ─── State ─────────────────────────────────────────────
  const S = {
    socket: null, connected: false, screenInfo: null,
    // Zoom/Pan
    zoom: 1, panX: 0, panY: 0,
    // Remote cursor position
    cursorX: 960, cursorY: 540,
    // Mode
    mode: localStorage.getItem('loginto_mode') || 'trackpad',
    rightClickMode: false, isDragging: false,
    activeModifiers: new Set(),
    // Touch state
    touchStartX: 0, touchStartY: 0, touchStartTime: 0,
    touchMoved: false, lastTapTime: 0,
    longPressTimer: null, longPressFired: false,
    prevTouchX: 0, prevTouchY: 0,
    // Two-finger
    pinchStartDist: 0, pinchStartZoom: 1,
    pinchMidX: 0, pinchMidY: 0,
    twoFingerAction: null, // 'pinch' | 'scroll' | null
    scrollLastX: 0, scrollLastY: 0,
    // Performance
    frameCount: 0, fpsCounter: 0, currentFPS: 0,
    lastFrameTime: 0, avgInterval: 66,
    currentQuality: 80, currentFPSSetting: 20,
    // Panels
    panelOpen: null, // 'toolbar' | 'keys' | null
  };

  // ─── DOM ───────────────────────────────────────────────
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  const canvas = $('#remote-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const container = $('#canvas-container');
  const cursorEl = $('#cursor-indicator');
  const overlay = $('#offline-overlay');
  const statusText = $('#status-text');
  const statusDot = $('.status-dot');
  const fpsDisplay = $('#fps-display');
  const latencyDisplay = $('#latency-display');
  const zoomIndicator = $('#zoom-indicator');
  const modeBadge = $('#mode-badge');
  const backdrop = $('#panel-backdrop');

  // Toolbar
  const toolbar = $('#toolbar');
  const qualitySlider = $('#quality-slider');
  const qualityValue = $('#quality-value');
  const fpsSlider = $('#fps-slider');
  const fpsValue = $('#fps-value');

  // Keys panel
  const specialKeys = $('#special-keys');

  // Action bar buttons
  const keyboardInput = $('#keyboard-input');

  const frameImg = new Image();
  let framePending = false;

  // ═══════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════

  // Set quality/fps slider defaults
  qualitySlider.value = S.currentQuality;
  qualityValue.textContent = S.currentQuality + '%';
  fpsSlider.value = S.currentFPSSetting;
  fpsValue.textContent = S.currentFPSSetting;

  fetch('/api/session', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => { if (!r.ok) { localStorage.clear(); window.location.href = '/'; } else initSocket(); })
    .catch(() => initSocket());

  // ═══════════════════════════════════════════════════════
  //  SOCKET
  // ═══════════════════════════════════════════════════════

  function initSocket() {
    S.socket = io({
      auth: { token, role: 'viewer' },
      reconnection: true, reconnectionDelay: 1000,
      reconnectionDelayMax: 5000, reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling']
    });

    S.socket.on('connect', () => { S.connected = true; setStatus('Connected', false); });
    S.socket.on('disconnect', () => { S.connected = false; setStatus('Reconnecting…', true); });
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
      S.cursorX = info.width / 2;
      S.cursorY = info.height / 2;
      resetView();
      // Request higher quality on connect
      S.socket.emit('update-quality', { quality: S.currentQuality });
      S.socket.emit('update-fps', { fps: S.currentFPSSetting });
    });

    S.socket.on('frame', renderFrame);

    // FPS counter
    setInterval(() => {
      S.currentFPS = S.fpsCounter;
      S.fpsCounter = 0;
      fpsDisplay.textContent = S.currentFPS + ' FPS';
    }, 1000);
  }

  // ═══════════════════════════════════════════════════════
  //  FRAME RENDERING
  // ═══════════════════════════════════════════════════════

  function renderFrame(data) {
    const now = performance.now();
    S.avgInterval = S.avgInterval * 0.9 + (now - S.lastFrameTime) * 0.1;
    S.lastFrameTime = now;
    S.fpsCounter++;
    S.frameCount++;

    if (S.frameCount % 20 === 0) {
      latencyDisplay.textContent = Math.round(S.avgInterval) + 'ms';
    }

    // Drop frame if previous still loading
    if (framePending) return;
    framePending = true;

    frameImg.onload = () => {
      if (canvas.width !== data.width || canvas.height !== data.height) {
        canvas.width = data.width;
        canvas.height = data.height;
      }
      ctx.drawImage(frameImg, 0, 0);
      framePending = false;
      applyTransform();
    };
    frameImg.src = 'data:image/jpeg;base64,' + data.data;
  }

  function setStatus(t, err) {
    statusText.textContent = t;
    statusDot.classList.toggle('error', err);
  }

  // ═══════════════════════════════════════════════════════
  //  ZOOM & PAN
  // ═══════════════════════════════════════════════════════

  function applyTransform() {
    clampPan();
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = `translate(${S.panX}px,${S.panY}px) scale(${S.zoom})`;
    updateCursorEl();
  }

  function clampPan() {
    const r = container.getBoundingClientRect();
    const cw = canvas.width * S.zoom, ch = canvas.height * S.zoom;
    S.panX = cw <= r.width ? (r.width - cw) / 2 : Math.min(0, Math.max(r.width - cw, S.panX));
    S.panY = ch <= r.height ? (r.height - ch) / 2 : Math.min(0, Math.max(r.height - ch, S.panY));
  }

  function resetView() { S.zoom = 1; S.panX = 0; S.panY = 0; applyTransform(); showZoom(); }

  function zoomTo(newZ, fx, fy) {
    const old = S.zoom;
    S.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZ));
    const r = S.zoom / old;
    S.panX = fx - (fx - S.panX) * r;
    S.panY = fy - (fy - S.panY) * r;
    applyTransform();
    showZoom();
  }

  function showZoom() {
    if (!zoomIndicator) return;
    zoomIndicator.textContent = Math.round(S.zoom * 100) + '%';
    zoomIndicator.classList.add('visible');
    clearTimeout(zoomIndicator._t);
    zoomIndicator._t = setTimeout(() => zoomIndicator.classList.remove('visible'), 1000);
  }

  // ═══════════════════════════════════════════════════════
  //  COORDINATE MAPPING
  // ═══════════════════════════════════════════════════════

  function clientToRemote(cx, cy) {
    const r = canvas.getBoundingClientRect();
    const rx = (cx - r.left) / r.width * canvas.width;
    const ry = (cy - r.top) / r.height * canvas.height;
    if (!S.screenInfo) return { x: rx, y: ry };
    return {
      x: Math.round(rx / S.screenInfo.scaledWidth * S.screenInfo.width),
      y: Math.round(ry / S.screenInfo.scaledHeight * S.screenInfo.height)
    };
  }

  function moveCursorDelta(dx, dy) {
    if (!S.screenInfo) return;
    S.cursorX = Math.max(0, Math.min(S.screenInfo.width, S.cursorX + dx * TRACKPAD_SPEED));
    S.cursorY = Math.max(0, Math.min(S.screenInfo.height, S.cursorY + dy * TRACKPAD_SPEED));
    emitMove();
    updateCursorEl();
  }

  function emitMove() {
    S.socket?.emit('mouse-move', { x: Math.round(S.cursorX), y: Math.round(S.cursorY) });
  }

  function updateCursorEl() {
    if (!S.screenInfo || !cursorEl) return;
    const r = canvas.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    const x = S.cursorX / S.screenInfo.width * r.width + r.left - cr.left;
    const y = S.cursorY / S.screenInfo.height * r.height + r.top - cr.top;
    cursorEl.style.transform = `translate(${x}px, ${y}px)`;
    cursorEl.classList.add('visible');
    cursorEl.classList.toggle('dragging', S.isDragging);
  }

  function flashCursor() {
    cursorEl.classList.add('clicking');
    setTimeout(() => cursorEl.classList.remove('clicking'), 200);
  }

  // ═══════════════════════════════════════════════════════
  //  PANEL MANAGEMENT (never get stuck)
  // ═══════════════════════════════════════════════════════

  function openPanel(name) {
    closeAllPanels();
    S.panelOpen = name;
    backdrop.classList.add('visible');
    if (name === 'toolbar') toolbar.classList.remove('hidden');
    if (name === 'keys') specialKeys.classList.remove('hidden');
  }

  function closeAllPanels() {
    S.panelOpen = null;
    backdrop.classList.remove('visible');
    toolbar.classList.add('hidden');
    specialKeys.classList.add('hidden');
  }

  // Tapping backdrop closes everything
  backdrop.addEventListener('click', closeAllPanels);
  backdrop.addEventListener('touchstart', e => { e.preventDefault(); closeAllPanels(); }, { passive: false });

  // ═══════════════════════════════════════════════════════
  //  TOUCH INPUT
  // ═══════════════════════════════════════════════════════

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches;

    // Close panels on canvas touch
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
            // Start drag
            S.isDragging = true;
            S.socket?.emit('mouse-down', { x: Math.round(S.cursorX), y: Math.round(S.cursorY), button: 'left' });
            updateCursorEl();
          } else {
            // Right click in direct mode
            S.socket?.emit('mouse-right-click', clientToRemote(p.clientX, p.clientY));
            flashCursor();
          }
        }
      }, 400);

      if (S.mode === 'direct') {
        const c = clientToRemote(p.clientX, p.clientY);
        S.cursorX = c.x; S.cursorY = c.y;
        emitMove();
        updateCursorEl();
      }
    }

    if (t.length === 2) {
      clearTimeout(S.longPressTimer);
      const d = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      S.pinchStartDist = d;
      S.pinchStartZoom = S.zoom;
      S.pinchMidX = (t[0].clientX + t[1].clientX) / 2;
      S.pinchMidY = (t[0].clientY + t[1].clientY) / 2;
      S.scrollLastX = S.pinchMidX;
      S.scrollLastY = S.pinchMidY;
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
        if (Math.abs(d - S.pinchStartDist) > 25) S.twoFingerAction = 'pinch';
        else if (Math.hypot(mx - S.pinchMidX, my - S.pinchMidY) > 8) S.twoFingerAction = 'scroll';
      }

      if (S.twoFingerAction === 'pinch') {
        const cr = container.getBoundingClientRect();
        zoomTo(S.pinchStartZoom * (d / S.pinchStartDist), mx - cr.left, my - cr.top);
        S.panX += mx - S.pinchMidX;
        S.panY += my - S.pinchMidY;
        applyTransform();
        S.pinchMidX = mx; S.pinchMidY = my;
      } else if (S.twoFingerAction === 'scroll') {
        const dy = S.scrollLastY - my;
        const dx = S.scrollLastX - mx;
        if (Math.abs(dy) > 1 || Math.abs(dx) > 1) {
          S.socket?.emit('mouse-scroll', {
            x: Math.round(S.cursorX), y: Math.round(S.cursorY),
            deltaX: dx * SCROLL_SPEED, deltaY: dy * SCROLL_SPEED
          });
          S.scrollLastX = mx; S.scrollLastY = my;
        }
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

      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        S.touchMoved = true;
        if (!S.longPressFired) clearTimeout(S.longPressTimer);
      }

      if (S.mode === 'trackpad') {
        if (S.isDragging) {
          // Dragging: move cursor while button held
          moveCursorDelta(mx, my);
        } else if (S.touchMoved) {
          if (S.zoom > 1.02) {
            // Pan the zoomed view
            S.panX += mx; S.panY += my;
            applyTransform();
          } else {
            // Move remote cursor
            moveCursorDelta(mx, my);
          }
        }
      } else {
        // Direct mode: cursor follows finger
        if (S.touchMoved || S.longPressFired) {
          const c = clientToRemote(p.clientX, p.clientY);
          S.cursorX = c.x; S.cursorY = c.y;
          emitMove();
          updateCursorEl();
        }
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    clearTimeout(S.longPressTimer);
    const prevCount = e.touches.length + e.changedTouches.length;
    const nowCount = e.touches.length;

    // End two-finger gesture
    if (prevCount >= 2 && nowCount < 2 && S.twoFingerAction) {
      S.twoFingerAction = null;
      return;
    }

    // End drag
    if (S.isDragging && nowCount === 0) {
      S.isDragging = false;
      S.socket?.emit('mouse-up', { x: Math.round(S.cursorX), y: Math.round(S.cursorY), button: 'left' });
      updateCursorEl();
      return;
    }

    // Tap detection
    if (nowCount === 0 && !S.longPressFired && prevCount === 1) {
      const dur = Date.now() - S.touchStartTime;
      if (!S.touchMoved && dur < 300) {
        const now = Date.now();
        flashCursor();

        // Double-tap
        if (now - S.lastTapTime < 300) {
          const pos = S.mode === 'trackpad'
            ? { x: Math.round(S.cursorX), y: Math.round(S.cursorY) }
            : clientToRemote(S.touchStartX, S.touchStartY);
          S.socket?.emit('mouse-double-click', pos);
          S.lastTapTime = 0;
        } else {
          // Single tap → click
          const evt = S.rightClickMode ? 'mouse-right-click' : 'mouse-click';
          const pos = S.mode === 'trackpad'
            ? { x: Math.round(S.cursorX), y: Math.round(S.cursorY) }
            : clientToRemote(S.touchStartX, S.touchStartY);
          if (evt === 'mouse-click') pos.button = 'left';
          S.socket?.emit(evt, pos);
          S.lastTapTime = now;
        }
      }
    }
  }, { passive: false });

  // ═══════════════════════════════════════════════════════
  //  DESKTOP MOUSE & KEYBOARD
  // ═══════════════════════════════════════════════════════

  canvas.addEventListener('mousemove', e => {
    const c = clientToRemote(e.clientX, e.clientY);
    S.cursorX = c.x; S.cursorY = c.y;
    emitMove(); updateCursorEl();
  });
  canvas.addEventListener('mousedown', e => {
    if (e.button === 0) { S.socket?.emit('mouse-click', { ...clientToRemote(e.clientX, e.clientY), button: 'left' }); flashCursor(); }
  });
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    S.socket?.emit('mouse-right-click', clientToRemote(e.clientX, e.clientY)); flashCursor();
  });
  canvas.addEventListener('dblclick', e => {
    S.socket?.emit('mouse-double-click', clientToRemote(e.clientX, e.clientY)); flashCursor();
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const cr = container.getBoundingClientRect();
      zoomTo(S.zoom - e.deltaY * 0.01, e.clientX - cr.left, e.clientY - cr.top);
    } else {
      S.socket?.emit('mouse-scroll', { ...clientToRemote(e.clientX, e.clientY), deltaX: e.deltaX, deltaY: e.deltaY });
    }
  }, { passive: false });

  document.addEventListener('keydown', e => {
    if (e.target === keyboardInput) return;
    if ((e.ctrlKey || e.metaKey) && ['r','t','w','l','n'].includes(e.key.toLowerCase())) return;
    e.preventDefault();
    const m = [];
    if (e.ctrlKey) m.push('ctrl'); if (e.altKey) m.push('alt');
    if (e.shiftKey) m.push('shift'); if (e.metaKey) m.push('meta');
    if (e.key.length === 1 && m.length === 0) S.socket?.emit('key-type', { text: e.key });
    else S.socket?.emit('key-press', { key: e.key, modifiers: m });
  });

  // ═══════════════════════════════════════════════════════
  //  VIRTUAL KEYBOARD
  // ═══════════════════════════════════════════════════════

  keyboardInput.addEventListener('input', e => {
    const t = e.target.value;
    if (t) {
      if (S.activeModifiers.size > 0) {
        S.socket?.emit('key-press', { key: t, modifiers: Array.from(S.activeModifiers) });
        clearMods();
      } else {
        S.socket?.emit('key-type', { text: t });
      }
      keyboardInput.value = '';
    }
  });

  keyboardInput.addEventListener('keydown', e => {
    const sp = ['Enter','Backspace','Tab','Escape','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'];
    if (sp.includes(e.key)) {
      e.preventDefault();
      const m = [];
      if (e.ctrlKey) m.push('ctrl'); if (e.altKey) m.push('alt');
      if (e.shiftKey) m.push('shift'); if (e.metaKey) m.push('meta');
      S.socket?.emit('key-press', { key: e.key, modifiers: [...m, ...Array.from(S.activeModifiers)] });
      if (S.activeModifiers.size > 0) clearMods();
    }
  });

  // ── Special keys ──
  $$('.skey[data-key]').forEach(b => {
    b.addEventListener('click', () => {
      S.socket?.emit('key-press', { key: b.dataset.key, modifiers: Array.from(S.activeModifiers) });
      if (S.activeModifiers.size > 0) clearMods();
      b.classList.add('pressed'); setTimeout(() => b.classList.remove('pressed'), 150);
    });
  });
  $$('.skey.mod').forEach(b => {
    b.addEventListener('click', () => {
      const m = b.dataset.mod;
      if (S.activeModifiers.has(m)) { S.activeModifiers.delete(m); b.classList.remove('active'); }
      else { S.activeModifiers.add(m); b.classList.add('active'); }
    });
  });
  $$('.skey.combo').forEach(b => {
    b.addEventListener('click', () => {
      const parts = b.dataset.combo.split('+');
      const key = parts.pop();
      const mods = [...parts];
      if (/Mac|iPhone|iPad/.test(navigator.userAgent)) {
        const i = mods.indexOf('ctrl'); if (i !== -1) mods[i] = 'meta';
      }
      S.socket?.emit('key-press', { key, modifiers: mods });
      b.classList.add('pressed'); setTimeout(() => b.classList.remove('pressed'), 150);
    });
  });
  function clearMods() { S.activeModifiers.clear(); $$('.skey.mod').forEach(b => b.classList.remove('active')); }

  // ═══════════════════════════════════════════════════════
  //  ACTION BAR BUTTONS
  // ═══════════════════════════════════════════════════════

  function updateModeUI() {
    const btn = $('#btn-mode');
    if (modeBadge) modeBadge.textContent = S.mode === 'trackpad' ? 'Trackpad' : 'Direct';
    if (btn) btn.querySelector('.action-label').textContent = S.mode === 'trackpad' ? 'Trackpad' : 'Direct';
  }
  updateModeUI();

  // Mode toggle
  on('btn-mode', () => {
    S.mode = S.mode === 'trackpad' ? 'direct' : 'trackpad';
    localStorage.setItem('loginto_mode', S.mode);
    updateModeUI();
  });

  // Keyboard
  on('btn-keyboard', () => {
    closeAllPanels();
    keyboardInput.focus();
    keyboardInput.click();
  });

  // Special Keys
  on('btn-keys', () => {
    if (S.panelOpen === 'keys') closeAllPanels();
    else openPanel('keys');
  });

  // Settings (toolbar)
  on('btn-settings', () => {
    if (S.panelOpen === 'toolbar') closeAllPanels();
    else openPanel('toolbar');
  });

  // Right-click toggle
  on('btn-rclick', () => {
    S.rightClickMode = !S.rightClickMode;
    const btn = $('#btn-rclick');
    if (btn) btn.classList.toggle('active', S.rightClickMode);
  });

  // Fullscreen
  on('btn-fullscreen', () => {
    if (!document.fullscreenElement) {
      (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)?.call(document.documentElement);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  });

  // Reset zoom (double-tap status bar)
  let stTap = 0;
  const stBar = $('#status-bar');
  if (stBar) stBar.addEventListener('click', () => {
    const n = Date.now();
    if (n - stTap < 400) { resetView(); stTap = 0; } else stTap = n;
  });

  // Disconnect
  on('btn-disconnect', () => {
    if (confirm('Disconnect?')) { S.socket?.disconnect(); window.location.href = '/dashboard.html'; }
  });

  // Toolbar sliders
  qualitySlider.addEventListener('input', () => { qualityValue.textContent = qualitySlider.value + '%'; });
  qualitySlider.addEventListener('change', () => {
    S.currentQuality = parseInt(qualitySlider.value);
    S.socket?.emit('update-quality', { quality: S.currentQuality });
  });
  fpsSlider.addEventListener('input', () => { fpsValue.textContent = fpsSlider.value; });
  fpsSlider.addEventListener('change', () => {
    S.currentFPSSetting = parseInt(fpsSlider.value);
    S.socket?.emit('update-fps', { fps: S.currentFPSSetting });
  });

  // Close button on panels
  $$('.panel-close').forEach(b => b.addEventListener('click', closeAllPanels));

  // Helper
  function on(id, fn) { const el = $('#' + id); if (el) el.addEventListener('click', fn); }

  // Prevent iOS gestures
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());

})();
