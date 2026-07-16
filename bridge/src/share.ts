import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { commandExists } from './adapters/util.js';
import { loadOrCreateToken } from './pairing.js';

/**
 * `agentdeck share` — expose the bridge's mobile web app to the internet via a
 * Cloudflare quick tunnel. Works from any device, any distance: the phone just
 * opens an https URL. The tunnel terminates on this machine; the bridge's token
 * auth still gates the WebSocket.
 */
export async function runShare(port: number) {
  if (!(await commandExists('cloudflared'))) {
    console.error('`agentdeck share` needs cloudflared (the Cloudflare Tunnel client).');
    console.error('Install it with:  brew install cloudflared');
    process.exit(1);
  }

  // Make sure a bridge is actually listening before exposing it.
  const healthy = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
  if (!healthy) {
    console.error(`No bridge on port ${port}. Start one first (agentdeck, the Mac app, or agentdeck service install).`);
    process.exit(1);
  }

  const token = process.env.AGENTDECK_TOKEN ?? loadOrCreateToken();
  console.log('Opening a Cloudflare tunnel…');
  const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let announced = false;
  const watch = (chunk: Buffer) => {
    if (announced) return;
    const m = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m) return;
    announced = true;
    const url = `${m[0]}/?token=${encodeURIComponent(token)}`;
    console.log('\nAgentDeck is now reachable from anywhere:\n');
    console.log(`  ${url}\n`);
    qrcode.generate(url, { small: true });
    console.log('Scan with any phone camera, or send the link. Keep this command running;');
    console.log('Ctrl-C closes the tunnel. (Quick tunnels get a fresh URL each run — treat');
    console.log('the link like a password: it contains your bridge token.)\n');
  };
  child.stdout.on('data', watch);
  child.stderr.on('data', watch);

  child.on('exit', (code) => {
    console.log(code === 0 ? 'Tunnel closed.' : `cloudflared exited with code ${code}`);
    process.exit(code ?? 0);
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));

  setTimeout(() => {
    if (!announced) {
      console.error('Tunnel did not come up within 30s — check your internet connection.');
      child.kill('SIGTERM');
    }
  }, 30_000).unref();
}
