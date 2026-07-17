# Changelog

## 0.3.0 — 2026-07-17

The "use it from your phone like an app" release.

### WhatsApp-style session handoff
- `agentdeck claude` now passes the session between terminal and phone like a
  baton: message it from the phone and the terminal hands it over (banner:
  *"📱 continued from your phone — press any key to take it back"*); a keypress
  resumes the same TUI session with the phone turns in its history. No forks.
- Legacy type-into-the-terminal path is still available (`prompt` with
  `mode: "type"`).

### Phone approvals (every Claude session, not just AgentDeck ones)
- `agentdeck hooks install` — Claude Code permission prompts (Bash, Edit, Write,
  …) appear as Allow/Deny cards on your phone, for every session on the machine.
- Fail-safe and non-intrusive by design: unanswered prompts fall back to the
  normal terminal prompt; approvals only relay while the app is foregrounded
  (presence gating), so a phone in a pocket never stalls a terminal.
- The hook client lives at a stable path (`~/.agentdeck/hook.mjs`), so app moves
  and updates can't break it. `agentdeck hooks uninstall` removes everything.

### Mac app
- **Phone approvals** toggle in the menu bar — one click to enable/disable.
- Pairing QR now defaults to the web-app URL: scan with any phone camera,
  AgentDeck opens in the browser, nothing to install. iOS-app deep link is one
  segment away.

### Consumer hardening
- `agentdeck doctor` — checks Node, token, daemon, agent CLIs, and hook health,
  with exact fix commands. `agentdeck --version`, `agentdeck help`.
- Friendly port-in-use error; daemon survives transient errors instead of dying.
- Web app is installable (manifest + icon); correct version reporting.

### Experimental
- Codex adapter speaking the official `codex app-server` JSON-RPC protocol
  (threads, turns, interrupts, approvals → phone). Enable with
  `AGENTDECK_CODEX_APPSERVER=1`; needs a machine with the codex CLI.

### Protocol
- New messages: `permission.request` / `permission.respond` /
  `permission.resolved`, `alert`, `presence`, `pty.handoff` /
  `pty.handoff-ack`; `welcome` now carries pending `permissions`. See
  PROTOCOL.md.

## 0.2.0 — 2026-07-16

Initial public cut: bridge daemon (WS protocol, QR pairing, Bonjour), live
mirroring of terminal/IDE sessions for Claude/Cursor/Codex, takeover & release,
`agentdeck claude` PTY wrapper, `agentdeck resume`, mobile web app +
`agentdeck share`, Mac menu bar app with bundled bridge, iOS app, Android app,
launchd service, release pipeline.
