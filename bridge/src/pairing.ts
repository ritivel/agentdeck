import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';

const CONFIG_DIR = join(homedir(), '.agentdeck');
const TOKEN_PATH = join(CONFIG_DIR, 'token');

export function loadOrCreateToken(): string {
  if (existsSync(TOKEN_PATH)) {
    const token = readFileSync(TOKEN_PATH, 'utf8').trim();
    if (token) return token;
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  const token = randomBytes(24).toString('base64url');
  writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 });
  return token;
}

export function lanAddresses(): string[] {
  const addrs: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

export function printPairingInfo(port: number, token: string) {
  const host = lanAddresses()[0] ?? '127.0.0.1';
  const payload = `agentdeck://pair?host=${host}&port=${port}&token=${encodeURIComponent(token)}&name=${encodeURIComponent(hostname())}`;

  console.log('\nAgentDeck bridge is running.');
  console.log(`  WebSocket: ws://${host}:${port}/ws`);
  console.log(`  Health:    http://${host}:${port}/health`);
  console.log('\nScan from the AgentDeck iOS app to pair:\n');
  qrcode.generate(payload, { small: true });
  console.log(`Or pair manually — host: ${host}  port: ${port}  token: ${token}\n`);
}
