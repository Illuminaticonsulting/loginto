# LogInTo — Remote Desktop Web App
## Full Feasibility Report: Build, Run & Monetize

---

## 1. EXECUTIVE SUMMARY

**What you want to build:** A web-based remote desktop application (like LogMeIn) that lets you control your laptop screen from your phone via a browser.

**Is it feasible?** Yes — and the technology stack to do it is mature and largely open-source. The core challenge isn't "can it be done" but "can it compete and make money."

**Estimated MVP timeline:** 2-4 months (solo developer)
**Estimated MVP cost:** $0-20/month infrastructure
**Monetization potential:** Strong — remote desktop is a $3B+ market with proven willingness to pay $10-50/month per user.

---

## 2. HOW IT WORKS (Architecture)

### The Three Pieces

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   PHONE/TABLET   │◄──────►│   CLOUD SERVERS   │◄──────►│  LAPTOP/DESKTOP │
│  (Web Browser)   │  WebRTC │  (Signaling +     │  WebRTC │  (Desktop Agent)│
│                  │  Stream │   TURN Relay)     │  Stream │                 │
│ - Views screen   │        │ - Brokers the     │        │ - Captures      │
│ - Sends input    │        │   connection      │        │   screen        │
│ - Touch controls │        │ - Relays traffic  │        │ - Encodes video │
│                  │        │   when P2P fails  │        │ - Injects input │
└─────────────────┘         └──────────────────┘         └─────────────────┘
```

### How a Connection Happens (Step-by-Step)

1. **Install the desktop agent** on your laptop (small app running in background)
2. **Open the web app** on your phone's browser and log in
3. **Phone asks the signaling server**: "I want to connect to laptop XYZ"
4. **Signaling server brokers a handshake** between phone and laptop via WebRTC
5. **Direct peer-to-peer connection** is established (~60% of the time)
6. If P2P fails (firewalls/NAT), traffic routes through a **TURN relay server** (~40% of the time)
7. **Laptop streams its screen** as encoded video (H.264) to the phone
8. **Phone sends back inputs** (touch → mouse movement, keyboard, gestures)

### Core Technology: WebRTC

WebRTC (Web Real-Time Communication) is the backbone. It's:
- Built into every modern browser (no plugins needed)
- Peer-to-peer by default (saves server costs)
- Encrypted end-to-end (DTLS + SRTP)
- Supports video, audio, and data channels

---

## 3. WHAT NEEDS TO BE BUILT

### Component 1: Web Client (Phone/Browser UI)

| Aspect | Detail |
|--------|--------|
| **Purpose** | View remote screen, send inputs |
| **Tech** | React + WebRTC APIs + Socket.IO |
| **Features** | Touch-to-mouse mapping, virtual keyboard, pinch-to-zoom, gesture controls |
| **Hosting** | Vercel or Cloudflare Pages (free) |
| **Effort** | 3-4 weeks |

### Component 2: Desktop Agent (Laptop App)

| Aspect | Detail |
|--------|--------|
| **Purpose** | Capture screen, encode video, receive and inject inputs |
| **Tech (MVP)** | Electron (JavaScript-based, cross-platform) |
| **Tech (Production)** | Rust or Go (better performance, smaller binary) |
| **Features** | Screen capture, H.264 encoding, mouse/keyboard injection, auto-update |
| **Effort** | 4-6 weeks |

### Component 3: Signaling Server

| Aspect | Detail |
|--------|--------|
| **Purpose** | Broker WebRTC connections between devices |
| **Tech** | Node.js + Socket.IO + Express |
| **Hosting** | Railway or Render ($5-15/month) |
| **Effort** | 1-2 weeks |

### Component 4: TURN/STUN Infrastructure

| Aspect | Detail |
|--------|--------|
| **Purpose** | NAT traversal — ensure connections work behind firewalls |
| **STUN** | Free (Google/Cloudflare public servers) |
| **TURN (MVP)** | Xirsys free tier (5GB/month) |
| **TURN (Production)** | Metered.ca ($99/month) or self-hosted Coturn |
| **Effort** | 1 week setup |

### Component 5: Auth & User Management

| Aspect | Detail |
|--------|--------|
| **Purpose** | User accounts, device pairing, session management |
| **Tech** | Supabase Auth + PostgreSQL (free tier) |
| **Features** | Email/password, MFA (TOTP), device registration |
| **Effort** | 1-2 weeks |

---

## 4. KEY FEATURES TO BUILD

### MVP (Must-Have)

- [ ] Remote screen viewing from phone browser
- [ ] Touch-to-mouse input mapping
- [ ] Virtual keyboard overlay
- [ ] Secure encrypted connection (TLS + DTLS)
- [ ] User authentication with MFA
- [ ] Device pairing via code/QR
- [ ] Auto-reconnect on network change
- [ ] Cross-platform desktop agent (macOS + Windows)

### Phase 2 (Competitive Features)

- [ ] File transfer between devices
- [ ] Clipboard sync (copy on laptop, paste on phone)
- [ ] Multi-monitor support
- [ ] Session recording
- [ ] Audio forwarding
- [ ] Wake-on-LAN (turn on laptop remotely)
- [ ] Unattended access (connect without someone at the laptop)

### Phase 3 (Monetization Features)

- [ ] Team management dashboard
- [ ] Admin console with audit logs
- [ ] HIPAA/GDPR compliance tools
- [ ] White-label/branding options
- [ ] API access for integrations
- [ ] Priority relay servers for paid users

---

## 5. INFRASTRUCTURE COSTS

### Monthly Cost Breakdown by Scale

| Scale | Signaling | TURN Relay | Auth/DB | Frontend | **Total** |
|-------|-----------|------------|---------|----------|-----------|
| **Dev/Testing** (you alone) | $0 (local) | $0 (Xirsys free) | $0 (Supabase free) | $0 (Vercel free) | **$0/mo** |
| **MVP Launch** (1-50 users) | $5 (Railway) | $0-10 (Xirsys free/pro) | $0 (Supabase free) | $0 (Vercel free) | **$5-15/mo** |
| **Early Growth** (50-500 users) | $15 (Railway) | $40-100 (Xirsys/Metered) | $25 (Supabase Pro) | $0 (Vercel free) | **$80-140/mo** |
| **Growth** (500-1,000 users) | $20 (VPS) | $200-500 (Metered) | $25 (Supabase) | $20 (Vercel Pro) | **$265-565/mo** |
| **Scale** (1,000-5,000 users) | $50 (scaled) | $500-2,000 (multi-region) | $100 (DB scaling) | $20 | **$670-2,170/mo** |
| **Large** (10,000+ users) | $200 | $5,000-20,000 | $300 | $50 | **$5,550-20,550/mo** |

### Why TURN Relay is the Biggest Cost

- ~40% of all connections require a TURN relay (symmetric NAT, corporate firewalls)
- Each remote desktop session uses ~2-5 Mbps continuously
- Managed TURN pricing: **$0.40-$0.80 per GB** (Twilio rates)
- 1 hour of remote desktop at 3 Mbps = ~1.35 GB = **$0.54-$1.08 per session-hour**

### Cost Optimization Strategies

1. **Maximize P2P connections** — better STUN implementation reduces TURN usage
2. **Adaptive bitrate** — lower quality on bad connections saves bandwidth
3. **Self-host Coturn** at scale — drops relay cost to ~$0.01-0.05/GB
4. **Regional TURN servers** — deploy close to users for lower latency
5. **Idle detection** — reduce stream quality when no activity

---

## 6. COMPETITIVE LANDSCAPE & PRICING

### What Competitors Charge (2026)

| Product | Free Tier? | Starting Price | Target Market |
|---------|-----------|---------------|---------------|
| **LogMeIn Pro** | No | $30/mo (2 devices) | Individuals, SMBs |
| **TeamViewer** | Personal use | $299/year | Enterprise, business |
| **AnyDesk** | Personal use | $239/year | Distributed workforce |
| **Parsec** | Yes (personal) | $9.99/mo | Gamers, creatives |
| **Splashtop** | No | $8.25/mo/user | Business, IT, education |
| **Chrome Remote Desktop** | Yes (fully free) | Free | Casual users |
| **RustDesk** | Yes (open source) | Free (self-hosted) | Privacy-focused, technical |

### Key Takeaways

- **There IS room** in the market — LogMeIn alienated users with price hikes, TeamViewer is expensive
- **Chrome Remote Desktop is free** but limited (no file transfer, no mobile control, basic)
- **Parsec proved** a focused niche (gaming) can succeed at $10/mo
- **RustDesk proves** open-source + self-hosted is growing in demand

---

## 7. MONETIZATION STRATEGY

### Recommended Pricing Model: Freemium + Tiered

#### Free Tier (User Acquisition)
- 1 device connection
- 30-minute session limit
- Basic screen viewing + control
- Community support
- **Purpose:** Get users in the door, build word-of-mouth

#### Pro Tier — $12.99/month ($9.99/month annual)
- Up to 5 devices
- Unlimited session duration
- File transfer
- Clipboard sync
- Audio forwarding
- Priority relay servers
- Email support

#### Business Tier — $29.99/month per user ($24.99/month annual)
- Unlimited devices
- Team management dashboard
- Session recording
- Audit logs
- Admin controls
- Unattended access
- Priority support

#### Enterprise — Custom Pricing
- HIPAA/GDPR compliance
- White-label branding
- SSO integration
- Dedicated relay infrastructure
- SLA guarantees
- On-premises option

### Revenue Projections

| Scenario | Users | Conversion | ARPU | Monthly Revenue | Monthly Cost | **Net Profit** |
|----------|-------|-----------|------|----------------|-------------|----------------|
| **Year 1** | 500 free, 50 paid | 10% | $12.99 | $650 | $140 | **$510** |
| **Year 2** | 2,000 free, 300 paid | 15% | $15 | $4,500 | $800 | **$3,700** |
| **Year 3** | 10,000 free, 1,500 paid | 15% | $18 | $27,000 | $5,000 | **$22,000** |

*ARPU = Average Revenue Per User (blend of Pro + Business tiers)*

### Additional Revenue Streams

1. **White-label licensing** — Sell the platform to MSPs/IT companies ($500-2,000/month)
2. **API access** — Charge developers to embed remote desktop in their apps
3. **One-time access codes** — Pay-per-use model for IT support ($2-5 per session)
4. **Premium add-ons** — Session recording storage, multi-monitor, 4K streaming

---

## 8. SECURITY REQUIREMENTS

### Non-Negotiable Security Features

| Feature | Implementation | Why It Matters |
|---------|---------------|----------------|
| **End-to-end encryption** | TLS 1.3 + DTLS/SRTP (built into WebRTC) | Prevents eavesdropping on screen content |
| **Multi-factor auth (MFA)** | TOTP (Google Authenticator compatible) | Prevents unauthorized access if password leaked |
| **Device verification** | Cryptographic device fingerprints | Ensures only authorized devices connect |
| **Session tokens** | JWT with short expiry + refresh rotation | Prevents session hijacking |
| **Connection approval** | Pop-up on desktop to approve incoming connections | Prevents unauthorized remote access |
| **Screen privacy** | Blur/black screen on host during remote session (optional) | Protects against shoulder surfing |
| **Audit logging** | Timestamped connection logs | Accountability and compliance |

### Compliance (If Targeting Enterprise)

- **HIPAA** — Required for healthcare clients (encryption, audit trails, BAAs)
- **GDPR** — Required for EU users (data minimization, right to erasure)
- **SOC 2** — Trust signal for business customers

---

## 9. DEVELOPMENT ROADMAP

### Phase 1: Prototype (Weeks 1-6)

```
Week 1-2: Signaling server + basic WebRTC connection
Week 3-4: Desktop agent (Electron) with screen capture
Week 5-6: Web client with touch controls + auth
```

**Deliverable:** Working demo — connect from phone browser to laptop, see screen, move mouse

**Tech Stack:**
```
Frontend:     React + Vite + simple-peer + Socket.IO client
Backend:      Node.js + Express + Socket.IO
Desktop:      Electron + desktopCapturer
Auth:         Supabase Auth (free tier)
TURN/STUN:    Xirsys (free tier)
Hosting:      Vercel (frontend) + Railway (backend)
```

### Phase 2: MVP (Weeks 7-12)

```
Week 7-8:  Virtual keyboard + improved touch controls
Week 9-10: File transfer + clipboard sync
Week 11-12: Device management + connection history + QR pairing
```

**Deliverable:** Usable product for beta testers

### Phase 3: Launch Prep (Weeks 13-18)

```
Week 13-14: Payment integration (Stripe)
Week 15-16: Auto-update system for desktop agent
Week 17-18: Landing page, docs, onboarding flow
```

**Deliverable:** Public launch with free + paid tiers

### Phase 4: Growth (Months 5-12)

```
- Multi-monitor support
- Session recording
- Audio forwarding
- Team/admin features
- Windows + macOS + Linux agents
- Performance optimization (Rust rewrite of hot paths)
- Mobile native apps (iOS/Android) for hosting
```

---

## 10. RISKS & CHALLENGES

### Technical Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Latency > 150ms** | High | Regional TURN servers, adaptive bitrate, codec optimization |
| **Mobile browser limitations** | Medium | Phone can only VIEW, not HOST — this is fine for the use case |
| **Corporate firewalls blocking WebRTC** | Medium | TURN-TLS on port 443 (looks like HTTPS traffic) |
| **Cross-platform screen capture** | Medium | Start with macOS only, expand to Windows |
| **Electron bundle size (~100MB)** | Low | Accept for MVP, rewrite in Tauri/Rust later |

### Business Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Google makes Chrome Remote Desktop better** | High | Differentiate with features (file transfer, teams, mobile UX) |
| **TURN costs spike at scale** | High | Self-host Coturn, optimize P2P ratio |
| **Security breach** | Critical | E2E encryption, regular security audits, bug bounty program |
| **User acquisition cost** | Medium | Content marketing, developer community, product-led growth |
| **Established competitor brand loyalty** | Medium | Target underserved niches (Mac users, privacy-conscious, indie devs) |

---

## 11. COMPETITIVE ADVANTAGE OPPORTUNITIES

### Where to Differentiate

1. **Privacy-first** — End-to-end encrypted, no data stored on servers (unlike LogMeIn)
2. **No install on phone** — Pure web app, works instantly from any browser
3. **Modern UX** — Most remote desktop apps have dated interfaces
4. **Developer-friendly** — API access, CLI tools, scriptable connections
5. **Transparent pricing** — No price hike surprises (a real pain point with LogMeIn)
6. **Open-source core** — Build trust, attract contributors, reduce churn
7. **Mac-first** — Most competitors are Windows-focused; macOS users are underserved
8. **Self-hostable option** — Appeal to privacy/security-conscious users and enterprises

---

## 12. DECISION MATRIX: BUILD vs. FORK vs. USE EXISTING

| Approach | Pros | Cons | Recommended? |
|----------|------|------|-------------|
| **Build from scratch** | Full control, custom UX, own IP | Slowest, most expensive | For unique features |
| **Fork RustDesk** | Mature codebase, proven architecture | Rust learning curve, GPL license constraints | Best balance |
| **Build on Apache Guacamole** | Enterprise-ready, supports RDP/VNC/SSH | Gateway architecture (not P2P), higher server costs | For enterprise pivot |
| **WebRTC + Electron hybrid** | Fast to build, JavaScript ecosystem | Electron is heavy, performance ceiling | Best for MVP |

### Recommended Path: **WebRTC + Electron for MVP → Rust rewrite for production**

---

## 13. SUMMARY & RECOMMENDATION

### Can you build this? **Yes.**

The technology exists, the costs are manageable at small scale, and there's a proven market willing to pay.

### Should you build this? **Yes, with focus.**

Don't try to compete with TeamViewer/LogMeIn on every feature. Pick a niche:

- **Best option:** "The remote desktop app that just works from your phone browser" — focus on mobile-first UX
- **Alternative niche:** Privacy-first, self-hostable remote desktop (compete with RustDesk but with better UX)
- **Alternative niche:** Mac-first remote desktop (underserved market)

### What it will cost to get started:

| Item | Cost |
|------|------|
| Infrastructure (first 6 months) | $0-90 total |
| Apple Developer Account (for macOS signing) | $99/year |
| Domain name | $12/year |
| Stripe fees | 2.9% + $0.30 per transaction |
| **Total to launch** | **~$150-200** |

### What it could make:

- **Month 6:** $500-1,000/month (50-100 paying users)
- **Year 1:** $3,000-5,000/month (300-500 paying users)
- **Year 2:** $15,000-30,000/month (1,000-2,000 paying users)

These numbers assume good execution, product-market fit, and a differentiated niche.

---

*Report prepared for the LogInTo project — February 2026*
