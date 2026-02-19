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

  // Frame double-buffer
  const img = new Image();
  let framePending = false;

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
  window.addEventListener('resize', () => { if (S.screenInfo) computeFit(); });

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
      S.zoom = 1;
      computeFit();
      S.socket.emit('update-quality', { quality: S.currentQuality });
      S.socket.emit('update-fps', { fps: S.currentFPSSetting });
    });

    S.socket.on('frame', onFrame);

    setInterval(() => {
      S.currentFPS = S.fpsCounter; S.fpsCounter = 0;
      fpsEl.textContent = S.currentFPS + ' FPS';
    }, 1000);
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

    if (S.fpsCounter % 10 === 0) latEl.textContent = Math.round(S.avgInterval) + 'ms';

    if (framePending) return;        // drop frame if previous still decoding
    framePending = true;

    img.onload = () => {
      if (canvas.width !== data.width || canvas.height !== data.height) {
        canvas.width = data.width;
        canvas.height = data.height;
        computeFit();
      }
      ctx.drawImage(img, 0, 0);
      framePending = false;
      applyTransform();
    };
    img.onerror = () => { framePending = false; };
    img.src = 'data:image/jpeg;base64,' + data.data;
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
    applyTransform();
  }

  function totalScale() { return S.baseScale * S.zoom; }

  function applyTransform() {
    const ts = totalScale();
    clampPan(ts);
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = 'translate(' + S.panX + 'px,' + S.panY + 'px) scale(' + ts + ')';
    updateCursor();
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
    applyTransform();
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
    // We cache this per-frame via getBoundingClientRect on the
    // container (not the canvas, which has transforms that confuse).
    const r = box.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  function clientToRemote(cx, cy) {
    const off = containerOffset();
    const ts = totalScale();
    const px = (cx - off.x - S.panX) / ts;
    const py = (cy - off.y - S.panY) / ts;
    if (!S.screenInfo) return { x: Math.round(px), y: Math.round(py) };
    return {
      x: Math.round(Math.max(0, Math.min(S.screenInfo.width,  px / canvas.width  * S.screenInfo.width))),
      y: Math.round(Math.max(0, Math.min(S.screenInfo.height, py / canvas.height * S.screenInfo.height)))
    };
  }

  // ───────────────────────────────────────────────────────
  //  CURSOR POSITION (display + emit)
  // ───────────────────────────────────────────────────────

  function updateCursor() {
    if (!S.screenInfo || !cursor) return;
    const ts = totalScale();
    const x = S.cursorX / S.screenInfo.width  * canvas.width  * ts + S.panX;
    const y = S.cursorY / S.screenInfo.height * canvas.height * ts + S.panY;
    cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    cursor.style.display = 'block';
    cursor.classList.toggle('dragging', S.isDragging);
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
    S.cursorX = Math.max(0, Math.min(S.screenInfo.width,  S.cursorX + dx * TRACKPAD_SPEED));
    S.cursorY = Math.max(0, Math.min(S.screenInfo.height, S.cursorY + dy * TRACKPAD_SPEED));
    emitMove();
    autoPan();
    applyTransform();
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
    const cx = S.cursorX / S.screenInfo.width  * canvas.width  * ts + S.panX;
    const cy = S.cursorY / S.screenInfo.height * canvas.height * ts + S.panY;

    const mx = bw * EDGE_MARGIN;
    const my = bh * EDGE_MARGIN;

    if (cx < mx)       S.panX += (mx - cx);
    if (cx > bw - mx)  S.panX -= (cx - (bw - mx));
    if (cy < my)       S.panY += (my - cy);
    if (cy > bh - my)  S.panY -= (cy - (bh - my));
  }

  // ───────────────────────────────────────────────────────
  //  PANEL MANAGEMENT
  // ───────────────────────────────────────────────────────

  function openPanel(name) {
    closeAllPanels();
    S.panelOpen = name;
    backdrop.classList.add('visible');
    if (name === 'toolbar') toolbar.classList.remove('hidden');
    if (name === 'keys')    keysPanel.classList.remove('hidden');
  }

  function closeAllPanels() {
    S.panelOpen = null;
    backdrop.classList.remove('visible');
    toolbar.classList.add('hidden');
    keysPanel.classList.add('hidden');
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
        applyTransform();
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

  canvas.addEventListener('mousemove', e => {
    const c = clientToRemote(e.clientX, e.clientY);
    S.cursorX = c.x; S.cursorY = c.y;
    emitMove(); updateCursor();
  });

  canvas.addEventListener('mousedown', e => {
    if (e.button === 0) {
      S.socket?.emit('mouse-click', { ...clientToRemote(e.clientX, e.clientY), button: 'left' });
      flashCursorClick();
    }
  });

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

  // Prevent iOS pinch-zoom on the page itself
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());

})();
