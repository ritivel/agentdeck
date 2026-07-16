# AgentDeck

One deck for all your coding agents — **Claude Code**, **Cursor**, and **Codex** — on your
**Mac menu bar** and your **iPhone**.

Your agents keep running on your Mac, in your repos, with your credentials. AgentDeck shows
every session — including ones you started in a terminal, IDE, or the Codex desktop app —
live in one place: chat with them, start new ones, interrupt them, get notified when they
finish or get blocked, and hand sessions between your Mac and your phone.

## Install

### The Mac app (easiest)

Download **AgentDeck-mac.zip** from the
[latest release](https://github.com/ritivel/agentdeck/releases/latest), unzip, and drag
**AgentDeck.app** to Applications. That's it — the app ships its own bridge runtime
(no Node.js required), lives in your menu bar, and:

- starts/supervises the bridge daemon (toggle **Launch at Login** in Settings)
- shows all sessions across the three platforms; click any to chat
- shows a **QR code** to pair your iPhone (menu bar → *Pair iPhone…*)

> First launch on a fresh Mac: right-click → Open (the app is ad-hoc signed, not notarized yet).

### Or the CLI (for terminal people)

```bash
curl -fsSL https://raw.githubusercontent.com/ritivel/agentdeck/main/install.sh | bash
```

This installs the `agentdeck` command (needs Node 22.5+), registers a login service
(`agentdeck service install`), and prints the pairing QR (`agentdeck pair`). One of the
agent CLIs (`claude`, `cursor-agent`, `codex`) should be installed and logged in.

### Any phone, any distance — the mobile web app

No install at all: the bridge serves a mobile web app. On the same Wi-Fi, `agentdeck pair`
prints an `http://<mac>:8787/?token=…` link any phone can open. For **anywhere in the
world** (internet on both sides is enough):

```bash
brew install cloudflared   # once
agentdeck share            # prints a public https URL + QR
```

`share` opens a Cloudflare quick tunnel to your bridge and prints a link like
`https://<random>.trycloudflare.com/?token=…` — scan the QR with any phone camera
(iPhone *or* Android) and you get the full deck: live sessions, chat, new sessions,
interrupts, notifications. Treat the link like a password (it contains your token); the
URL rotates every run. Ctrl-C closes the tunnel.

### The iPhone app

Until it's on TestFlight, build it on-device with a free Apple ID:

```bash
cd ios && xcodegen generate && open AgentDeck.xcodeproj
```

Select your personal team under *Signing & Capabilities*, plug in your iPhone, press Run.
Then scan the QR from the Mac app (or the `agentdeck pair` output). On the same Wi-Fi the
app also discovers the bridge automatically via Bonjour.

**Remote access from anywhere:** install [Tailscale](https://tailscale.com) on both
devices, then connect the app to your Mac's tailnet name. No port forwarding — never expose
the bridge port to the raw internet.

## What you can do

- **See everything.** The bridge watches each agent's on-disk transcript store, so sessions
  you started in a terminal, in your IDE, or in the Codex desktop app appear automatically
  with a LIVE badge and stream in real time. Zero setup.
- **Chat from either screen.** Start sessions from the Mac app or the phone, in any project
  directory, with a chosen permission mode. Interrupt mid-turn. Notifications fire when an
  agent finishes, errors, or gets blocked on permissions.
- **Take over a terminal session** by just messaging it — the bridge resumes the same
  conversation as its own process (`claude --resume` / `cursor-agent --resume` /
  `codex exec resume`), history intact.
- **Hand back to the terminal** with `agentdeck resume` (or *Copy Resume Command* in the
  app). Session ids stay stable across hops; open views re-point automatically.
- **True both-screens mode:** run `agentdeck claude` instead of `claude` — the same
  interactive TUI, but phone messages are typed into your terminal and replies stream to
  both screens. `alias claude="agentdeck claude"` if you want this always.

## How it works

```
┌──────────────┐                       ┌───────────────────────────────────────┐
│  iOS app     │   WebSocket (LAN /    │  your Mac                             │
│  (SwiftUI)   │ ◄───── Tailscale) ──► │  ┌─────────────────────────────────┐  │
└──────────────┘   Bonjour + QR/token  │  │ bridge daemon (Node/TS)         │  │
┌──────────────┐                       │  │  ├─ spawns: claude / cursor-    │  │
│  Mac app     │ ◄── localhost ──────► │  │  │  agent / codex (JSON modes)  │  │
│  (menu bar,  │                       │  │  └─ mirrors: ~/.claude, ~/.codex,│ │
│   SwiftUI)   │   manages the daemon  │  │     ~/.cursor transcript stores │  │
└──────────────┘                       │  └─────────────────────────────────┘  │
                                       └───────────────────────────────────────┘
```

- **bridge/** — Node/TypeScript daemon. Spawns and manages agent CLI processes through
  thin protocol-based adapters (no output scraping), normalizes their events into one
  schema, and serves them over an authenticated WebSocket. See [PROTOCOL.md](PROTOCOL.md).
- **ios/** — SwiftUI iPhone app. Bonjour discovery, QR pairing, live transcripts,
  notifications. Shares its models/client/transcript views with the Mac app.
- **macos/** — SwiftUI menu bar app. Bundles the bridge + a Node runtime into
  `AgentDeck.app/Contents/Resources/bridge`, supervises it, and hosts the same deck UI
  in a native window.

The phone talks **directly to your Mac** — no cloud in the middle. An optional
E2E-encrypted relay (the model proven by [Happy](https://github.com/slopus/happy)) is on
the roadmap.

## Platform support

| Platform | Start / chat / interrupt | Live mirror of external sessions | Take over |
|---|---|---|---|
| Claude Code | ✅ (`claude -p` stream-json, long-lived process) | ✅ `~/.claude/projects/**.jsonl` | ✅ `--resume`, PTY wrapper for both-screens mode |
| Cursor | ✅ (`cursor-agent -p --resume <chatId>` per turn) | ✅ `~/.cursor/chats/**/store.db` (SQLite blob store) | ✅ `--resume` (CLI must be logged in) |
| Codex | ✅ (`codex exec --json`, `resume <threadId>`) | ✅ `~/.codex/sessions/**/rollout-*.jsonl` — including **Codex desktop app** sessions | ✅ `codex exec resume` (CLI required) |

Mirroring is read-only file access, so it works even where the CLI isn't installed or
logged in. Permission modes per session: `acceptEdits` (default), `plan`,
`bypassPermissions`, `manual`; denied tools surface as notifications.

## Building from source

```bash
# bridge
cd bridge && npm ci && npm run dev          # daemon + pairing QR

# iOS + Mac apps (XcodeGen)
cd ios && xcodegen generate
xcodebuild -scheme AgentDeck    -destination 'platform=iOS Simulator,name=iPhone 17' build
xcodebuild -scheme AgentDeckMac -destination 'platform=macOS' build   # bundles the bridge

# tests
cd bridge && npx tsx test/live.mjs          # live-mirror fixtures, no CLIs needed
node test/e2e.mjs claude /tmp/proj "Reply PONG" 8787   # against a running bridge
```

Releases are cut by pushing a `v*` tag — CI builds the Mac app zip + npm tarball and
attaches them to a GitHub Release.

## Repo layout

```
bridge/            Node/TS daemon
  src/adapters/    claude.ts, cursor.ts, codex.ts — one file per platform
  src/live/        discovery + mirroring of terminal-started sessions (one source per platform)
  test/            fixture tests + e2e smoke tests
ios/               SwiftUI iPhone app + the shared models/client (XcodeGen project)
macos/             SwiftUI menu bar app (embeds the bridge)
web/               mobile web app (no build step; served by the bridge, tunneled by `share`)
PROTOCOL.md        the WebSocket protocol all clients implement
install.sh         CLI installer (npm global + launchd service)
```

## Roadmap

- [x] Live discovery + mirroring for all three platforms
- [x] Mac menu bar app with embedded bridge and pairing QR
- [x] Mobile web app + `agentdeck share` (Cloudflare tunnel — any device, any distance)
- [ ] Stable share URL via a named Cloudflare tunnel on your own domain
- [ ] TestFlight distribution for the iOS app
- [ ] Notarized + Homebrew-cask Mac app distribution
- [ ] Approve/deny tool permissions from the phone
- [ ] APNs push (works when the app is backgrounded/closed)
- [ ] E2E-encrypted relay for remote access without Tailscale
- [ ] Android client

## License

MIT
