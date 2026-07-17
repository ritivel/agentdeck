#!/usr/bin/env node
import { startServer, VERSION } from './server.js';
import { loadOrCreateToken, printPairingInfo } from './pairing.js';
import { advertise } from './discovery.js';
import { runResume } from './cli.js';
import { runWrappedClaude } from './wrapper.js';
import { runService } from './service.js';
import { runShare } from './share.js';
import { runHook, runHooksCommand } from './hooks.js';
import { runDoctor } from './doctor.js';

const HELP = `AgentDeck — use Claude Code (and friends) from your phone.

Usage:
  agentdeck                     run the bridge (shows the pairing QR)
  agentdeck claude [args…]      Claude Code that follows you: message it from
                                the phone and the terminal hands the session
                                over; press any key to take it back
  agentdeck hooks install       approve tool calls from your phone, for every
                                Claude session on this Mac (uninstall|status)
  agentdeck resume [query]      continue a phone session in this terminal
  agentdeck sessions            list recent sessions
  agentdeck pair                reprint the pairing QR / web link
  agentdeck share               access from anywhere (Cloudflare tunnel)
  agentdeck service install     start the bridge at login (uninstall|status)
  agentdeck doctor              check the whole setup and how to fix it
  agentdeck --version           print the version

Options: --port <n> (default 8787), --no-qr, --no-bonjour, --no-watch
Docs: https://github.com/ritivel/agentdeck`;

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8787;
const noQr = args.includes('--no-qr');
const noBonjour = args.includes('--no-bonjour');
const noWatch = args.includes('--no-watch');

// Supervisor mode (the Mac app): exit if the parent process disappears, so a
// crashed/killed app never leaves an orphaned bridge holding the port.
const parentIdx = args.indexOf('--exit-with-parent');
if (parentIdx >= 0) {
  const parentPid = Number(args[parentIdx + 1]);
  if (Number.isFinite(parentPid) && parentPid > 1) {
    const watchdog = setInterval(() => {
      try {
        process.kill(parentPid, 0); // signal 0 = existence check
      } catch {
        process.exit(0);
      }
    }, 3000);
    watchdog.unref?.();
  }
}

if (args.includes('--version') || args.includes('-V')) {
  console.log(VERSION);
  process.exit(0);
}

// Subcommands (no subcommand = run the daemon); see HELP above.
const command = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
if (command === 'claude') {
  runWrappedClaude(args.slice(1), port).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (command === 'resume' || command === 'sessions') {
  const rest = args.slice(1).filter((a) => a !== '--port' && a !== String(port));
  runResume(command === 'sessions' ? ['--list', ...rest] : rest, port).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (command === 'service') {
  try {
    runService(args.slice(1));
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
} else if (command === 'pair') {
  printPairingInfo(port, process.env.AGENTDECK_TOKEN ?? loadOrCreateToken());
} else if (command === 'share') {
  runShare(port).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (command === 'hooks') {
  try {
    runHooksCommand(args.slice(1), port);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
} else if (command === 'hook') {
  // Executed by Claude Code (settings hooks); must never fail the session.
  runHook(args[1] ?? '', port).finally(() => process.exit(0));
} else if (command === 'doctor') {
  runDoctor(port).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (command === 'help') {
  console.log(HELP);
} else if (command) {
  console.error(`unknown command: ${command}\n`);
  console.error(HELP);
  process.exit(1);
}

async function main() {
  // A background daemon should log unexpected errors and keep serving; dying
  // over a transient fs/socket hiccup would take every phone offline.
  process.on('uncaughtException', (err) => console.error(`[agentdeck] uncaught: ${err?.stack ?? err}`));
  process.on('unhandledRejection', (err: any) => console.error(`[agentdeck] unhandled rejection: ${err?.stack ?? err}`));

  const token = process.env.AGENTDECK_TOKEN ?? loadOrCreateToken();
  let server;
  try {
    server = await startServer(port, token, { watchLive: !noWatch });
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use — an AgentDeck bridge is probably running`);
      console.error(`(check: agentdeck doctor). To run a second one: agentdeck --port ${port + 1}`);
      process.exit(1);
    }
    throw err;
  }

  let stopAdvertising = () => {};
  if (!noBonjour) {
    try {
      stopAdvertising = advertise(port);
    } catch (err: any) {
      console.error(`bonjour advertisement failed (continuing): ${err.message}`);
    }
  }

  if (noQr) {
    console.log(`AgentDeck bridge listening on port ${port}`);
  } else {
    printPairingInfo(port, token);
  }

  const shutdown = () => {
    stopAdvertising();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (!command) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
