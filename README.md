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
  src/live/        discovery + mirroring of terminal-started sessions (one source per platform)
  test/            e2e smoke tests (drive a real agent through the WebSocket API)
ios/               SwiftUI app (XcodeGen project)
PROTOCOL.md        the WebSocket protocol both sides implement
```

## Live sessions (mirror what's already running)

AgentDeck doesn't only start *new* agents — it also mirrors sessions you started in your
**terminal or IDE**, on all three platforms. The bridge watches each CLI's on-disk
transcript store, lists every recent session, and tails it in real time to your phone —
marked with a **LIVE** badge and shown read-only. Zero setup; nothing to enable in your
terminal. (Disable with `agentdeck --no-watch`.)

| Platform | Transcript store watched | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<id>.jsonl` | JSONL, byte-offset tail |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (titles from `~/.codex/session_index.jsonl`) | covers `codex` CLI/TUI **and** the Codex desktop app |
| Cursor | `~/.cursor/chats/<workspace>/<chatId>/store.db` | content-addressed SQLite blob store, polled for new message blobs |

Mirroring is read-only file access, so it works even when the platform's CLI isn't
installed or logged in (e.g. Codex desktop sessions appear without the `codex` CLI).

Any session — spawned or mirrored — can be archived from the phone (long-press a card, or
the `⋯` menu in the chat view); archived sessions stay hidden across bridge restarts unless
their transcript gains new activity. The same menu offers **Copy Resume Command**
(e.g. `claude --resume <id>`) to pick a phone-started session up on your Mac.

Live sessions aren't view-only: **send a message to take one over**. The bridge resumes the
same conversation as its own process (`claude --resume` / `cursor-agent --resume` /
`codex exec resume`), carries the history across, and from then on it behaves like any
phone-started session (requires that platform's CLI to be installed and logged in). Your
terminal keeps its own copy — if you keep typing there, that fork reappears in the deck as
a separate live session.

## Continue on either device (WhatsApp-style)

For true both-screens-at-once chat, start Claude through the wrapper:

```bash
agentdeck claude            # instead of `claude` — same TUI, same everything
```

The wrapper runs the real interactive Claude Code inside a PTY the bridge can type into
(the same architecture Happy and tmux-based remotes use). A message sent from the phone is
injected into your terminal as keystrokes — you literally see it typed — and the reply
streams to both screens. One process, one session, zero forks. Interrupt from the phone
sends Escape. `alias claude="agentdeck claude"` if you want this always.

For sessions started with plain `claude`, ownership hops instead:

- **Terminal → phone**: open the LIVE session in the app and type — sending a message takes
  it over (the bridge resumes it as its own process, history intact).
- **Phone → terminal**: run `agentdeck resume` on the Mac. It grabs your most recent session
  (or `agentdeck resume <title/path fragment>` / `agentdeck sessions` to pick), releases it
  from the bridge, and drops you into `claude --resume` in the session's own working
  directory — under the wrapper, so it stays phone-drivable. Works without a running bridge
  too (falls back to scanning transcripts).

Either way the conversation never leaves a screen: whichever side doesn't own the process
keeps a LIVE mirror, session ids are stable across hops, and open chat views re-point
automatically. `agentdeck resume --print` prints the command instead of running it.

Codex live sessions (`~/.codex/sessions/`) are the next step here.

## Roadmap

- [x] Take over a live terminal session from the phone (`claude --resume`)
- [ ] Live discovery for Codex (`~/.codex/sessions/`) and Cursor
- [ ] Approve/deny tool permissions from the phone
- [ ] APNs push (works when the app is backgrounded/closed)
- [ ] E2E-encrypted relay for remote access without Tailscale
- [ ] Android client
