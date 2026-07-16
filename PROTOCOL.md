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
  "readOnly": false                  // true = bridge mirrors only; prompt/interrupt/archive are rejected
}
```

### Live (attached) sessions

The bridge also discovers Claude Code sessions started **outside** the bridge — i.e. in a
terminal or IDE — by watching the transcript JSONL files Claude Code writes under
`~/.claude/projects/<slug>/<id>.jsonl`. These appear in `session.list`/`welcome` with
`attached: true` and `readOnly: true`, `id` prefixed `live_`, and `permissionMode: "attached"`.
Their transcript is parsed on discovery and tailed in real time, emitting the same `event`
envelopes as spawned sessions. `prompt`, `interrupt`, and `session.archive` return an `error`
for these (take-over from the phone is a roadmap item). Disable discovery with `--no-watch`.

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
| `prompt` | `sessionId`, `text` | send a user message to the agent |
| `interrupt` | `sessionId` | stop the current turn |
| `session.archive` | `sessionId` | dispose process, remove from list |
| `dirs.suggest` | — | server replies `dirs` with git repos found under common code roots |
| `ping` | — | server replies `pong` |

## Server → Client

| type | fields | notes |
|---|---|---|
| `welcome` | `serverName`, `version`, `platforms`, `sessions` | sent after `hello`; `platforms` is `{claude:{available:true},...}` |
| `sessions` | `sessions: SessionInfo[]` | full list |
| `session.created` | `session: SessionInfo` | broadcast |
| `session.updated` | `session: SessionInfo` | state/title changes, broadcast |
| `session.removed` | `sessionId` | broadcast |
| `event` | `sessionId`, `seq`, `ts`, `event: AgentEvent` | live transcript stream, broadcast |
| `history` | `sessionId`, `events: [{seq,ts,event}]` | reply to `session.history` |
| `dirs` | `dirs: string[]` | reply to `dirs.suggest` |
| `error` | `message`, `inReplyTo?` | |
| `pong` | — | |

## Notification guidance for clients

Fire a local notification when, for a session not currently on screen:
- `turn.end` arrives (agent finished / needs input),
- `permission.denied` arrives (agent blocked),
- `status` becomes `error` or `exited`.
