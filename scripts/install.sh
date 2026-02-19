#!/bin/bash

# ═══════════════════════════════════════════════════════════
# LogInTo — One-Command Installer
# Installs Node.js (if needed), dependencies, and runs setup
# ═══════════════════════════════════════════════════════════

set -e

echo ""
echo "═══════════════════════════════════════════"
echo "   🖥️  LogInTo — Installer"
echo "═══════════════════════════════════════════"
echo ""

# ─── Check for Homebrew ────────────────────────────────
install_homebrew() {
  if ! command -v brew &> /dev/null; then
    echo "📦 Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Add to path
    if [[ $(uname -m) == "arm64" ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
      echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
    else
      eval "$(/usr/local/bin/brew shellenv)"
    fi
    echo "   ✅ Homebrew installed"
  else
    echo "   ✅ Homebrew found"
  fi
}

# ─── Check for Node.js ────────────────────────────────
install_node() {
  if ! command -v node &> /dev/null; then
    echo "📦 Installing Node.js..."
    brew install node
    echo "   ✅ Node.js $(node --version) installed"
  else
    echo "   ✅ Node.js $(node --version) found"
  fi
}

# ─── Check for cloudflared (optional) ──────────────────
install_cloudflared() {
  if ! command -v cloudflared &> /dev/null; then
    echo ""
    echo "📦 Installing Cloudflare Tunnel (for remote access)..."
    brew install cloudflared
    echo "   ✅ cloudflared installed"
  else
    echo "   ✅ cloudflared found"
  fi
}

# ─── Main ──────────────────────────────────────────────

cd "$(dirname "$0")/.."

echo "📋 Step 1: Installing system dependencies"
echo ""

install_homebrew
install_node

echo ""
echo "📋 Step 2: Installing npm packages"
echo ""

npm install

echo ""
echo "📋 Step 3: Optional — Cloudflare Tunnel"
echo ""

read -p "   Install cloudflared for remote access? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  install_cloudflared
fi

echo ""
echo "📋 Step 4: Configuration"
echo ""

# Run the setup wizard
node scripts/setup.js

echo ""
echo "═══════════════════════════════════════════"
echo "   🎉 All done! Start with:"
echo ""
echo "   cd $(pwd)"
echo "   npm start"
echo "═══════════════════════════════════════════"
echo ""
