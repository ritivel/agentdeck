# @agentdeck/bridge

Use Claude Code (and Cursor, Codex) **from your phone**: see every session live,
chat, approve tool calls, and hand sessions between your terminal and your phone
without losing anything.

This package is the bridge daemon + CLI. If you just want the app experience,
grab **AgentDeck for Mac** from the
[releases page](https://github.com/ritivel/agentdeck/releases) — it bundles this.

## Quickstart

```bash
npm install -g @agentdeck/bridge
agentdeck                      # starts the bridge, shows a QR
```

Scan the QR with your phone's camera — AgentDeck opens in the browser, nothing
to install. Then, optionally:

```bash
agentdeck hooks install        # approve Claude's tool calls from your phone
alias claude="agentdeck claude"  # sessions that follow you between terminal & phone
agentdeck service install      # start at login
agentdeck share                # access from anywhere (Cloudflare tunnel)
agentdeck doctor               # check the whole setup
```

Everything is additive and reversible: ignore a phone prompt and the normal
terminal prompt appears; `agentdeck hooks uninstall` removes every trace.

Docs, protocol, and the iOS/Android/Mac apps: https://github.com/ritivel/agentdeck
