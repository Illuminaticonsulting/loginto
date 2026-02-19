/**
 * LogInTo — Remote Desktop Viewer v2
 *
 * Pro-grade remote desktop viewer with:
 * - Pinch-to-zoom with smooth pan
 * - Trackpad mode (relative cursor movement)
 * - Direct touch mode (tap = click at that point)
 * - Drag support (long-press + move)
 * - Two-finger scroll with momentum
 * - Adaptive quality based on connection speed
 * - Virtual keyboard with special keys
 * - Desktop mouse/keyboard passthrough
 */
(function() {
  'use strict';

  // ─── Auth ──────────────────────────────────────────────
  const token = localStorage.getItem('loginto_token');
  const userId = localStorage.getItem('loginto_userId');
  if (!token || !userId) { window.location.href = '/'; return; }

  // ─── Constants ─────────────────────────────────────────
  const TAP_THRESHOLD = 12;
  const TAP_TIMEOUT = 300;
  const LONG_PRESS_MS = 400;
  const DOUBLE_TAP_MS = 300;
  const TRACKPAD_SPEED = 1.8;
  const SCROLL_MULTIPLIER = 3;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 8;
  const ZOOM_SENSITIVITY = 0.01;
  const PAN_FRICTION = 0.92;

  // ─── State ─────────────────────────────────────────────
  const S = {
    socket: null,
    connected: false,
    screenInfo: null,
    zoom: 1, panX: 0, panY: 0,
    panVelocityX: 0, panVelocityY: 0,
    animFrame: null,
    cursorX: 960, cursorY: 540,
    mode: localStorage.getItem('loginto_mode') || 'trackpad',
    rightClickMode: false,
    isDragging: false,
    activeModifiers: new Set(),
    touches: {}, touchCount: 0,
    tapStartX: 0, tapStartY: 0, tapStartTime: 0,
    tapMoved: false, lastTapTime: 0,
    longPressTimer: null, longPressFired: false,
    pinchStartDist: 0, pinchStartZoom: 1,
    pinchMidX: 0, pinchMidY: 0, isPinching: false,
    isScrolling: false, scrollLastY: 0, scrollLastX: 0,
    frameCount: 0, fpsCounter: 0, currentFPS: 0,
    lastFrameTime: 0, avgLatency: 50,
    adaptiveQuality: true, currentQuality: 60, currentFPSSetting: 15,
  };

  // ─── DOM ───────────────────────────────────────────────
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  const offlineOverlay = $('#offline-overlay');
  const canvas = $('#remote-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const container = $('#canvas-container');
  const cursorEl = $('#cursor-indicator');
  const statusText = $('#status-text');
  const statusDot = $('.status-dot');
  const fpsDisplay = $('#fps-display');
  const latencyDisplay = $('#latency-display');
  const toolbar = $('#toolbar');
  const toolbarToggle = $('#toolbar-toggle');
  const fullscreenBtn = $('#fullscreen-btn');
  const disconnectBtn = $('#disconnect-btn');
  const qualitySlider = $('#quality-slider');
  const qualityValue = $('#quality-value');
  const fpsSlider = $('#fps-slider');
  const fpsValue = $('#fps-value');
  const keyboardBtn = $('#keyboard-btn');
  const keyboardInput = $('#keyboard-input');
  const specialKeysBtn = $('#special-keys-btn');
  const specialKeys = $('#special-keys');
  const modeToggleBtn = $('#mode-toggle-btn');
  const rightClickModeBtn = $('#right-click-mode-btn');
  const zoomIndicator = $('#zoom-indicator');
  const modeBadge = $('#mode-badge');

  const frameImage = new Image();
  let pendingFrame = null;

  // ─── Session Validation & Connect ──────────────────────
  fetch('/api/session', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => { if (!r.ok) { localStorage.clear(); window.location.href = '/'; } else connectSocket(); })
    .catch(() => connectSocket());

  // ─── Socket ────────────────────────────────────────────
  function connectSocket() {
    S.socket = io({
      auth: { token, role: 'viewer' },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling']
    });

    S.socket.on('connect', () => {
      S.connected = true;
      setStatus('Connected', false);
    });

    S.socket.on('disconnect', () => {
      S.connected = false;
      setStatus('Reconnecting...', true);
    });

    S.socket.on('connect_error', err => {
      if (err.message === 'Authentication required') {
        localStorage.clear();
        window.location.href = '/';
      }
    });

    S.socket.on('kicked', () => {
      alert('Another device connected.');
      window.location.href = '/dashboard.html';
    });

    S.socket.on('agent-status', data => {
      if (data.connected) {
        offlineOverlay.style.display = 'none';
        setStatus('Connected', false);
      } else {
        offlineOverlay.style.display = 'flex';
        setStatus('Machine Offline', true);
      }
    });

    S.socket.on('screen-info', info => {
      S.screenInfo = info;
      canvas.width = info.scaledWidth;
      canvas.height = info.scaledHeight;
      S.cursorX = info.width / 2;
      S.cursorY = info.height / 2;
      resetView();
    });

    S.socket.on('frame', renderFrame);

    // FPS counter + adaptive quality
    setInterval(() => {
      S.currentFPS = S.fpsCounter;
      S.fpsCounter = 0;
      fpsDisplay.textContent = S.currentFPS + ' FPS';

      if (S.adaptiveQuality && S.connected && S.screenInfo) {
        if (S.avgLatency > 200 && S.currentQuality > 25) {
          S.currentQuality = Math.max(25, S.currentQuality - 10);
          S.socket.emit('update-quality', { quality: S.currentQuality });
          qualitySlider.value = S.currentQuality;
          qualityValue.textContent = S.currentQuality + '%';
        } else if (S.avgLatency < 80 && S.currentFPS >= S.currentFPSSetting - 2 && S.currentQuality < 80) {
          S.currentQuality = Math.min(80, S.currentQuality + 5);
          S.socket.emit('update-quality', { quality: S.currentQuality });
          qualitySlider.value = S.currentQuality;
          qualityValue.textContent = S.currentQuality + '%';
        }
      }
    }, 1000);
  }

  // ─── Frame Rendering ──────────────────────────────────
  function renderFrame(frameData) {
    const now = performance.now();
    const latency = now - S.lastFrameTime;
    S.lastFrameTime = now;
    S.fpsCounter++;
    S.frameCount++;
    S.avgLatency = S.avgLatency * 0.9 + latency * 0.1;

    if (S.frameCount % 15 === 0) {
      latencyDisplay.textContent = Math.round(S.avgLatency) + ' ms';
    }

    if (pendingFrame) return;
    pendingFrame = frameData;

    frameImage.onload = () => {
      canvas.width = frameData.width;
      canvas.height = frameData.height;
      ctx.drawImage(frameImage, 0, 0);
      pendingFrame = null;
      updateCanvasTransform();
      updateCursorPosition();
    };
    frameImage.src = 'data:image/jpeg;base64,' + frameData.data;
  }

  function setStatus(text, isError) {
    statusText.textContent = text;
    statusDot.classList.toggle('error', isError);
  }

  // ═══════════════════════════════════════════════════════
  //  ZOOM & PAN
  // ═══════════════════════════════════════════════════════

  function updateCanvasTransform() {
    clampPan();
    canvas.style.transform = 'translate(' + S.panX + 'px,' + S.panY + 'px) scale(' + S.zoom + ')';
    canvas.style.transformOrigin = '0 0';
  }

  function clampPan() {
    const rect = container.getBoundingClientRect();
    const cw = canvas.width * S.zoom;
    const ch = canvas.height * S.zoom;

    if (cw <= rect.width) {
      S.panX = (rect.width - cw) / 2;
    } else {
      S.panX = Math.min(0, Math.max(rect.width - cw, S.panX));
    }
    if (ch <= rect.height) {
      S.panY = (rect.height - ch) / 2;
    } else {
      S.panY = Math.min(0, Math.max(rect.height - ch, S.panY));
    }
  }

  function resetView() {
    S.zoom = 1;
    S.panX = 0;
    S.panY = 0;
    updateCanvasTransform();
    showZoomLevel();
  }

  function setZoom(newZoom, focusX, focusY) {
    const oldZoom = S.zoom;
    S.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    const ratio = S.zoom / oldZoom;
    S.panX = focusX - (focusX - S.panX) * ratio;
    S.panY = focusY - (focusY - S.panY) * ratio;
    updateCanvasTransform();
    showZoomLevel();
  }

  function showZoomLevel() {
    if (!zoomIndicator) return;
    zoomIndicator.textContent = Math.round(S.zoom * 100) + '%';
    zoomIndicator.classList.add('visible');
    clearTimeout(zoomIndicator._t);
    zoomIndicator._t = setTimeout(() => zoomIndicator.classList.remove('visible'), 1200);
  }

  function startMomentum() {
    cancelAnimationFrame(S.animFrame);
    function tick() {
      if (Math.abs(S.panVelocityX) < 0.5 && Math.abs(S.panVelocityY) < 0.5) return;
      S.panX += S.panVelocityX;
      S.panY += S.panVelocityY;
      S.panVelocityX *= PAN_FRICTION;
      S.panVelocityY *= PAN_FRICTION;
      updateCanvasTransform();
      S.animFrame = requestAnimationFrame(tick);
    }
    S.animFrame = requestAnimationFrame(tick);
  }

  // ═══════════════════════════════════════════════════════
  //  COORDINATE MAPPING
  // ═══════════════════════════════════════════════════════

  function clientToRemote(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const canvasX = (clientX - rect.left) / (rect.width / canvas.width);
    const canvasY = (clientY - rect.top) / (rect.height / canvas.height);
    if (!S.screenInfo) return { x: canvasX, y: canvasY };
    return {
      x: Math.round((canvasX / S.screenInfo.scaledWidth) * S.screenInfo.width),
      y: Math.round((canvasY / S.screenInfo.scaledHeight) * S.screenInfo.height)
    };
  }

  function moveCursorBy(dx, dy) {
    if (!S.screenInfo) return;
    S.cursorX = Math.max(0, Math.min(S.screenInfo.width, S.cursorX + dx * TRACKPAD_SPEED));
    S.cursorY = Math.max(0, Math.min(S.screenInfo.height, S.cursorY + dy * TRACKPAD_SPEED));
    S.socket?.emit('mouse-move', { x: Math.round(S.cursorX), y: Math.round(S.cursorY) });
    updateCursorPosition();
  }

  function updateCursorPosition() {
    if (!S.screenInfo || !cursorEl) return;
    const rect = canvas.getBoundingClientRect();
    const sx = (S.cursorX / S.screenInfo.width) * rect.width + rect.left;
    const sy = (S.cursorY / S.screenInfo.height) * rect.height + rect.top;
    const contRect = container.getBoundingClientRect();
    cursorEl.style.left = (sx - contRect.left) + 'px';
    cursorEl.style.top = (sy - contRect.top) + 'px';
    cursorEl.classList.add('visible');
    cursorEl.classList.toggle('trackpad-cursor', S.mode === 'trackpad');
    cursorEl.classList.toggle('dragging', S.isDragging);
  }

  function flashCursor() {
    cursorEl.classList.add('clicking');
    setTimeout(() => cursorEl.classList.remove('clicking'), 200);
  }

  // ═══════════════════════════════════════════════════════
  //  TOUCH HANDLING
  // ═══════════════════════════════════════════════════════

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    cancelAnimationFrame(S.animFrame);

    for (const t of e.changedTouches) {
      S.touches[t.identifier] = { x: t.clientX, y: t.clientY, startX: t.clientX, startY: t.clientY };
    }
    S.touchCount = e.touches.length;

    if (S.touchCount === 1) {
      const t = e.touches[0];
      S.tapStartX = t.clientX;
      S.tapStartY = t.clientY;
      S.tapStartTime = Date.now();
      S.tapMoved = false;
      S.longPressFired = false;

      clearTimeout(S.longPressTimer);
      S.longPressTimer = setTimeout(() => {
        if (!S.tapMoved && S.touchCount === 1) {
          S.longPressFired = true;
          if (navigator.vibrate) navigator.vibrate(30);

          if (S.mode === 'trackpad') {
            S.isDragging = true;
            S.socket?.emit('mouse-down', { x: Math.round(S.cursorX), y: Math.round(S.cursorY), button: 'left' });
            updateCursorPosition();
          } else {
            const coords = clientToRemote(S.tapStartX, S.tapStartY);
            S.socket?.emit('mouse-right-click', coords);
            flashCursor();
          }
        }
      }, LONG_PRESS_MS);

      if (S.mode === 'direct') {
        const coords = clientToRemote(t.clientX, t.clientY);
        S.cursorX = coords.x;
        S.cursorY = coords.y;
        S.socket?.emit('mouse-move', coords);
        updateCursorPosition();
      }
    }

    if (S.touchCount === 2) {
      clearTimeout(S.longPressTimer);
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      S.pinchStartDist = dist;
      S.pinchStartZoom = S.zoom;
      S.pinchMidX = (a.clientX + b.clientX) / 2;
      S.pinchMidY = (a.clientY + b.clientY) / 2;
      S.isPinching = false;
      S.isScrolling = false;
      S.scrollLastX = S.pinchMidX;
      S.scrollLastY = S.pinchMidY;
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    S.touchCount = e.touches.length;

    for (const t of e.changedTouches) {
      if (S.touches[t.identifier]) {
        S.touches[t.identifier].prevX = S.touches[t.identifier].x;
        S.touches[t.identifier].prevY = S.touches[t.identifier].y;
        S.touches[t.identifier].x = t.clientX;
        S.touches[t.identifier].y = t.clientY;
      }
    }

    // Two fingers: pinch or scroll
    if (S.touchCount === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const midX = (a.clientX + b.clientX) / 2;
      const midY = (a.clientY + b.clientY) / 2;
      const distDelta = Math.abs(dist - S.pinchStartDist);

      if (!S.isPinching && !S.isScrolling) {
        if (distDelta > 30) S.isPinching = true;
        else {
          const sd = Math.hypot(midX - S.pinchMidX, midY - S.pinchMidY);
          if (sd > 10) S.isScrolling = true;
        }
      }

      if (S.isPinching) {
        const contRect = container.getBoundingClientRect();
        const focusX = midX - contRect.left;
        const focusY = midY - contRect.top;
        setZoom(S.pinchStartZoom * (dist / S.pinchStartDist), focusX, focusY);
        S.panX += midX - S.pinchMidX;
        S.panY += midY - S.pinchMidY;
        updateCanvasTransform();
        S.pinchMidX = midX;
        S.pinchMidY = midY;
      } else if (S.isScrolling) {
        const dy = S.scrollLastY - midY;
        const dx = S.scrollLastX - midX;
        if (Math.abs(dy) > 2 || Math.abs(dx) > 2) {
          S.socket?.emit('mouse-scroll', {
            x: Math.round(S.cursorX), y: Math.round(S.cursorY),
            deltaX: dx * SCROLL_MULTIPLIER, deltaY: dy * SCROLL_MULTIPLIER
          });
          S.scrollLastX = midX;
          S.scrollLastY = midY;
        }
      }
      return;
    }

    // Single finger
    if (S.touchCount === 1) {
      const t = e.touches[0];
      const dx = t.clientX - S.tapStartX;
      const dy = t.clientY - S.tapStartY;

      if (Math.abs(dx) > TAP_THRESHOLD || Math.abs(dy) > TAP_THRESHOLD) {
        S.tapMoved = true;
        if (!S.longPressFired) clearTimeout(S.longPressTimer);
      }

      if (S.mode === 'trackpad') {
        const td = S.touches[t.identifier];
        if (td && td.prevX !== undefined) {
          const mx = t.clientX - td.prevX;
          const my = t.clientY - td.prevY;

          if (S.isDragging) {
            moveCursorBy(mx, my);
          } else if (S.tapMoved && !S.longPressFired) {
            if (S.zoom > 1.05) {
              S.panX += mx;
              S.panY += my;
              S.panVelocityX = mx;
              S.panVelocityY = my;
              updateCanvasTransform();
            } else {
              moveCursorBy(mx, my);
            }
          }
        }
      } else {
        if (S.tapMoved) {
          const coords = clientToRemote(t.clientX, t.clientY);
          S.cursorX = coords.x;
          S.cursorY = coords.y;
          S.socket?.emit('mouse-move', coords);
          updateCursorPosition();
        }
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    clearTimeout(S.longPressTimer);

    for (const t of e.changedTouches) delete S.touches[t.identifier];
    const prevCount = S.touchCount;
    S.touchCount = e.touches.length;

    if (prevCount === 2 && S.touchCount < 2 && (S.isPinching || S.isScrolling)) {
      S.isPinching = false;
      S.isScrolling = false;
      return;
    }

    if (S.isDragging && S.touchCount === 0) {
      S.isDragging = false;
      S.socket?.emit('mouse-up', { x: Math.round(S.cursorX), y: Math.round(S.cursorY), button: 'left' });
      updateCursorPosition();
      return;
    }

    if (S.zoom > 1.05 && S.mode === 'trackpad' && S.tapMoved && S.touchCount === 0 && !S.longPressFired) {
      startMomentum();
    }

    if (S.touchCount === 0 && !S.longPressFired && prevCount === 1) {
      const duration = Date.now() - S.tapStartTime;

      if (!S.tapMoved && duration < TAP_TIMEOUT) {
        const now = Date.now();
        flashCursor();

        if (now - S.lastTapTime < DOUBLE_TAP_MS) {
          // Double-tap
          if (S.mode === 'trackpad') {
            S.socket?.emit('mouse-double-click', { x: Math.round(S.cursorX), y: Math.round(S.cursorY) });
          } else {
            S.socket?.emit('mouse-double-click', clientToRemote(S.tapStartX, S.tapStartY));
          }
          S.lastTapTime = 0;
        } else {
          // Single tap
          const target = S.rightClickMode
            ? 'mouse-right-click'
            : 'mouse-click';
          if (S.mode === 'trackpad') {
            const payload = { x: Math.round(S.cursorX), y: Math.round(S.cursorY) };
            if (target === 'mouse-click') payload.button = 'left';
            S.socket?.emit(target, payload);
          } else {
            const coords = clientToRemote(S.tapStartX, S.tapStartY);
            if (target === 'mouse-click') coords.button = 'left';
            S.socket?.emit(target, coords);
          }
          S.lastTapTime = now;
        }
      }
    }
  }, { passive: false });

  // ═══════════════════════════════════════════════════════
  //  DESKTOP MOUSE & KEYBOARD
  // ═══════════════════════════════════════════════════════

  canvas.addEventListener('mousemove', e => {
    const coords = clientToRemote(e.clientX, e.clientY);
    S.cursorX = coords.x;
    S.cursorY = coords.y;
    S.socket?.emit('mouse-move', coords);
    updateCursorPosition();
  });

  canvas.addEventListener('mousedown', e => {
    if (e.button === 0) {
      S.socket?.emit('mouse-click', { ...clientToRemote(e.clientX, e.clientY), button: 'left' });
      flashCursor();
    }
  });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    S.socket?.emit('mouse-right-click', clientToRemote(e.clientX, e.clientY));
    flashCursor();
  });

  canvas.addEventListener('dblclick', e => {
    S.socket?.emit('mouse-double-click', clientToRemote(e.clientX, e.clientY));
    flashCursor();
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const contRect = container.getBoundingClientRect();
      setZoom(S.zoom - e.deltaY * ZOOM_SENSITIVITY, e.clientX - contRect.left, e.clientY - contRect.top);
    } else {
      S.socket?.emit('mouse-scroll', { ...clientToRemote(e.clientX, e.clientY), deltaX: e.deltaX, deltaY: e.deltaY });
    }
  }, { passive: false });

  document.addEventListener('keydown', e => {
    if (e.target === keyboardInput) return;
    if ((e.ctrlKey || e.metaKey) && ['r','t','w','l','n'].includes(e.key.toLowerCase())) return;
    e.preventDefault();
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.altKey) mods.push('alt');
    if (e.shiftKey) mods.push('shift');
    if (e.metaKey) mods.push('meta');
    if (e.key.length === 1 && mods.length === 0) {
      S.socket?.emit('key-type', { text: e.key });
    } else {
      S.socket?.emit('key-press', { key: e.key, modifiers: mods });
    }
  });

  // ═══════════════════════════════════════════════════════
  //  VIRTUAL KEYBOARD
  // ═══════════════════════════════════════════════════════

  keyboardBtn.addEventListener('click', () => {
    keyboardInput.focus();
    keyboardInput.click();
  });

  keyboardInput.addEventListener('input', e => {
    const text = e.target.value;
    if (text) {
      if (S.activeModifiers.size > 0) {
        S.socket?.emit('key-press', { key: text, modifiers: Array.from(S.activeModifiers) });
        clearModifiers();
      } else {
        S.socket?.emit('key-type', { text });
      }
      keyboardInput.value = '';
    }
  });

  keyboardInput.addEventListener('keydown', e => {
    const specials = ['Enter','Backspace','Tab','Escape','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'];
    if (specials.includes(e.key)) {
      e.preventDefault();
      const mods = [];
      if (e.ctrlKey) mods.push('ctrl');
      if (e.altKey) mods.push('alt');
      if (e.shiftKey) mods.push('shift');
      if (e.metaKey) mods.push('meta');
      S.socket?.emit('key-press', { key: e.key, modifiers: [...mods, ...Array.from(S.activeModifiers)] });
      if (S.activeModifiers.size > 0) clearModifiers();
    }
  });

  // Special keys panel
  specialKeysBtn.addEventListener('click', () => {
    specialKeys.classList.toggle('hidden');
    specialKeysBtn.classList.toggle('active');
  });

  $$('.skey[data-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.socket?.emit('key-press', { key: btn.dataset.key, modifiers: Array.from(S.activeModifiers) });
      if (S.activeModifiers.size > 0) clearModifiers();
      btn.classList.add('pressed');
      setTimeout(() => btn.classList.remove('pressed'), 150);
    });
  });

  $$('.skey.mod').forEach(btn => {
    btn.addEventListener('click', () => {
      const mod = btn.dataset.mod;
      if (S.activeModifiers.has(mod)) {
        S.activeModifiers.delete(mod);
        btn.classList.remove('active');
      } else {
        S.activeModifiers.add(mod);
        btn.classList.add('active');
      }
    });
  });

  $$('.skey.combo').forEach(btn => {
    btn.addEventListener('click', () => {
      const parts = btn.dataset.combo.split('+');
      const key = parts.pop();
      const modifiers = [...parts];
      if (/Mac|iPod|iPhone|iPad/.test(navigator.userAgent)) {
        const idx = modifiers.indexOf('ctrl');
        if (idx !== -1) modifiers[idx] = 'meta';
      }
      S.socket?.emit('key-press', { key, modifiers });
      btn.classList.add('pressed');
      setTimeout(() => btn.classList.remove('pressed'), 150);
    });
  });

  function clearModifiers() {
    S.activeModifiers.clear();
    $$('.skey.mod').forEach(b => b.classList.remove('active'));
  }

  // ═══════════════════════════════════════════════════════
  //  TOOLBAR CONTROLS
  // ═══════════════════════════════════════════════════════

  function updateModeBadge() {
    if (modeBadge) modeBadge.textContent = S.mode === 'trackpad' ? 'Trackpad' : 'Direct';
    if (modeToggleBtn) {
      modeToggleBtn.textContent = S.mode === 'trackpad' ? '🖱️ Trackpad' : '👆 Direct';
      modeToggleBtn.classList.toggle('active', S.mode === 'direct');
    }
  }

  if (modeToggleBtn) {
    modeToggleBtn.addEventListener('click', () => {
      S.mode = S.mode === 'trackpad' ? 'direct' : 'trackpad';
      localStorage.setItem('loginto_mode', S.mode);
      updateModeBadge();
    });
  }
  updateModeBadge();

  rightClickModeBtn.addEventListener('click', () => {
    S.rightClickMode = !S.rightClickMode;
    rightClickModeBtn.classList.toggle('active', S.rightClickMode);
  });

  toolbarToggle.addEventListener('click', () => {
    toolbar.classList.toggle('hidden');
    if (!toolbar.classList.contains('hidden')) {
      specialKeys.classList.add('hidden');
      specialKeysBtn.classList.remove('active');
    }
  });

  canvas.addEventListener('touchstart', () => {
    if (!toolbar.classList.contains('hidden')) toolbar.classList.add('hidden');
  }, { passive: true });

  qualitySlider.addEventListener('input', () => { qualityValue.textContent = qualitySlider.value + '%'; });
  qualitySlider.addEventListener('change', () => {
    S.currentQuality = parseInt(qualitySlider.value);
    S.adaptiveQuality = false;
    S.socket?.emit('update-quality', { quality: S.currentQuality });
  });
  fpsSlider.addEventListener('input', () => { fpsValue.textContent = fpsSlider.value; });
  fpsSlider.addEventListener('change', () => {
    S.currentFPSSetting = parseInt(fpsSlider.value);
    S.socket?.emit('update-fps', { fps: S.currentFPSSetting });
  });

  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)?.call(document.documentElement);
      document.body.classList.add('fullscreen');
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      document.body.classList.remove('fullscreen');
    }
  });

  // Double-tap status bar to reset zoom
  let statusBarTapTime = 0;
  const statusBar = $('#status-bar');
  if (statusBar) {
    statusBar.addEventListener('click', () => {
      const now = Date.now();
      if (now - statusBarTapTime < 400) {
        resetView();
        statusBarTapTime = 0;
      } else {
        statusBarTapTime = now;
      }
    });
  }

  disconnectBtn.addEventListener('click', () => {
    if (confirm('Disconnect from desktop?')) {
      S.socket?.disconnect();
      window.location.href = '/dashboard.html';
    }
  });

  // Prevent native gestures
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());
  document.body.addEventListener('touchmove', e => {
    if (e.target === canvas || container.contains(e.target)) return;
    e.preventDefault();
  }, { passive: false });

})();
