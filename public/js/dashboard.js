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
  const copyFeedback = document.getElementById('copy-feedback');

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

  // ─── Load Agent Key ────────────────────────────────────
  fetch('/api/agent-info/' + userId, {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(res => res.json())
    .then(data => {
      if (data.agentKey) {
        agentKeyBox.textContent = data.agentKey;
      }
    }).catch(() => {
      agentKeyBox.textContent = 'Error loading key';
    });

  // Copy agent key on click
  agentKeyBox.addEventListener('click', () => {
    const key = agentKeyBox.textContent;
    if (key && key !== 'Loading...' && key !== 'Error loading key') {
      navigator.clipboard.writeText(key).then(() => {
        copyFeedback.style.display = 'block';
        setTimeout(() => { copyFeedback.style.display = 'none'; }, 2000);
      }).catch(() => {
        // Fallback: select text
        const range = document.createRange();
        range.selectNodeContents(agentKeyBox);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    }
  });

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
    socket.disconnect();
    localStorage.clear();
    window.location.href = '/';
  });

})();
