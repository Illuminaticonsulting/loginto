#!/usr/bin/env node

/**
 * LogInTo — Tunnel Script
 *
 * Creates a secure tunnel to access your desktop from anywhere.
 * Supports:
 * 1. Cloudflare Tunnel (cloudflared) — recommended, free
 * 2. localtunnel — npm-based fallback
 * 3. Manual instructions for Tailscale
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || 3456;

function checkCommand(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function startTunnel() {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('   🌐 LogInTo — Remote Access Tunnel');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // Try Cloudflare Tunnel first
  if (checkCommand('cloudflared')) {
    console.log('   Using: Cloudflare Tunnel (recommended)');
    console.log('   Creating secure tunnel...\n');

    const tunnel = spawn('cloudflared', [
      'tunnel', '--url', `http://localhost:${PORT}`
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let urlFound = false;

    tunnel.stderr.on('data', (data) => {
      const output = data.toString();
      // Cloudflare outputs the URL to stderr
      const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !urlFound) {
        urlFound = true;
        console.log('   ✅ Tunnel is live!\n');
        console.log('   ┌─────────────────────────────────────────┐');
        console.log(`   │  📱 Open on your phone:                  │`);
        console.log(`   │  ${urlMatch[0]}  │`);
        console.log('   └─────────────────────────────────────────┘');
        console.log('');
        console.log('   This URL is temporary and changes each time.');
        console.log('   Press Ctrl+C to stop the tunnel.\n');
      }
    });

    tunnel.on('close', (code) => {
      console.log('\n   Tunnel closed.');
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      tunnel.kill();
      process.exit();
    });

    return;
  }

  // Try localtunnel
  console.log('   ⚠️  cloudflared not found.');
  console.log('');
  console.log('   Option 1: Install Cloudflare Tunnel (recommended)');
  console.log('   ─────────────────────────────────────────');

  const platform = process.platform;
  if (platform === 'darwin') {
    console.log('     brew install cloudflared');
  } else if (platform === 'linux') {
    console.log('     curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared');
    console.log('     chmod +x /usr/local/bin/cloudflared');
  } else {
    console.log('     Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/');
  }

  console.log('');
  console.log('   Option 2: Use localtunnel (npm)');
  console.log('   ─────────────────────────────────────────');
  console.log(`     npx localtunnel --port ${PORT}`);
  console.log('');
  console.log('   Option 3: Use Tailscale (VPN-based)');
  console.log('   ─────────────────────────────────────────');
  console.log('     Install Tailscale on both laptop and phone');
  console.log('     https://tailscale.com/download');
  console.log(`     Then access: http://<tailscale-ip>:${PORT}`);
  console.log('');

  // Try using npx localtunnel as immediate fallback
  console.log('   Attempting localtunnel fallback...\n');

  try {
    const lt = spawn('npx', ['-y', 'localtunnel', '--port', PORT.toString()], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    lt.stdout.on('data', (data) => {
      const output = data.toString();
      const urlMatch = output.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        console.log('   ✅ Tunnel is live!\n');
        console.log('   ┌─────────────────────────────────────────┐');
        console.log(`   │  📱 Open on your phone:                  │`);
        console.log(`   │  ${urlMatch[0]}`);
        console.log('   └─────────────────────────────────────────┘');
        console.log('');
        console.log('   Note: You may need to click through a');
        console.log('   confirmation page on first visit.');
        console.log('   Press Ctrl+C to stop.\n');
      }
    });

    lt.stderr.on('data', (data) => {
      // Silently handle
    });

    lt.on('close', () => {
      console.log('\n   Tunnel closed.');
    });

    process.on('SIGINT', () => {
      lt.kill();
      process.exit();
    });

  } catch (err) {
    console.log('   ❌ localtunnel failed. Please install cloudflared manually.');
    process.exit(1);
  }
}

startTunnel().catch(console.error);
