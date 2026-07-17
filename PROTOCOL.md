# AgentDeck Bridge Protocol v1

The bridge daemon runs on the developer's Mac and exposes a WebSocket API that phone
clients connect to. All messages are JSON, one object per WebSocket text frame.

## Transport & auth

- WebSocket endpoint: `ws://<host>:<port>/ws?token=<token>`
- `GET /health` → `{"ok":true,"name":"<hostname>","version":"..."}` (no auth)
- The token is generated on first run, stored in `~/.agentdeck/token`, and shown as a
  QR code in the terminal. QR payload: `agentdeck://pair?host=<ip>&port=<port>&token=<token>&name=<hostname>`
- Works identically over LAN (Bonjour-discovered) and Tailscale (dial the tailnet IP/host).
- Bonjour service type: `_agentdeck._tcp`, TXT record: `{"name":<hostname>,"v":"1"}`

## Core objects

```jsonc
// SessionInfo
{
  "id": "s_abc123",            // bridge-assigned, stable
  "platform": "claude",        // "claude" | "cursor" | "codex"
  "title": "fix auth bug",     // user-supplied or derived from first prompt
  "cwd": "/Users/me/proj",
  "state": "working",          // "starting"|"idle"|"working"|"error"|"exited"
  "permissionMode": "acceptEdits",
  "nativeSessionId": "504adf8d-...",  // platform's own session/chat/thread id
  "createdAt": 1760000000000,
  "updatedAt": 1760000012345,
  "lastText": "Done — tests pass.",  // last assistant text, for list previews
  "attached": false,                 // true = discovered on disk (started in a terminal), not spawned by the bridge
  "readOnly": false                  // true = bridge mirrors only; prompt/interrupt are rejected
}
```

### Live (attached) sessions

The bridge also discovers sessions started **outside** the bridge — i.e. in a terminal or
IDE — by watching each platform's on-disk transcript store: Claude Code's
`~/.claude/projects/<slug>/<id>.jsonl`, Codex's
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, and Cursor's
`~/.cursor/chats/<workspace>/<chatId>/store.db`. These appear in `session.list`/`welcome` with
`attached: true` and `readOnly: true`, `id` prefixed `live_`, and `permissionMode: "attached"`.
Their transcript is parsed on discovery and tailed in real time, emitting the same `event`
envelopes as spawned sessions. `session.archive` hides the session from the deck until its
transcript gains new activity. Disable discovery with `--no-watch`.

Live sessions running under the `agentdeck claude` PTY wrapper are **writable**
(`readOnly: false`): the wrapper registers with `pty.register { nativeSessionId, cwd }`.
The session then has one owner at a time, and ownership moves like a baton:

- **Phone sends `prompt`** → the server sends the wrapper `pty.handoff { nativeSessionId }`;
  the wrapper stops the local TUI (transcript flushes to disk), replies
  `pty.handoff-ack { nativeSessionId }`, and shows a banner
  ("📱 Session continued from your phone — press any key to take it back"). The server then
  resumes the session itself (`--resume <nativeSessionId>`), seeds it with the mirrored
  transcript, broadcasts `session.takeover { fromSessionId, session }`, and delivers the
  prompt. Prompts arriving mid-handoff queue behind the first. If the wrapper doesn't ack
  within 6s the prompt fails with an `error` (nothing is forked).
- **Terminal takes it back** → any keypress in the wrapper triggers `session.release`; once
  the bridge's process exits, the wrapper respawns the real TUI with `--resume`. The mirror
  resurfaces and clients re-point via the release/takeover broadcasts, as before.
- `prompt` with `mode: "type"` skips the handoff and literally types the text into the
  terminal TUI (bracketed paste + Enter) — the legacy/power path. `interrupt` on a
  wrapper session is always injected as Escape without changing ownership.

Sending `prompt` to a live session **without** a wrapper takes it over the same way, minus
the handoff step: the bridge resumes the session, seeds the transcript, retires the live
entry, and broadcasts `session.takeover`. The terminal's own process is untouched — if it
keeps being used there, it continues as a divergent fork and reappears in the deck as a new
live session. `interrupt` on a wrapperless live session returns an `error`.

```jsonc
// AgentEvent — normalized across platforms; sent in "event" envelopes
{ "kind": "text",       "text": "..." }                       // assistant text block
{ "kind": "thinking",   "text": "..." }
{ "kind": "tool.start", "toolUseId": "t1", "toolName": "Bash", "input": {...} }
{ "kind": "tool.end",   "toolUseId": "t1", "output": "...", "isError": false }
{ "kind": "user",       "text": "..." }                       // echo of the prompt
{ "kind": "turn.end",   "result": "...", "isError": false, "costUsd": 0.01, "durationMs": 1234 }
{ "kind": "status",     "state": "idle" }
{ "kind": "permission.denied", "toolName": "Bash", "detail": "..." }
{ "kind": "error",      "message": "..." }
```

Every event stored/sent by the bridge is wrapped with metadata:

```jsonc
{ "seq": 42, "ts": 1760000012345, "event": { ... } }
```

## Client → Server

| type | fields | notes |
|---|---|---|
| `hello` | `clientName` | first message after connect |
| `session.create` | `platform`, `cwd`, `permissionMode?`, `model?`, `title?`, `prompt?` | if `prompt` given, it is sent immediately |
| `session.list` | — | server replies with `sessions` |
| `session.history` | `sessionId`, `sinceSeq?` | replay transcript events |
| `prompt` | `sessionId`, `text`, `mode?` | send a user message; `mode: "type"` types into a wrapper terminal instead of handing off |
| `interrupt` | `sessionId` | stop the current turn |
| `permission.respond` | `id`, `decision`, `reason?` | answer a `permission.request` card; `decision` is `"allow"` or `"deny"` |
| `presence` | `active` | foreground state; terminal-session approvals only relay while some client is `active` |
| `session.archive` | `sessionId` | dispose process, remove from list; archived sessions stay hidden (persisted in `~/.agentdeck/archived-sessions.json`) unless their transcript gains new activity |
| `session.release` | `sessionId` | hand off to a terminal: dispose the bridge's process (waiting for the transcript to flush) and reply `released { sessionId, nativeSessionId, cwd, title }`. When the transcript resurfaces as a live mirror, the server broadcasts `session.takeover` from the released id so open views re-point to it |
| `dirs.suggest` | — | server replies `dirs` with git repos found under common code roots |
| `ping` | — | server replies `pong` |

## Server → Client

| type | fields | notes |
|---|---|---|
| `welcome` | `serverName`, `version`, `platforms`, `sessions`, `permissions` | sent after `hello`; `permissions` lists approval cards still awaiting an answer |
| `sessions` | `sessions: SessionInfo[]` | full list |
| `session.created` | `session: SessionInfo` | broadcast |
| `session.updated` | `session: SessionInfo` | state/title changes, broadcast |
| `session.removed` | `sessionId` | broadcast |
| `session.takeover` | `fromSessionId`, `session: SessionInfo` | a live session was taken over; the conversation continues under `session` (broadcast) |
| `event` | `sessionId`, `seq`, `ts`, `event: AgentEvent` | live transcript stream, broadcast |
| `history` | `sessionId`, `events: [{seq,ts,event}]` | reply to `session.history` |
| `permission.request` | `request: PermissionRequest` | broadcast; show an Allow/Deny card (see below) |
| `permission.resolved` | `id`, `decision`, `resolvedBy`, `sessionId?` | broadcast when answered or expired; remove the card |
| `alert` | `kind`, `title`, `body`, `sessionId?`, `cwd?` | broadcast; terminal-session notifications ("Claude finished", "Claude needs attention") |
| `dirs` | `dirs: string[]` | reply to `dirs.suggest` |
| `error` | `message`, `inReplyTo?` | |
| `pong` | — | |

Wrapper-internal messages (sent on the wrapper's own socket, not for phone clients):
`pty.register { nativeSessionId, cwd }` → `pty.registered`, `pty.handoff { nativeSessionId }`
(server → wrapper), `pty.handoff-ack { nativeSessionId }` (wrapper → server), plus
`pty.input { text }` / `pty.interrupt` for the typing path.

## Phone approvals (Claude Code hooks)

`agentdeck hooks install` merges three hooks into `~/.claude/settings.json` (marker-tagged,
idempotent, `uninstall` removes them cleanly). From then on **every Claude Code session on
the machine** — wrapped or plain-terminal — relays permission prompts:

1. Claude Code runs `agentdeck hook pre-tool-use`, which POSTs the payload to
   `POST /hooks/pre-tool-use` (header `x-agentdeck-token: <pairing token>`).
2. The bridge broadcasts `permission.request` to connected clients:

```jsonc
// PermissionRequest
{
  "id": "perm_ab12cd",
  "sessionId": "live_1234",        // bridge session when known
  "nativeSessionId": "504adf8d-…",
  "platform": "claude",
  "toolName": "Bash",
  "input": { "command": "npm test" },   // truncated for transport
  "cwd": "/Users/me/proj",
  "createdAt": 1760000000000,
  "expiresAt": 1760000030000
}
```

3. The first `permission.respond` wins and the hook returns
   `permissionDecision: allow|deny` to Claude. On timeout — 30s for terminal sessions,
   45s for bridge-owned ones — or when no client is connected/foregrounded, the hook
   returns no opinion and Claude's normal permission flow proceeds (TUI prompt, settings
   rules). The phone can grant or refuse; silence never changes existing behavior.

`POST /hooks/notification` and `POST /hooks/stop` feed the `alert` broadcast for sessions
the bridge doesn't already stream (`Notification` / `Stop` hooks). Bridge-owned sessions
skip alerts — clients already get their `event` stream.

The same `permission.request` cards are used by the experimental Codex app-server adapter
(`AGENTDECK_CODEX_APPSERVER=1`), whose exec/patch approvals are answered from the phone and
default to **deny** on timeout (the app-server requires an answer).

## Notification guidance for clients

Fire a local notification when, for a session not currently on screen:
- `permission.request` arrives (agent is waiting on you — highest priority),
- `alert` arrives (terminal session finished / needs attention),
- `turn.end` arrives (agent finished / needs input),
- `permission.denied` arrives (agent blocked),
- `status` becomes `error` or `exited`.

Send `presence { active: false }` when backgrounded and `{ active: true }` on foreground —
this is what lets the bridge relay terminal-session approvals only while someone is looking.
