#!/usr/bin/env node
import { startServer } from './server.js';
import { loadOrCreateToken, printPairingInfo } from './pairing.js';
import { advertise } from './discovery.js';
import { runResume } from './cli.js';
import { runWrappedClaude } from './wrapper.js';

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8787;
const noQr = args.includes('--no-qr');
const noBonjour = args.includes('--no-bonjour');
const noWatch = args.includes('--no-watch');

// Subcommands: `agentdeck claude [args…]` runs Claude in a bridge-controlled PTY
// (messages from the phone type into this terminal); `agentdeck resume [query]` /
// `agentdeck sessions` continue a phone session here. No subcommand = run the daemon.
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
} else if (command) {
  console.error(`unknown command: ${command} (try: agentdeck | agentdeck claude | agentdeck resume | agentdeck sessions)`);
  process.exit(1);
}

async function main() {
  const token = process.env.AGENTDECK_TOKEN ?? loadOrCreateToken();
  const server = await startServer(port, token, { watchLive: !noWatch });

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
