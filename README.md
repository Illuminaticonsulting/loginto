# 🖥️ LogInTo — Remote Desktop Dashboard

**loginto.kingpinstrategies.com**

Control your laptop from your phone's browser. Two users, password-only login, professional dashboard with real-time connection status.

---

## Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   PHONE/TABLET   │◄───────►│   DASHBOARD       │◄───────►│  LAPTOP/DESKTOP │
│  (Web Browser)   │ Socket  │   SERVER          │ Socket  │  (Desktop Agent)│
│                  │   .IO   │                   │   .IO   │                 │
│ - Views screen   │        │ loginto.kingpin    │        │ - Captures      │
│ - Sends input    │        │ strategies.com     │        │   screen        │
│ - Touch controls │        │                   │        │ - Injects input │
└─────────────────┘         └──────────────────┘         └─────────────────┘
```

## Users

| User     | Password   | Description      |
|----------|------------|------------------|
| Kingpin  | `kingpin`  | Admin user       |
| Tez      | `tez`      | Second user      |

Each user gets a unique Agent Key to pair their laptop.

---

## Quick Start

### 1. Start the Dashboard Server

```bash
cd loginto
npm install
npm start
```

The server starts on `http://localhost:3456`.

### 2. Log In

Open the dashboard URL in your browser and enter your password (`kingpin` or `tez`).

### 3. Set Up the Desktop Agent on Your Laptop

```bash
cd loginto/agent
cp .env.example .env
# Edit .env — paste your Agent Key from the dashboard
npm install
npm start
```

Your dashboard will show **● Online** once the agent connects.

### 4. Connect from Your Phone

Click **"Connect to Desktop"** on the dashboard to open the remote viewer.

---

## Project Structure

```
loginto/
├── src/
│   ├── server.js        # Dashboard relay server (Express + Socket.IO)
│   ├── users.js         # User store (JSON-based, bcrypt passwords)
│   ├── capture.js       # Screen capture module
│   └── input.js         # Mouse/keyboard input handler
├── public/
│   ├── index.html       # Login page
│   ├── dashboard.html   # Dashboard (status + setup instructions)
│   ├── viewer.html      # Remote desktop viewer
│   ├── css/style.css    # Dark theme styling
│   └── js/
│       ├── login.js     # Login logic
│       ├── dashboard.js # Dashboard logic (Socket.IO status)
│       └── viewer.js    # Remote viewer (canvas + touch input)
├── agent/
│   ├── agent.js         # Desktop agent (connects to server)
│   ├── capture.js       # Screen capture
│   ├── input.js         # Input injection
│   ├── package.json     # Agent dependencies
│   └── .env.example     # Agent config template
├── scripts/
│   ├── tunnel.js        # Cloudflare tunnel for remote access
│   ├── setup.js         # Setup wizard
│   └── deploy-digitalocean.sh
├── package.json
├── .env                 # Server config
└── .env.example         # Server config template
```

---

## Touch Controls (Phone Viewer)

| Gesture | Action |
|---------|--------|
| **Tap** | Left click |
| **Double-tap** | Double-click |
| **Long press** (500ms) | Right-click |
| **Drag finger** | Move mouse |
| **Two-finger scroll** | Scroll |
| **⚙️ button** | Settings (quality, FPS) |

---

## Remote Access (Outside Your Network)

```bash
# Start a Cloudflare tunnel
npm run tunnel
```

Or deploy to a server with a permanent URL.

### Deploy to DigitalOcean

1. Point `loginto.kingpinstrategies.com` A record to your droplet IP
2. SSH into the droplet and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Illuminaticonsulting/loginto/main/scripts/deploy-digitalocean.sh | bash -s -- loginto.kingpinstrategies.com
```

This sets up Nginx, SSL (Let's Encrypt), and a systemd service.

---

## macOS Permissions

On macOS, grant these to Terminal (or your terminal app):

- **System Settings → Privacy & Security → Screen Recording**
- **System Settings → Privacy & Security → Accessibility**

---

## Security

- Passwords hashed with bcrypt (12 rounds)
- Rate-limited login (5 attempts → 15 min lockout)
- Sessions expire after 24 hours
- HTTPS when deployed with SSL
- Helmet.js security headers
- Only 1 viewer per user at a time

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Screen capture error | Grant Screen Recording permission (macOS) |
| Mouse/keyboard not working | Grant Accessibility permission (macOS) or install `xdotool` (Linux) |
| High latency | Lower quality/FPS in the viewer toolbar |
| Can't connect from phone | Use same WiFi network, or run `npm run tunnel` |

---

*Kingpin Strategies — loginto.kingpinstrategies.com*
