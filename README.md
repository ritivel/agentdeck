# AgentDeck

Control your local coding agents — **Claude Code**, **Cursor**, and **Codex** — from your phone.

Your agents keep running on your Mac, in your repos, with your credentials. AgentDeck gives you
a deck of them on iOS: swipe **up/down** to switch platforms, swipe **left/right** to switch
between agents/sessions, get notified when an agent finishes or gets blocked, and reply from anywhere.

## How it works

```
┌──────────────┐   WebSocket (LAN / Tailscale)   ┌───────────────────────────────┐
│  iOS app     │ ◄─────────────────────────────► │  bridge daemon (your Mac)     │
│  (SwiftUI)   │      Bonjour discovery +        │  ├─ claude  -p --stream-json  │
│              │      token auth (QR pairing)    │  ├─ cursor-agent -p --resume  │
└──────────────┘                                 │  └─ codex exec --json         │
                                                 └───────────────────────────────┘
```

- **bridge/** — Node/TypeScript daemon. Spawns and manages agent CLI processes through
  thin protocol-based adapters (no output scraping), normalizes their events into one
  schema, and serves them over an authenticated WebSocket. See [PROTOCOL.md](PROTOCOL.md).
- **ios/** — SwiftUI app. Discovers bridges via Bonjour, pairs with a token (QR),
  streams transcripts live, sends prompts/interrupts, fires local notifications on
  turn completion, permission denials, and errors.

### Communication choice

The phone talks **directly to your Mac** — no cloud in the middle:

1. **Same Wi-Fi**: zero config. The bridge advertises `_agentdeck._tcp` via Bonjour and the app finds it.
2. **Anywhere else**: install [Tailscale](https://tailscale.com) on both devices and connect to the
   Mac's tailnet address. Same protocol, zero code difference.
3. (Roadmap) An optional E2E-encrypted relay for no-VPN remote access, following the model
   proven by [Happy](https://github.com/slopus/happy).

## Quick start

### 1. Bridge (on your Mac)

```bash
cd bridge
npm install
npm run dev        # prints a QR code + token
```

Requirements: Node 20+, and at least one agent CLI installed and logged in
(`claude`, `cursor-agent`, or `codex`).

### 2. iOS app

```bash
cd ios
xcodegen generate
open AgentDeck.xcodeproj   # run on simulator or device
```

On first launch, pick your Mac from the discovered list (or enter host/port manually)
and paste the token printed by the bridge.

## Platform adapters

| Platform | Mechanism | Multi-turn | Status |
|---|---|---|---|
| Claude Code | one long-lived `claude -p --input-format stream-json --output-format stream-json` per session; interrupts via the stream-json control protocol | native (same process) | ✅ tested e2e |
| Cursor | `cursor-agent create-chat` once, then `cursor-agent -p --output-format stream-json --resume <chatId>` per turn | via `--resume` | ⚠️ implemented, needs `cursor-agent login` to test |
| Codex | `codex exec --json`, then `codex exec resume <threadId> --json` per turn | via `resume` | ⚠️ implemented, CLI not installed here yet |

Permission handling (MVP): each session is created with a permission mode
(`acceptEdits` default, `plan`, `bypassPermissions`, `manual`). Denied tool calls surface as
`permission.denied` events → phone notifications. Interactive approve-from-phone is on the
roadmap (via a PermissionRequest hook that calls back into the bridge).

## Repo layout

```
bridge/            Node/TS daemon
  src/adapters/    claude.ts, cursor.ts, codex.ts — one file per platform
  test/            e2e smoke tests (drive a real agent through the WebSocket API)
ios/               SwiftUI app (XcodeGen project)
PROTOCOL.md        the WebSocket protocol both sides implement
```

## Live sessions (mirror what's already running)

AgentDeck doesn't only start *new* agents — it also mirrors Claude Code sessions you
started in your **terminal or IDE**. The bridge watches the transcript files Claude Code
writes (`~/.claude/projects/<slug>/<id>.jsonl`), lists every recent session, and tails it
in real time to your phone — marked with a **LIVE** badge and shown read-only. Zero setup;
nothing to enable in your terminal. (Disable with `agentdeck --no-watch`.)

Taking over a live session from the phone (via `claude --resume`) and Codex live sessions
(`~/.codex/sessions/`) are the next steps here.

## Roadmap

- [ ] Take over a live terminal session from the phone (`claude --resume`)
- [ ] Live discovery for Codex (`~/.codex/sessions/`) and Cursor
- [ ] Approve/deny tool permissions from the phone
- [ ] APNs push (works when the app is backgrounded/closed)
- [ ] E2E-encrypted relay for remote access without Tailscale
- [ ] Android client
