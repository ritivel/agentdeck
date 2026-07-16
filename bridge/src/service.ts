import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `agentdeck service install|uninstall|status` — run the bridge as a launchd
 * LaunchAgent so it starts at login and restarts if it dies. Not needed when
 * using the AgentDeck Mac app, which manages its own bundled bridge.
 */

const LABEL = 'com.ritivel.agentdeck';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'AgentDeck');
const LOG = join(LOG_DIR, 'bridge.log');

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(args: string[], opts: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) {
    if (opts.allowFailure) return '';
    throw new Error(`launchctl ${args[0]} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

export function runService(args: string[]) {
  const cmd = args[0] ?? 'status';
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;

  switch (cmd) {
    case 'install': {
      if (process.platform !== 'darwin') {
        console.error('service install currently supports macOS only');
        process.exit(1);
      }
      const portIdx = args.indexOf('--port');
      const port = portIdx >= 0 ? args[portIdx + 1] : '8787';
      // The plist must exec the real node binary + real entry script: npm bin
      // shims and version-manager symlinks can vanish out from under launchd.
      const node = realpathSync(process.execPath);
      const entry = realpathSync(process.argv[1]);
      mkdirSync(LOG_DIR, { recursive: true });
      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      const path = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), '/usr/bin', '/bin'].join(':');
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
    <string>${escapeXml(entry)}</string>
    <string>--no-qr</string>
    <string>--port</string>
    <string>${escapeXml(port)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(path)}</string>
    <key>HOME</key><string>${escapeXml(homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(LOG)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(LOG)}</string>
</dict>
</plist>
`;
      // Replace any existing registration.
      launchctl(['bootout', domain, PLIST], { allowFailure: true });
      writeFileSync(PLIST, plist);
      launchctl(['bootstrap', domain, PLIST]);
      console.log(`Installed LaunchAgent ${LABEL} (port ${port}).`);
      console.log(`The bridge now starts at login. Logs: ${LOG}`);
      console.log(`Pair your phone with: agentdeck pair`);
      break;
    }
    case 'uninstall': {
      launchctl(['bootout', domain, PLIST], { allowFailure: true });
      if (existsSync(PLIST)) rmSync(PLIST);
      console.log(`Removed LaunchAgent ${LABEL}.`);
      break;
    }
    case 'status': {
      const out = launchctl(['print', `${domain}/${LABEL}`], { allowFailure: true });
      if (!out) {
        console.log('not installed (run: agentdeck service install)');
        break;
      }
      const state = out.match(/state = (\w+)/)?.[1] ?? 'unknown';
      const pid = out.match(/pid = (\d+)/)?.[1];
      console.log(`installed, ${state}${pid ? ` (pid ${pid})` : ''}`);
      break;
    }
    default:
      console.error(`unknown service command: ${cmd} (try: install | uninstall | status)`);
      process.exit(1);
  }
}
