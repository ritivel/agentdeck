#!/usr/bin/env node
import { startServer } from './server.js';
import { loadOrCreateToken, printPairingInfo } from './pairing.js';
import { advertise } from './discovery.js';

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8787;
const noQr = args.includes('--no-qr');
const noBonjour = args.includes('--no-bonjour');
const noWatch = args.includes('--no-watch');

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
