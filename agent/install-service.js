#!/usr/bin/env node

/**
 * LogInTo — Agent Service Installer
 *
 * Installs the LogInTo agent as a system service so it:
 *   - Starts automatically at login / system boot
 *   - Restarts if it crashes
 *   - Keeps running even when the screen is locked
 *
 * Usage:
 *   macOS/Linux:  npm run install-service
 *   Windows:      node install-service.js   (run as Administrator)
 *
 * Run this AFTER you've already set up your .env file.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const platform = process.platform;
const agentDir = __dirname;
const nodePath = process.execPath;   // exact node binary (handles nvm, homebrew, etc.)
const homeDir = os.homedir();

console.log('');
console.log('═══════════════════════════════════════════');
console.log('   LogInTo — Agent Service Installer');
console.log('═══════════════════════════════════════════');
console.log('');
console.log('   Platform: ' + platform);
console.log('   Node:     ' + nodePath);
console.log('   Agent:    ' + agentDir);
console.log('');

if (platform === 'darwin') {
  installMacOS();
} else if (platform === 'win32') {
  installWindows();
} else {
  installLinux();
}

// ─── macOS: LaunchAgent ───────────────────────────────────────────────────────
function installMacOS() {
  const plistDir  = path.join(homeDir, 'Library', 'LaunchAgents');
  const plistPath = path.join(plistDir, 'com.loginto.agent.plist');
  const logOut    = path.join(agentDir, 'agent.log');
  const logErr    = path.join(agentDir, 'agent-error.log');

  if (!fs.existsSync(plistDir)) {
    fs.mkdirSync(plistDir, { recursive: true });
  }

  // Build PATH covering Intel homebrew, ARM homebrew, nvm, and system node
  const nodeBinDir = path.dirname(nodePath);
  const pathVal = [nodeBinDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.loginto.agent</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${path.join(agentDir, 'agent.js')}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${agentDir}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homeDir}</string>
    <key>PATH</key>
    <string>${pathVal}</string>
  </dict>

  <!-- Start at login and restart on crash -->
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <!-- Prevent rapid restart loops on crash -->
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <!-- Interactive session: required for Screen Recording and Accessibility APIs,
       even when the screen is locked -->
  <key>ProcessType</key>
  <string>Interactive</string>

  <!-- GUI session scope (Aqua): ensures screen capture APIs are available -->
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>

  <key>StandardOutPath</key>
  <string>${logOut}</string>
  <key>StandardErrorPath</key>
  <string>${logErr}</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  console.log('   Plist written to: ' + plistPath);

  // Unload any existing instance (silently), then load fresh
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' });
  } catch (_) {}

  execSync(`launchctl load "${plistPath}"`);

  console.log('');
  console.log('   LaunchAgent installed and started!');
  console.log('');
  console.log('   The agent will now:');
  console.log('   - Start automatically at every login');
  console.log('   - Restart automatically if it crashes');
  console.log('   - Keep running when your screen is locked');
  console.log('');
  console.log('   Manage with:');
  console.log('     Stop:       launchctl unload "' + plistPath + '"');
  console.log('     Start:      launchctl load   "' + plistPath + '"');
  console.log('     Uninstall:  rm "' + plistPath + '"');
  console.log('     Logs:       tail -f "' + logOut + '"');
  console.log('');
  console.log('   Important: Make sure Screen Recording and Accessibility');
  console.log('   permissions are granted to Terminal (or your shell) in');
  console.log('   System Settings > Privacy & Security.');
  console.log('');
}

// ─── Windows: Task Scheduler ──────────────────────────────────────────────────
function installWindows() {
  const taskName    = 'LogInToAgent';
  const agentScript = path.join(agentDir, 'agent.js');

  // Build schtasks command — ONLOGON runs at Windows logon, HIGHEST = "Run with highest privileges"
  const createCmd = [
    'schtasks',
    '/Create', '/F',
    '/TN', `"${taskName}"`,
    '/TR', `"\\"${nodePath}\\" \\"${agentScript}\\""`,
    '/SC', 'ONLOGON',
    '/RL', 'HIGHEST',
    '/IT'   // only run when user is logged on (interactive)
  ].join(' ');

  try {
    execSync(createCmd, { shell: true, stdio: 'inherit' });
  } catch (err) {
    console.error('');
    console.error('   Failed to create Task Scheduler entry.');
    console.error('   Please re-run this script as Administrator:');
    console.error('   Right-click your terminal > "Run as Administrator"');
    console.error('');
    process.exit(1);
  }

  // Start the task immediately
  try {
    execSync(`schtasks /Run /TN "${taskName}"`, { shell: true, stdio: 'inherit' });
  } catch (_) {
    // Non-fatal — task was created, it will run at next logon
  }

  console.log('');
  console.log('   Task Scheduler entry created and started!');
  console.log('');
  console.log('   The agent will now:');
  console.log('   - Start automatically at every Windows logon');
  console.log('   - Run in the background when your screen is locked');
  console.log('');
  console.log('   Manage with:');
  console.log(`     Stop:      schtasks /End /TN "${taskName}"`);
  console.log(`     Start:     schtasks /Run /TN "${taskName}"`);
  console.log(`     Uninstall: schtasks /Delete /TN "${taskName}" /F`);
  console.log('     View:      Open Task Scheduler (taskschd.msc)');
  console.log('');
}

// ─── Linux: systemd user service ──────────────────────────────────────────────
function installLinux() {
  const serviceDir  = path.join(homeDir, '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'loginto-agent.service');

  if (!fs.existsSync(serviceDir)) {
    fs.mkdirSync(serviceDir, { recursive: true });
  }

  const unit = `[Unit]
Description=LogInTo Desktop Agent
After=graphical-session.target
Wants=graphical-session.target

[Service]
Type=simple
ExecStart=${nodePath} ${path.join(agentDir, 'agent.js')}
WorkingDirectory=${agentDir}
Restart=on-failure
RestartSec=10
Environment=HOME=${homeDir}
Environment=PATH=${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;

  fs.writeFileSync(servicePath, unit);
  console.log('   Service file written to: ' + servicePath);

  try {
    execSync('systemctl --user daemon-reload');
    execSync('systemctl --user enable loginto-agent.service');
    execSync('systemctl --user start  loginto-agent.service');
  } catch (err) {
    console.error('   systemctl failed: ' + err.message);
    console.error('   Try: systemctl --user enable loginto-agent.service && systemctl --user start loginto-agent.service');
    process.exit(1);
  }

  console.log('');
  console.log('   systemd user service installed and started!');
  console.log('');
  console.log('   Manage with:');
  console.log('     Status:     systemctl --user status loginto-agent');
  console.log('     Stop:       systemctl --user stop   loginto-agent');
  console.log('     Disable:    systemctl --user disable loginto-agent');
  console.log('     Logs:       journalctl --user -u loginto-agent -f');
  console.log('');
}
