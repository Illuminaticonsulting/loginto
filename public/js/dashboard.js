/**
 * LogInTo — Dashboard Logic
 *
 * Shows machine status (online/offline), agent setup instructions,
 * and connect button. Uses Socket.IO for real-time agent status.
 */
(function() {
  'use strict';

  // ─── Auth Check ────────────────────────────────────────
  const token = localStorage.getItem('loginto_token');
  const userId = localStorage.getItem('loginto_userId');
  const displayName = localStorage.getItem('loginto_displayName');

  if (!token || !userId) {
    window.location.href = '/';
    return;
  }

  // ─── DOM Elements ──────────────────────────────────────
  const userGreeting = document.getElementById('user-greeting');
  const logoutBtn = document.getElementById('logout-btn');
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const stateOnline = document.getElementById('state-online');
  const stateOffline = document.getElementById('state-offline');
  const agentKeyBox = document.getElementById('agent-key-box');
  const setupCommand = document.getElementById('setup-command');
  const setupCommandWin = document.getElementById('setup-command-win');
  const setupCommandOnline = document.getElementById('setup-command-online');
  const copyFeedback = document.getElementById('copy-feedback');
  const copyFeedbackOnline = document.getElementById('copy-feedback-online');

  // ─── Init UI ───────────────────────────────────────────
  userGreeting.textContent = displayName || userId;

  // ─── Validate Session ──────────────────────────────────
  fetch('/api/session', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(res => {
    if (!res.ok) {
      localStorage.clear();
      window.location.href = '/';
    }
  }).catch(() => {});

  // ─── Load Agent Key & Build Setup Command ───────────────
  fetch('/api/agent-info/' + userId, {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(res => res.json())
    .then(data => {
      if (data.agentKey) {
        agentKeyBox.textContent = data.agentKey;
        const cmd = `curl -sL "${location.origin}/api/setup/${data.agentKey}" | bash`;
        const cmdWin = `irm "${location.origin}/api/setup-win/${data.agentKey}" | iex`;
        setupCommand.textContent = cmd;
        if (setupCommandWin) setupCommandWin.textContent = cmdWin;
        if (setupCommandOnline) setupCommandOnline.textContent = cmd;
      }
    }).catch(() => {
      agentKeyBox.textContent = 'Error loading key';
      setupCommand.textContent = 'Error loading setup command';
    });

  // Copy setup command on click
  setupCommand.addEventListener('click', () => {
    const text = setupCommand.textContent;
    if (text && !text.startsWith('Loading') && !text.startsWith('Error')) {
      navigator.clipboard.writeText(text).then(() => {
        copyFeedback.style.display = 'block';
        setTimeout(() => { copyFeedback.style.display = 'none'; }, 2000);
      }).catch(() => {
        const range = document.createRange();
        range.selectNodeContents(setupCommand);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    }
  });

  // Copy Windows setup command on click
  if (setupCommandWin) {
    setupCommandWin.addEventListener('click', () => {
      const text = setupCommandWin.textContent;
      if (text && !text.startsWith('Loading') && !text.startsWith('Error')) {
        navigator.clipboard.writeText(text).then(() => {
          copyFeedback.style.display = 'block';
          setTimeout(() => { copyFeedback.style.display = 'none'; }, 2000);
        }).catch(() => {});
      }
    });
  }

  // OS tab switching (Mac/Linux vs Windows)
  document.querySelectorAll('.os-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.os-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.setup-os-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const os = tab.dataset.os;
      const panel = document.getElementById(os === 'win' ? 'setup-win' : 'setup-mac');
      if (panel) panel.classList.add('active');
    });
  });

  // Copy agent key on click
  agentKeyBox.addEventListener('click', () => {
    const key = agentKeyBox.textContent;
    if (key && key !== 'Loading...' && key !== 'Error loading key') {
      navigator.clipboard.writeText(key).then(() => {
        copyFeedback.style.display = 'block';
        setTimeout(() => { copyFeedback.style.display = 'none'; }, 2000);
      }).catch(() => {
        const range = document.createRange();
        range.selectNodeContents(agentKeyBox);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    }
  });

  // Copy online setup command on click
  if (setupCommandOnline) {
    setupCommandOnline.addEventListener('click', () => {
      const text = setupCommandOnline.textContent;
      if (text && !text.startsWith('Loading') && !text.startsWith('Error')) {
        navigator.clipboard.writeText(text).then(() => {
          if (copyFeedbackOnline) {
            copyFeedbackOnline.style.display = 'block';
            setTimeout(() => { copyFeedbackOnline.style.display = 'none'; }, 2000);
          }
        }).catch(() => {});
      }
    });
  }

  // ─── Real-Time Status via Socket.IO ────────────────────
  const socket = io({
    auth: { token, role: 'dashboard' },
    reconnection: true,
    reconnectionDelay: 2000
  });

  socket.on('connect', () => {
    // Status will come via agent-status event
  });

  socket.on('agent-status', (data) => {
    updateStatus(data.connected);
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'Authentication required') {
      localStorage.clear();
      window.location.href = '/';
    }
  });

  function updateStatus(online) {
    statusDot.className = 'dot ' + (online ? 'online' : 'offline');
    statusLabel.textContent = online ? 'Online' : 'Offline';
    stateOnline.style.display = online ? 'block' : 'none';
    stateOffline.style.display = online ? 'none' : 'block';
  }

  // Also poll as backup (in case socket disconnects)
  setInterval(() => {
    fetch('/api/user-status/' + userId, {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(res => res.json())
      .then(data => {
        updateStatus(data.agentConnected);
      }).catch(() => {});
  }, 10000);

  // ─── Logout ────────────────────────────────────────────
  logoutBtn.addEventListener('click', () => {
    // Invalidate server-side session, then clear local state
    fetch('/api/logout', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    }).catch(() => {}).finally(() => {
      socket.disconnect();
      localStorage.clear();
      window.location.href = '/';
    });
  });

})();
