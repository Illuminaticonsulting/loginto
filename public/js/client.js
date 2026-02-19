/**
 * LogInTo — Mobile Web Client
 *
 * Handles:
 * - Login/authentication
 * - Socket.IO connection to desktop server
 * - Rendering screen frames on canvas
 * - Touch → mouse input mapping
 * - Virtual keyboard
 * - Special keys and shortcuts
 */

(function() {
  'use strict';

  // ─── State ─────────────────────────────────────────────
  const state = {
    token: null,
    socket: null,
    connected: false,
    screenInfo: null,
    rightClickMode: false,
    activeModifiers: new Set(),
    lastFrameTime: 0,
    frameCount: 0,
    fpsCounter: 0,
    currentFPS: 0
  };

  // ─── DOM Elements ──────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const loginScreen = $('#login-screen');
  const desktopScreen = $('#desktop-screen');
  const loginForm = $('#login-form');
  const passwordInput = $('#password-input');
  const loginBtn = $('#login-btn');
  const loginError = $('#login-error');
  const canvas = $('#remote-canvas');
  const ctx = canvas.getContext('2d');
  const canvasContainer = $('#canvas-container');
  const cursorIndicator = $('#cursor-indicator');
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
  const rightClickModeBtn = $('#right-click-mode-btn');

  // ─── Image buffer for frame rendering ──────────────────
  const frameImage = new Image();

  // ─── Login ─────────────────────────────────────────────
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = passwordInput.value.trim();
    if (!password) return;

    showLoginLoading(true);
    hideLoginError();

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });

      const data = await res.json();

      if (!res.ok) {
        showLoginError(data.error || 'Login failed');
        showLoginLoading(false);
        return;
      }

      state.token = data.token;
      localStorage.setItem('loginto_token', data.token);
      connectSocket();

    } catch (err) {
      showLoginError('Connection failed. Is the server running?');
      showLoginLoading(false);
    }
  });

  function showLoginLoading(loading) {
    loginBtn.querySelector('.btn-text').style.display = loading ? 'none' : '';
    loginBtn.querySelector('.btn-loading').style.display = loading ? '' : 'none';
    loginBtn.disabled = loading;
  }

  function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.style.display = 'block';
  }

  function hideLoginError() {
    loginError.style.display = 'none';
  }

  // Check for existing session
  async function checkExistingSession() {
    const token = localStorage.getItem('loginto_token');
    if (!token) return;

    try {
      const res = await fetch('/api/session', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        state.token = token;
        connectSocket();
      } else {
        localStorage.removeItem('loginto_token');
      }
    } catch (e) {
      // Server not reachable
    }
  }

  // ─── Socket.IO Connection ──────────────────────────────
  function connectSocket() {
    state.socket = io({
      auth: { token: state.token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });

    state.socket.on('connect', () => {
      state.connected = true;
      switchScreen('desktop');
      updateStatus('Connected', false);
      console.log('✅ Connected to desktop');
    });

    state.socket.on('disconnect', () => {
      state.connected = false;
      updateStatus('Disconnected', true);
    });

    state.socket.on('connect_error', (err) => {
      if (err.message === 'Authentication required') {
        localStorage.removeItem('loginto_token');
        switchScreen('login');
        showLoginError('Session expired. Please log in again.');
        showLoginLoading(false);
      }
    });

    state.socket.on('kicked', (data) => {
      alert('Another device connected. You have been disconnected.');
      switchScreen('login');
    });

    state.socket.on('screen-info', (info) => {
      state.screenInfo = info;
      canvas.width = info.scaledWidth;
      canvas.height = info.scaledHeight;
      console.log(`🖥️ Screen: ${info.width}x${info.height} → ${info.scaledWidth}x${info.scaledHeight}`);
    });

    state.socket.on('frame', (frameData) => {
      renderFrame(frameData);
    });

    // FPS counter
    setInterval(() => {
      state.currentFPS = state.fpsCounter;
      state.fpsCounter = 0;
      fpsDisplay.textContent = `${state.currentFPS} FPS`;
    }, 1000);
  }

  // ─── Frame Rendering ──────────────────────────────────
  function renderFrame(frameData) {
    const now = performance.now();
    const latency = now - state.lastFrameTime;
    state.lastFrameTime = now;
    state.fpsCounter++;
    state.frameCount++;

    // Update latency display every 10 frames
    if (state.frameCount % 10 === 0) {
      latencyDisplay.textContent = `${Math.round(latency)} ms`;
    }

    // Render JPEG frame to canvas
    frameImage.onload = () => {
      canvas.width = frameData.width;
      canvas.height = frameData.height;
      ctx.drawImage(frameImage, 0, 0);
    };
    frameImage.src = 'data:image/jpeg;base64,' + frameData.data;
  }

  // ─── Screen Switching ──────────────────────────────────
  function switchScreen(name) {
    loginScreen.classList.remove('active');
    desktopScreen.classList.remove('active');

    if (name === 'login') {
      loginScreen.classList.add('active');
      showLoginLoading(false);
    } else {
      desktopScreen.classList.add('active');
    }
  }

  function updateStatus(text, isError) {
    statusText.textContent = text;
    statusDot.classList.toggle('error', isError);
  }

  // ─── Touch → Mouse Mapping ────────────────────────────
  let touchState = {
    startX: 0,
    startY: 0,
    startTime: 0,
    lastTapTime: 0,
    moved: false,
    pinchDist: 0,
    scrolling: false,
    twoFingerStart: null
  };

  function getCanvasCoords(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const canvasX = (clientX - rect.left) * scaleX;
    const canvasY = (clientY - rect.top) * scaleY;

    // Map from scaled coords back to full screen coords
    if (state.screenInfo) {
      const fullX = (canvasX / state.screenInfo.scaledWidth) * state.screenInfo.width;
      const fullY = (canvasY / state.screenInfo.scaledHeight) * state.screenInfo.height;
      return { x: fullX, y: fullY };
    }

    return { x: canvasX, y: canvasY };
  }

  function showCursor(clientX, clientY) {
    const rect = canvasContainer.getBoundingClientRect();
    cursorIndicator.style.left = (clientX - rect.left) + 'px';
    cursorIndicator.style.top = (clientY - rect.top) + 'px';
    cursorIndicator.classList.add('visible');
  }

  function hideCursor() {
    cursorIndicator.classList.remove('visible');
    cursorIndicator.classList.remove('clicking');
  }

  function flashCursor() {
    cursorIndicator.classList.add('clicking');
    setTimeout(() => cursorIndicator.classList.remove('clicking'), 150);
  }

  // Single touch → mouse move + click
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];

    touchState.startX = touch.clientX;
    touchState.startY = touch.clientY;
    touchState.startTime = Date.now();
    touchState.moved = false;

    // Two-finger scroll detection
    if (e.touches.length === 2) {
      touchState.scrolling = true;
      touchState.twoFingerStart = {
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2
      };
      return;
    }

    touchState.scrolling = false;
    const coords = getCanvasCoords(touch.clientX, touch.clientY);
    state.socket?.emit('mouse-move', coords);
    showCursor(touch.clientX, touch.clientY);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();

    // Two-finger scroll
    if (e.touches.length === 2 && touchState.scrolling) {
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const deltaY = touchState.twoFingerStart.y - midY;
      const deltaX = touchState.twoFingerStart.x - midX;

      const coords = getCanvasCoords(midX, midY);
      if (Math.abs(deltaY) > 5 || Math.abs(deltaX) > 5) {
        state.socket?.emit('mouse-scroll', {
          x: coords.x,
          y: coords.y,
          deltaX: deltaX,
          deltaY: deltaY
        });
        touchState.twoFingerStart = { y: midY, x: midX };
      }
      return;
    }

    const touch = e.touches[0];
    const dx = touch.clientX - touchState.startX;
    const dy = touch.clientY - touchState.startY;

    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      touchState.moved = true;
    }

    const coords = getCanvasCoords(touch.clientX, touch.clientY);
    state.socket?.emit('mouse-move', coords);
    showCursor(touch.clientX, touch.clientY);
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();

    if (touchState.scrolling && e.touches.length < 2) {
      touchState.scrolling = false;
      return;
    }

    const duration = Date.now() - touchState.startTime;

    if (!touchState.moved && duration < 500) {
      const coords = getCanvasCoords(touchState.startX, touchState.startY);
      flashCursor();

      // Double-tap detection
      const now = Date.now();
      if (now - touchState.lastTapTime < 300) {
        state.socket?.emit('mouse-double-click', coords);
        touchState.lastTapTime = 0;
      } else if (state.rightClickMode) {
        state.socket?.emit('mouse-right-click', coords);
      } else {
        state.socket?.emit('mouse-click', { ...coords, button: 'left' });
      }
      touchState.lastTapTime = now;
    }

    // Long press → right click
    if (!touchState.moved && duration >= 500) {
      const coords = getCanvasCoords(touchState.startX, touchState.startY);
      state.socket?.emit('mouse-right-click', coords);
      flashCursor();
      // Haptic feedback if available
      if (navigator.vibrate) navigator.vibrate(50);
    }

    setTimeout(hideCursor, 300);
  }, { passive: false });

  // Mouse events (for desktop browser testing)
  canvas.addEventListener('mousemove', (e) => {
    const coords = getCanvasCoords(e.clientX, e.clientY);
    state.socket?.emit('mouse-move', coords);
  });

  canvas.addEventListener('click', (e) => {
    const coords = getCanvasCoords(e.clientX, e.clientY);
    state.socket?.emit('mouse-click', { ...coords, button: 'left' });
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const coords = getCanvasCoords(e.clientX, e.clientY);
    state.socket?.emit('mouse-right-click', coords);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const coords = getCanvasCoords(e.clientX, e.clientY);
    state.socket?.emit('mouse-scroll', {
      x: coords.x,
      y: coords.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY
    });
  }, { passive: false });

  // ─── Virtual Keyboard ──────────────────────────────────
  keyboardBtn.addEventListener('click', () => {
    keyboardInput.focus();
    keyboardInput.click();
  });

  keyboardInput.addEventListener('input', (e) => {
    const text = e.target.value;
    if (text) {
      // Check for active modifiers
      if (state.activeModifiers.size > 0) {
        state.socket?.emit('key-press', {
          key: text,
          modifiers: Array.from(state.activeModifiers)
        });
        clearModifiers();
      } else {
        state.socket?.emit('key-type', { text });
      }
      keyboardInput.value = '';
    }
  });

  keyboardInput.addEventListener('keydown', (e) => {
    // Handle special keys
    const specialKeysList = [
      'Enter', 'Backspace', 'Tab', 'Escape', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown'
    ];

    if (specialKeysList.includes(e.key)) {
      e.preventDefault();
      const modifiers = [];
      if (e.ctrlKey) modifiers.push('ctrl');
      if (e.altKey) modifiers.push('alt');
      if (e.shiftKey) modifiers.push('shift');
      if (e.metaKey) modifiers.push('meta');

      state.socket?.emit('key-press', {
        key: e.key,
        modifiers: [...modifiers, ...Array.from(state.activeModifiers)]
      });

      if (state.activeModifiers.size > 0) {
        clearModifiers();
      }
    }
  });

  // ─── Special Keys Panel ────────────────────────────────
  specialKeysBtn.addEventListener('click', () => {
    specialKeys.classList.toggle('hidden');
    specialKeysBtn.classList.toggle('active');
  });

  // Individual special keys
  $$('.skey[data-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      state.socket?.emit('key-press', {
        key,
        modifiers: Array.from(state.activeModifiers)
      });

      if (state.activeModifiers.size > 0) {
        clearModifiers();
      }

      // Visual feedback
      btn.style.background = 'var(--accent)';
      setTimeout(() => btn.style.background = '', 150);
    });
  });

  // Modifier toggle keys
  $$('.skey.mod').forEach(btn => {
    btn.addEventListener('click', () => {
      const mod = btn.dataset.mod;
      if (state.activeModifiers.has(mod)) {
        state.activeModifiers.delete(mod);
        btn.classList.remove('active');
      } else {
        state.activeModifiers.add(mod);
        btn.classList.add('active');
      }
    });
  });

  // Shortcut combos
  $$('.skey.combo').forEach(btn => {
    btn.addEventListener('click', () => {
      const combo = btn.dataset.combo;
      const parts = combo.split('+');
      const key = parts.pop();
      const modifiers = parts;

      // On Mac, swap ctrl for meta
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
      if (isMac) {
        const idx = modifiers.indexOf('ctrl');
        if (idx !== -1) modifiers[idx] = 'meta';
      }

      state.socket?.emit('key-press', { key, modifiers });

      // Visual feedback
      btn.style.background = 'var(--accent)';
      setTimeout(() => btn.style.background = '', 150);
    });
  });

  function clearModifiers() {
    state.activeModifiers.clear();
    $$('.skey.mod').forEach(b => b.classList.remove('active'));
  }

  // ─── Right-Click Mode ──────────────────────────────────
  rightClickModeBtn.addEventListener('click', () => {
    state.rightClickMode = !state.rightClickMode;
    rightClickModeBtn.classList.toggle('active', state.rightClickMode);
  });

  // ─── Toolbar Toggle ────────────────────────────────────
  toolbarToggle.addEventListener('click', () => {
    toolbar.classList.toggle('hidden');
    // Close special keys when opening toolbar
    if (!toolbar.classList.contains('hidden')) {
      specialKeys.classList.add('hidden');
      specialKeysBtn.classList.remove('active');
    }
  });

  // Close toolbar on canvas tap
  canvas.addEventListener('touchstart', () => {
    if (!toolbar.classList.contains('hidden')) {
      toolbar.classList.add('hidden');
    }
  }, { passive: true });

  // ─── Quality/FPS Sliders ───────────────────────────────
  qualitySlider.addEventListener('input', () => {
    qualityValue.textContent = qualitySlider.value + '%';
  });
  qualitySlider.addEventListener('change', () => {
    state.socket?.emit('update-quality', { quality: parseInt(qualitySlider.value) });
  });

  fpsSlider.addEventListener('input', () => {
    fpsValue.textContent = fpsSlider.value;
  });
  fpsSlider.addEventListener('change', () => {
    state.socket?.emit('update-fps', { fps: parseInt(fpsSlider.value) });
  });

  // ─── Fullscreen ────────────────────────────────────────
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.() ||
      document.documentElement.webkitRequestFullscreen?.();
      document.body.classList.add('fullscreen');
    } else {
      document.exitFullscreen?.() ||
      document.webkitExitFullscreen?.();
      document.body.classList.remove('fullscreen');
    }
  });

  // ─── Disconnect ────────────────────────────────────────
  disconnectBtn.addEventListener('click', () => {
    if (confirm('Disconnect from desktop?')) {
      state.socket?.disconnect();
      localStorage.removeItem('loginto_token');
      switchScreen('login');
      passwordInput.value = '';
    }
  });

  // ─── Prevent default browser behaviors ─────────────────
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());

  // Prevent pull-to-refresh on mobile
  document.body.addEventListener('touchmove', (e) => {
    if (desktopScreen.classList.contains('active')) {
      if (e.target === canvas || canvasContainer.contains(e.target)) {
        // Allow on canvas for our handlers
      } else {
        e.preventDefault();
      }
    }
  }, { passive: false });

  // ─── Init ──────────────────────────────────────────────
  checkExistingSession();

})();
