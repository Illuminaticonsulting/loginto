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
  let machines = [];  // [{ id, name, agentKey, connected, macAddress, broadcastAddress }]
  const wakePollers = new Map(); // machineId → intervalId (active wake-polling)

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
              <details class="advanced-toggle" style="margin-top: 8px;">
                <summary class="text-muted text-sm">Auto-start on boot (run as service)</summary>
                <div class="setup-tabs-mini" style="margin-top:8px;">
                  <button class="os-tab-mini active" data-os="mac" data-mid="${m.id}-svc">Mac</button>
                  <button class="os-tab-mini" data-os="win" data-mid="${m.id}-svc">Windows</button>
                </div>
                <div class="setup-panel-mac-${m.id}-svc setup-panel-mini active">
                  <div class="code-block copy-cmd" style="font-size:12px;" title="Click to copy">cd ~/loginto-agent &amp;&amp; npm run install-service</div>
                  <p class="text-muted text-sm" style="margin-top:6px;">Installs a LaunchAgent. Agent starts at login and reconnects automatically when your Mac wakes from sleep.</p>
                </div>
                <div class="setup-panel-win-${m.id}-svc setup-panel-mini">
                  <div class="code-block copy-cmd" style="font-size:12px;" title="Click to copy">cd %USERPROFILE%\\loginto-agent &amp;&amp; node install-service.js</div>
                  <p class="text-muted text-sm" style="margin-top:6px;">Run in a terminal as Administrator. Creates a Task Scheduler entry that starts at every logon.</p>
                </div>
              </details>
            </div>
          ` : `
            <div class="machine-body">
              <p class="text-muted text-sm" style="margin-bottom: 12px;">Agent not connected. Run the setup command on your computer:</p>

              ${m.macAddress ? `
                <div class="wol-row">
                  <button class="btn-wake" data-id="${m.id}">&#9889; Wake Machine</button>
                  <span class="wake-mac-label">${m.macAddress}</span>
                  <button class="btn-set-mac btn-icon text-sm" data-id="${m.id}" title="Change MAC address">&#9998;</button>
                </div>
                <p class="wol-hint">Requires UDP port 9 forwarded on your router to the local subnet broadcast (e.g. 192.168.1.255). Enable WoL in BIOS and network adapter settings.</p>
                <div class="wake-status" id="wake-status-${m.id}"></div>
              ` : `
                <button class="btn-set-mac-empty" data-id="${m.id}">+ Configure Wake-on-LAN</button>
              `}

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
              <p class="text-muted text-sm" style="margin-top: 8px;">Keep the terminal open. Status will switch to <span class="text-success">&#9679; Online</span>.</p>

              <details class="advanced-toggle" style="margin-top: 12px;">
                <summary class="text-muted text-sm">Auto-start on boot (run as service)</summary>
                <div class="setup-tabs-mini" style="margin-top:8px;">
                  <button class="os-tab-mini active" data-os="mac" data-mid="${m.id}-svc">Mac</button>
                  <button class="os-tab-mini" data-os="win" data-mid="${m.id}-svc">Windows</button>
                </div>
                <div class="setup-panel-mac-${m.id}-svc setup-panel-mini active">
                  <div class="code-block copy-cmd" style="font-size:12px;" title="Click to copy">cd ~/loginto-agent &amp;&amp; npm run install-service</div>
                  <p class="text-muted text-sm" style="margin-top:6px;">Installs a LaunchAgent. Agent starts at login and reconnects automatically when your Mac wakes from sleep.</p>
                </div>
                <div class="setup-panel-win-${m.id}-svc setup-panel-mini">
                  <div class="code-block copy-cmd" style="font-size:12px;" title="Click to copy">cd %USERPROFILE%\\loginto-agent &amp;&amp; node install-service.js</div>
                  <p class="text-muted text-sm" style="margin-top:6px;">Run in a terminal as Administrator. Creates a Task Scheduler entry that starts at every logon.</p>
                </div>
              </details>
            </div>
          `}
        </div>`;
    }).join('');

    // ─── Wire up machine card events ───
    // OS tab switching — scoped by data-mid to support multiple tab groups per card
    container.querySelectorAll('.os-tab-mini').forEach(tab => {
      tab.addEventListener('click', () => {
        const mid = tab.dataset.mid;
        const card = tab.closest('.machine-card');
        card.querySelectorAll(`.os-tab-mini[data-mid="${mid}"]`).forEach(t => t.classList.remove('active'));
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

    // Wake button (offline cards with MAC address)
    container.querySelectorAll('.btn-wake').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.disabled = true;
        wakeMachine(btn.dataset.id, () => { btn.disabled = false; });
      });
    });

    // Edit MAC address (on cards that already have one)
    container.querySelectorAll('.btn-set-mac').forEach(btn => {
      btn.addEventListener('click', () => configureMacAddress(btn.dataset.id));
    });

    // Configure Wake-on-LAN (on cards with no MAC yet)
    container.querySelectorAll('.btn-set-mac-empty').forEach(btn => {
      btn.addEventListener('click', () => configureMacAddress(btn.dataset.id));
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
      // If machine just came online, stop any active wake polling
      if (data.connected && wakePollers.has(data.machineId)) {
        clearInterval(wakePollers.get(data.machineId));
        wakePollers.delete(data.machineId);
      }
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

  // ─── Wake-on-LAN ───────────────────────────────────────

  function wakeMachine(machineId, onComplete) {
    const m = machines.find(x => x.id === machineId);
    if (!m) { if (onComplete) onComplete(); return; }

    setWakeStatus(machineId, 'pending', 'Sending Wake-on-LAN packet...');

    fetch(`/api/machines/${userId}/${machineId}/wake`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    })
      .then(res => res.json())
      .then(data => {
        if (onComplete) onComplete();
        if (data.ok) {
          if (data.alreadyOnline) {
            m.connected = true;
            renderMachines();
            return;
          }
          setWakeStatus(machineId, 'success', 'Packet sent! Waiting for machine to wake...');
          startWakePolling(machineId);
        } else {
          setWakeStatus(machineId, 'error', data.error || 'Failed to send packet.');
        }
      })
      .catch(() => {
        if (onComplete) onComplete();
        setWakeStatus(machineId, 'error', 'Network error. Please try again.');
      });
  }

  function startWakePolling(machineId) {
    if (wakePollers.has(machineId)) return; // already polling

    const INTERVAL = 3000;
    const TIMEOUT  = 60000;
    let elapsed = 0;

    const id = setInterval(() => {
      elapsed += INTERVAL;

      fetch('/api/machines/' + userId, {
        headers: { 'Authorization': 'Bearer ' + token }
      })
        .then(r => r.json())
        .then(data => {
          const updated = (data.machines || []).find(x => x.id === machineId);
          if (updated?.connected) {
            clearInterval(id);
            wakePollers.delete(machineId);
            const m = machines.find(x => x.id === machineId);
            if (m) m.connected = true;
            renderMachines();
          } else if (elapsed >= TIMEOUT) {
            clearInterval(id);
            wakePollers.delete(machineId);
            renderMachines();
            setWakeStatus(
              machineId, 'error',
              'Machine did not respond within 60 seconds. ' +
              'Check that WoL is enabled in BIOS, UDP port 9 is forwarded on your router, ' +
              'and the agent is set to auto-start (see "Auto-start on boot" below).'
            );
          }
        })
        .catch(() => {}); // ignore transient errors during polling
    }, INTERVAL);

    wakePollers.set(machineId, id);
  }

  function setWakeStatus(machineId, state, text) {
    const el = document.getElementById('wake-status-' + machineId);
    if (!el) return;
    el.textContent = text;
    el.className = 'wake-status wake-' + state;
    el.style.display = text ? 'block' : 'none';
  }

  function configureMacAddress(machineId) {
    const m = machines.find(x => x.id === machineId);
    if (!m) return;

    const mac = prompt(
      'Enter MAC address for Wake-on-LAN\n' +
      '(format: AA:BB:CC:DD:EE:FF  or  AA-BB-CC-DD-EE-FF)\n\n' +
      'How to find it:\n' +
      '  macOS:   System Settings \u2192 Network \u2192 [interface] \u2192 Details \u2192 Hardware\n' +
      '  Windows: run "ipconfig /all" and look for Physical Address\n\n' +
      'Leave blank to remove Wake-on-LAN.',
      m.macAddress || ''
    );
    if (mac === null) return; // cancelled

    const broadcast = prompt(
      'Broadcast address (optional — press OK for default 255.255.255.255)\n\n' +
      'For WoL to work from this remote server your router must forward\n' +
      'UDP port 9 to your local subnet broadcast address.\n\n' +
      'Example: 192.168.1.255\n' +
      'Find yours: run "ipconfig" (Win) or "ifconfig" (Mac/Linux)',
      m.broadcastAddress || ''
    );
    if (broadcast === null) return; // cancelled

    fetch(`/api/machines/${userId}/${machineId}/mac`, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        macAddress:       mac.trim()       || null,
        broadcastAddress: broadcast.trim() || null
      })
    })
      .then(res => res.json())
      .then(data => {
        if (data.ok) {
          m.macAddress       = mac.trim()       || null;
          m.broadcastAddress = broadcast.trim() || null;
          renderMachines();
        } else {
          alert('Error: ' + (data.error || 'Could not save MAC address.'));
        }
      })
      .catch(() => alert('Network error saving MAC address.'));
  }

  // ─── Initial Load ─────────────────────────────────────
  loadMachines();

})();
