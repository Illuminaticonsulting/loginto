/**
 * LogInTo — Dashboard Logic (Multi-Machine)
 *
 * Shows all machines with status (online/offline), agent setup instructions,
 * connect buttons, and machine management (add/rename/delete).
 * Uses Socket.IO for real-time per-machine status.
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
  const container = document.getElementById('machines-container');
  const addMachineBtn = document.getElementById('btn-add-machine');

  // ─── State ─────────────────────────────────────────────
  let machines = [];  // [{ id, name, agentKey, connected }]

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

  // ─── Load Machines ─────────────────────────────────────
  function loadMachines() {
    fetch('/api/machines/' + userId, {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(res => res.json())
      .then(data => {
        machines = (data.machines || []).map(m => ({
          ...m,
          connected: m.connected || false
        }));
        renderMachines();
      }).catch(() => {
        container.innerHTML = '<p class="text-muted" style="text-align:center;padding:40px 0;">Error loading machines</p>';
      });
  }

  // ─── Render Machine Cards ──────────────────────────────
  function renderMachines() {
    if (machines.length === 0) {
      container.innerHTML = `
        <div class="machine-card" style="text-align:center; padding: 40px 20px;">
          <p class="text-muted">No machines yet. Add one to get started.</p>
        </div>`;
      return;
    }

    container.innerHTML = machines.map(m => {
      const online = m.connected;
      const macCmd = `curl -sL "${location.origin}/api/setup/${m.agentKey}" | bash`;
      const winCmd = `powershell -ExecutionPolicy Bypass -Command "irm '${location.origin}/api/setup-win/${m.agentKey}' | iex"`;

      return `
        <div class="machine-card" data-machine-id="${m.id}">
          <div class="machine-card-header">
            <div class="machine-status">
              <span class="dot ${online ? 'online' : 'offline'}"></span>
              <span class="machine-name" title="${m.name}">${m.name}</span>
              <span class="machine-status-label">${online ? 'Online' : 'Offline'}</span>
            </div>
            <div class="machine-actions">
              <button class="btn-icon btn-rename" data-id="${m.id}" title="Rename">✏️</button>
              <button class="btn-icon btn-delete" data-id="${m.id}" title="Delete">🗑️</button>
            </div>
          </div>

          ${online ? `
            <div class="machine-body">
              <a href="/viewer.html?machine=${m.id}" class="btn-primary btn-connect">Connect</a>
              <details class="advanced-toggle" style="margin-top: 16px;">
                <summary class="text-muted text-sm">Setup command</summary>
                <div class="setup-tabs-mini">
                  <button class="os-tab-mini active" data-os="mac" data-mid="${m.id}">Mac/Linux</button>
                  <button class="os-tab-mini" data-os="win" data-mid="${m.id}">Windows</button>
                </div>
                <div class="setup-panel-mac-${m.id} setup-panel-mini active">
                  <div class="code-block setup-oneliner copy-cmd" title="Click to copy">${macCmd}</div>
                </div>
                <div class="setup-panel-win-${m.id} setup-panel-mini">
                  <div class="code-block setup-oneliner copy-cmd" title="Click to copy">${winCmd}</div>
                </div>
              </details>
            </div>
          ` : `
            <div class="machine-body">
              <p class="text-muted text-sm" style="margin-bottom: 12px;">Agent not connected. Run the setup command on your computer:</p>
              <div class="setup-tabs-mini">
                <button class="os-tab-mini active" data-os="mac" data-mid="${m.id}">Mac/Linux</button>
                <button class="os-tab-mini" data-os="win" data-mid="${m.id}">Windows</button>
              </div>
              <div class="setup-panel-mac-${m.id} setup-panel-mini active">
                <div class="code-block setup-oneliner copy-cmd" title="Click to copy">${macCmd}</div>
              </div>
              <div class="setup-panel-win-${m.id} setup-panel-mini">
                <div class="code-block setup-oneliner copy-cmd" title="Click to copy">${winCmd}</div>
              </div>
              <p class="text-muted text-sm" style="margin-top: 8px;">Keep the terminal open. Status will switch to <span class="text-success">● Online</span>.</p>
            </div>
          `}
        </div>`;
    }).join('');

    // ─── Wire up machine card events ───
    // OS tab switching
    container.querySelectorAll('.os-tab-mini').forEach(tab => {
      tab.addEventListener('click', () => {
        const mid = tab.dataset.mid;
        const card = tab.closest('.machine-card');
        card.querySelectorAll('.os-tab-mini').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const macPanel = card.querySelector('.setup-panel-mac-' + mid);
        const winPanel = card.querySelector('.setup-panel-win-' + mid);
        if (tab.dataset.os === 'win') {
          if (macPanel) macPanel.classList.remove('active');
          if (winPanel) winPanel.classList.add('active');
        } else {
          if (winPanel) winPanel.classList.remove('active');
          if (macPanel) macPanel.classList.add('active');
        }
      });
    });

    // Copy commands
    container.querySelectorAll('.copy-cmd').forEach(el => {
      el.addEventListener('click', () => {
        const text = el.textContent;
        if (text && !text.startsWith('Loading')) {
          navigator.clipboard.writeText(text).then(() => {
            const orig = el.textContent;
            el.textContent = '✅ Copied!';
            setTimeout(() => { el.textContent = orig; }, 1500);
          }).catch(() => {});
        }
      });
    });

    // Rename buttons
    container.querySelectorAll('.btn-rename').forEach(btn => {
      btn.addEventListener('click', () => renameMachine(btn.dataset.id));
    });

    // Delete buttons
    container.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', () => deleteMachine(btn.dataset.id));
    });
  }

  // ─── Add Machine ──────────────────────────────────────
  addMachineBtn.addEventListener('click', () => {
    const name = prompt('Machine name:', 'My Computer');
    if (!name) return;
    fetch('/api/machines/' + userId, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name })
    }).then(res => res.json())
      .then(data => {
        if (data.machine) {
          machines.push({ ...data.machine, connected: false });
          renderMachines();
        }
      }).catch(() => alert('Error adding machine'));
  });

  // ─── Rename Machine ──────────────────────────────────
  function renameMachine(machineId) {
    const m = machines.find(x => x.id === machineId);
    if (!m) return;
    const newName = prompt('Rename machine:', m.name);
    if (!newName || newName === m.name) return;
    fetch(`/api/machines/${userId}/${machineId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: newName })
    }).then(res => {
      if (res.ok) {
        m.name = newName;
        renderMachines();
      }
    }).catch(() => alert('Error renaming machine'));
  }

  // ─── Delete Machine ──────────────────────────────────
  function deleteMachine(machineId) {
    const m = machines.find(x => x.id === machineId);
    if (!m) return;
    if (!confirm(`Delete "${m.name}"? This will disconnect the agent.`)) return;
    fetch(`/api/machines/${userId}/${machineId}`, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(res => {
      if (res.ok) {
        machines = machines.filter(x => x.id !== machineId);
        renderMachines();
      }
    }).catch(() => alert('Error deleting machine'));
  }

  // ─── Real-Time Status via Socket.IO ────────────────────
  const socket = io({
    auth: { token, role: 'dashboard' },
    reconnection: true,
    reconnectionDelay: 2000
  });

  socket.on('connect', () => {
    // Initial machine-status events will come from server
  });

  // Per-machine status updates
  socket.on('machine-status', (data) => {
    const m = machines.find(x => x.id === data.machineId);
    if (m) {
      m.connected = data.connected;
      renderMachines();
    }
  });

  // Legacy compat (single-machine agent-status)
  socket.on('agent-status', (data) => {
    // If only one machine, update it
    if (machines.length === 1) {
      machines[0].connected = data.connected;
      renderMachines();
    }
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'Authentication required') {
      localStorage.clear();
      window.location.href = '/';
    }
  });

  // Poll as backup
  setInterval(() => {
    fetch('/api/machines/' + userId, {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(res => res.json())
      .then(data => {
        if (data.machines) {
          for (const m of data.machines) {
            const existing = machines.find(x => x.id === m.id);
            if (existing && existing.connected !== m.connected) {
              existing.connected = m.connected;
            }
          }
          renderMachines();
        }
      }).catch(() => {});
  }, 10000);

  // ─── Logout ────────────────────────────────────────────
  logoutBtn.addEventListener('click', () => {
    fetch('/api/logout', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    }).catch(() => {}).finally(() => {
      socket.disconnect();
      localStorage.clear();
      window.location.href = '/';
    });
  });

  // ─── Initial Load ─────────────────────────────────────
  loadMachines();

})();
