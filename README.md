# 🖥️ LogInTo — Remote Desktop from Your Phone

Control your laptop from your phone's browser. No cloud, no subscription, no account.

## Quick Start (3 minutes)

```bash
# 1. Install dependencies
cd loginto
npm install

# 2. Run setup wizard (set your password)
npm run setup

# 3. Start the server
npm start

# 4. Open the URL on your phone (shown in terminal)
```

## How It Works

```
Your Phone (browser) ←→ Your Laptop (this app)
```

1. This app runs on your laptop and captures your screen
2. Open the web URL on your phone
3. Enter your password
4. See your desktop + control it with touch

## Same WiFi Access

When your phone and laptop are on the **same WiFi network**, just open the Network URL shown in the terminal (e.g., `http://192.168.1.100:3456`).

## Remote Access (from anywhere)

To access your laptop from outside your home network:

```bash
# Start the remote tunnel
npm run tunnel
```

This creates a secure Cloudflare tunnel. You'll get a URL like:
`https://random-words.trycloudflare.com`

Open that on your phone from anywhere in the world.

### Tunnel Options

| Method | Setup | Cost |
|--------|-------|------|
| **Cloudflare Tunnel** | `brew install cloudflared` | Free |
| **Tailscale** | Install on both devices | Free |
| **localtunnel** | Built-in (npm) | Free |

## Touch Controls

| Gesture | Action |
|---------|--------|
| **Tap** | Left click |
| **Double-tap** | Double-click |
| **Long press** (500ms) | Right-click |
| **Drag finger** | Move mouse |
| **Two-finger scroll** | Scroll |
| **⚙️ button** | Open settings toolbar |

## Settings

Edit `.env` to change:

| Setting | Default | Description |
|---------|---------|-------------|
| `ACCESS_PASSWORD` | changeme123 | Your login password |
| `PORT` | 3456 | Server port |
| `CAPTURE_QUALITY` | 60 | JPEG quality (10-100) |
| `CAPTURE_FPS` | 15 | Frames per second (1-30) |
| `CAPTURE_SCALE` | 0.5 | Resolution scale (0.1-1.0) |

**Tuning tips:**
- Slow connection? Lower quality to 30-40 and FPS to 5-10
- Fast connection? Raise quality to 80+ and FPS to 24-30
- Scale of 0.5 = half resolution (fastest). Scale 1.0 = full resolution.

## macOS Permissions

On macOS, you need to grant:

1. **Screen Recording**: System Settings → Privacy & Security → Screen Recording → add Terminal
2. **Accessibility**: System Settings → Privacy & Security → Accessibility → add Terminal

## Requirements

- Node.js 18+
- macOS, Linux, or Windows
- Phone with a modern browser (Chrome, Safari, Firefox)

## Security

- Password-protected (bcrypt hashed)
- Rate-limited login (5 attempts, then 15-min lockout)
- All traffic encrypted over HTTPS when using tunnel
- Sessions expire after 24 hours
- Only 1 viewer at a time

## Deploy to DigitalOcean (Your Own Subdomain)

Want a permanent URL like `remote.yourdomain.com`? Deploy to your DigitalOcean droplet:

### Step 1: Add a DNS subdomain

In your DigitalOcean dashboard (or wherever your DNS is managed):
1. Go to **Networking** → **Domains** → your domain
2. Add an **A record**:
   - Hostname: `remote` (or whatever subdomain you want)
   - Points to: your droplet's IP address
   - TTL: 3600

### Step 2: Deploy to your droplet

SSH into your droplet and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Illuminaticonsulting/loginto/main/scripts/deploy-digitalocean.sh | bash -s -- remote.yourdomain.com
```

This automatically:
- Installs Node.js, Nginx
- Clones the repo and installs dependencies
- Sets up Nginx reverse proxy with WebSocket support
- Gets a free SSL certificate from Let's Encrypt
- Creates a systemd service (auto-restarts)

### Step 3: Open on your phone

Go to `https://remote.yourdomain.com` and log in.

### Manage the service

```bash
systemctl status loginto      # Check if running
systemctl restart loginto     # Restart
journalctl -u loginto -f      # View live logs
nano /opt/loginto/.env        # Change password/settings
```

---

## Troubleshooting

**"Screen capture error"**
→ Grant Screen Recording permission (macOS) or check display server (Linux)

**Mouse/keyboard not working**
→ Grant Accessibility permission (macOS) or install xdotool (Linux)

**High latency**
→ Lower quality and FPS in the toolbar settings

**Can't connect from phone**
→ Make sure both devices are on same WiFi, or use `npm run tunnel`
