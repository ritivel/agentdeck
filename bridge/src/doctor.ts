import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VERSION } from './server.js';

/**
 * `agentdeck doctor` — one command a user can run (and paste the output of)
 * when anything misbehaves. Checks every link in the consumer chain and says
 * exactly how to fix the broken ones. Exits non-zero if something is wrong.
 */

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
let warnings = 0;
const warn = (msg: string, fix?: string) => {
  warnings++;
  console.log(`  ! ${msg}`);
  if (fix) console.log(`      fix: ${fix}`);
};
const bad = (msg: string, fix?: string) => {
  console.log(`  ✗ ${msg}`);
  if (fix) console.log(`      fix: ${fix}`);
};

function has(cmd: string): boolean {
  try {
    execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(port: number): Promise<void> {
  let failures = 0;
  const fail = (msg: string, fix?: string) => { bad(msg, fix); failures++; };
  console.log(`AgentDeck doctor (bridge v${VERSION})\n`);

  // Node
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 5)) ok(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node} is too old`, 'install Node >= 22.5 (brew install node)');

  // Token
  const tokenPath = join(homedir(), '.agentdeck', 'token');
  const token = process.env.AGENTDECK_TOKEN?.trim() ||
    (existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '');
  if (token) ok(`pairing token present (${tokenPath})`);
  else warn('no pairing token yet', 'it is created on first run: agentdeck');

  // Daemon
  let daemonUp = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const body: any = await res.json();
    daemonUp = body?.ok === true;
    if (daemonUp) ok(`bridge running on port ${port} (v${body.version})`);
  } catch {
    // handled below
  }
  if (!daemonUp) warn(`no bridge on port ${port}`, 'start it: agentdeck   (or: agentdeck service install)');

  // Agent CLIs
  for (const [cmd, label] of [['claude', 'Claude Code'], ['cursor-agent', 'Cursor'], ['codex', 'Codex']] as const) {
    if (has(cmd)) ok(`${label} CLI found (${cmd})`);
    else console.log(`  - ${label} CLI not installed (${cmd}) — sessions for it won't be available`);
  }

  // Hooks (phone approvals)
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const groups: any[] = Object.values(settings.hooks ?? {}).flat();
    const ours = groups.flatMap((g: any) => g.hooks ?? []).filter((h: any) => String(h.command ?? '').includes('# agentdeck-hook'));
    if (!ours.length) {
      warn('phone approvals not set up', 'agentdeck hooks install');
    } else {
      // The command embeds absolute node+entry paths; both must still exist
      // (they go stale when node or the package is moved/updated).
      const paths = [...String(ours[0].command).matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const stale = paths.filter((p) => p.startsWith('/') && !existsSync(p));
      if (stale.length) fail(`hooks installed but point at missing files (${stale[0]})`, 'agentdeck hooks install   (re-links them)');
      else ok(`phone approvals installed (${settingsPath})`);
      const portMatch = String(ours[0].command).match(/--port (\d+)/);
      if (portMatch && Number(portMatch[1]) !== port) {
        warn(`hooks call port ${portMatch[1]}, doctor checked ${port}`, `agentdeck hooks install --port ${port}   (if the bridge runs on ${port})`);
      }
    }
  } catch {
    warn('phone approvals not set up (no ~/.claude/settings.json)', 'agentdeck hooks install');
  }

  if (failures) console.log(`\n${failures} problem${failures > 1 ? 's' : ''} found.`);
  else if (warnings) console.log('\nNo blocking problems — suggestions above.');
  else console.log('\nAll good.');
  if (failures) process.exitCode = 1;
}
