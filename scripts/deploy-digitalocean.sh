#!/bin/bash

# ═══════════════════════════════════════════════════════════
# LogInTo — DigitalOcean Droplet Deployment
#
# Run this ON your DigitalOcean droplet to set up LogInTo
# as a persistent service with Nginx + SSL on your subdomain.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Illuminaticonsulting/loginto/main/scripts/deploy-digitalocean.sh | bash -s -- YOUR_SUBDOMAIN
#
# Example:
#   bash deploy-digitalocean.sh remote.yourdomain.com
# ═══════════════════════════════════════════════════════════

set -e

DOMAIN=${1:-""}

if [ -z "$DOMAIN" ]; then
  echo ""
  echo "❌ Please provide your subdomain"
  echo "   Usage: bash deploy-digitalocean.sh remote.yourdomain.com"
  echo ""
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════"
echo "   🖥️  LogInTo — DigitalOcean Setup"
echo "   Domain: $DOMAIN"
echo "═══════════════════════════════════════════"
echo ""

# ─── Install Node.js ───────────────────────────────────
echo "📦 Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
echo "   ✅ Node.js $(node --version)"

# ─── Install Nginx ─────────────────────────────────────
echo ""
echo "📦 Installing Nginx..."
apt-get install -y nginx
systemctl enable nginx
echo "   ✅ Nginx installed"

# ─── Install Certbot (Let's Encrypt SSL) ──────────────
echo ""
echo "📦 Installing Certbot for free SSL..."
apt-get install -y certbot python3-certbot-nginx
echo "   ✅ Certbot installed"

# ─── Clone LogInTo ─────────────────────────────────────
echo ""
echo "📦 Cloning LogInTo..."
mkdir -p /opt
cd /opt
if [ -d "loginto" ]; then
  cd loginto && git pull
else
  git clone https://github.com/Illuminaticonsulting/loginto.git
  cd loginto
fi
npm install --production
echo "   ✅ LogInTo installed to /opt/loginto"

# ─── Create .env ───────────────────────────────────────
if [ ! -f .env ]; then
  echo ""
  read -p "   Set your access password: " ACCESS_PASSWORD
  SESSION_SECRET=$(openssl rand -hex 32)

  cat > .env << ENVEOF
ACCESS_PASSWORD=${ACCESS_PASSWORD}
PORT=3456
SESSION_SECRET=${SESSION_SECRET}
CAPTURE_QUALITY=60
CAPTURE_FPS=15
CAPTURE_SCALE=0.5
MAX_LOGIN_ATTEMPTS=5
LOCKOUT_MINUTES=15
ENVEOF

  echo "   ✅ Configuration saved"
fi

# ─── Create systemd service ───────────────────────────
echo ""
echo "📦 Creating system service..."
cat > /etc/systemd/system/loginto.service << SVCEOF
[Unit]
Description=LogInTo Remote Desktop
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/loginto
ExecStart=$(which node) src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable loginto
systemctl start loginto
echo "   ✅ LogInTo service started"

# ─── Configure Nginx reverse proxy ────────────────────
echo ""
echo "📦 Configuring Nginx for $DOMAIN..."
cat > /etc/nginx/sites-available/loginto << NGXEOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
NGXEOF

ln -sf /etc/nginx/sites-available/loginto /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "   ✅ Nginx configured"

# ─── SSL Certificate ──────────────────────────────────
echo ""
echo "📦 Getting SSL certificate from Let's Encrypt..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
echo "   ✅ SSL certificate installed"

# ─── Firewall ─────────────────────────────────────────
echo ""
echo "📦 Configuring firewall..."
ufw allow 'Nginx Full'
ufw allow OpenSSH
echo "y" | ufw enable 2>/dev/null || true
echo "   ✅ Firewall configured"

# ─── Done ──────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "   🎉 LogInTo is LIVE!"
echo ""
echo "   📱 Open on your phone:"
echo "   https://$DOMAIN"
echo ""
echo "   Useful commands:"
echo "   systemctl status loginto    # Check status"
echo "   systemctl restart loginto   # Restart"
echo "   journalctl -u loginto -f    # View logs"
echo "   nano /opt/loginto/.env      # Edit config"
echo "═══════════════════════════════════════════"
echo ""
