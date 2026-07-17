import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Claude Code hooks integration — the piece that makes phone approvals work
 * for EVERY Claude session on this machine, wrapped or not:
 *
 *   `agentdeck hooks install`   merges three hooks into ~/.claude/settings.json
 *   `agentdeck hook <kind>`     is what Claude Code then executes; it forwards
 *                               the hook payload to the bridge and (for
 *                               PreToolUse) prints Claude's permission decision.
 *
 * The contract is strictly additive: if the bridge is down, no phone is
 * watching, or the request times out, the hook prints nothing ("no opinion")
 * and Claude's normal permission flow takes over. The phone can answer a
 * prompt for you; it can never wedge a session.
 */

const SETTINGS = join(homedir(), '.claude', 'settings.json');
const MARKER = '# agentdeck-hook';
const DEFAULT_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch';
const HOOK_SCRIPT = join(homedir(), '.agentdeck', 'hook.mjs');

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The standalone hook client written to ~/.agentdeck/hook.mjs on install.
 * Self-contained (Node built-ins only) and at a STABLE path, so approvals
 * survive app moves, npm updates, and reinstalls — nothing in the user's
 * settings ever points into a version-specific install location. Mirrors
 * runHook() below; keep the two in sync.
 */
const HOOK_SCRIPT_SOURCE = `// AgentDeck hook client — installed by \`agentdeck hooks install\`.
// Forwards Claude Code hook payloads to the local AgentDeck bridge so you can
// approve tool calls from your phone. Fail-safe: any problem (bridge down,
// nobody watching, timeout) produces no output, and Claude behaves as if this
// hook did not exist. Safe to delete; \`agentdeck hooks uninstall\` removes the
// settings entries.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const kind = process.argv[2] ?? '';
const portIdx = process.argv.indexOf('--port');
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 8787;

function token() {
  if (process.env.AGENTDECK_TOKEN) return process.env.AGENTDECK_TOKEN.trim();
  try { return readFileSync(join(homedir(), '.agentdeck', 'token'), 'utf8').trim(); } catch { return ''; }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref?.();
  });
}

const t = token();
if (!t || !['pre-tool-use', 'notification', 'stop'].includes(kind)) process.exit(0);
let payload = {};
try { payload = JSON.parse((await readStdin()) || '{}'); } catch { process.exit(0); }
try {
  const res = await fetch('http://127.0.0.1:' + port + '/hooks/' + kind, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agentdeck-token': t },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(55000),
  });
  if (kind === 'pre-tool-use') {
    const body = await res.json().catch(() => ({}));
    if (body?.decision === 'allow' || body?.decision === 'deny') {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: body.decision,
          permissionDecisionReason: body.reason || ((body.decision === 'allow' ? 'Approved' : 'Denied') + ' from your phone (AgentDeck)'),
        },
      }));
    }
  }
} catch { /* no opinion */ }
process.exit(0);
`;

function loadToken(): string | undefined {
  if (process.env.AGENTDECK_TOKEN) return process.env.AGENTDECK_TOKEN.trim();
  try {
    return readFileSync(join(homedir(), '.agentdeck', 'token'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

// ---------- the hook client (executed by Claude Code) ----------

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref?.();
  });
}

/**
 * `agentdeck hook pre-tool-use|notification|stop [--port N]`
 * Always exits 0 — a broken hook must never break Claude.
 */
export async function runHook(kind: string, port: number): Promise<void> {
  const valid = ['pre-tool-use', 'notification', 'stop'];
  if (!valid.includes(kind)) {
    console.error(`unknown hook kind: ${kind} (expected ${valid.join('|')})`);
    return;
  }
  const token = loadToken();
  if (!token) return;

  let payload: any = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}');
  } catch {
    return;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentdeck-token': token },
      body: JSON.stringify(payload),
      // Longer than the server's longest phone wait; Claude's own hook
      // timeout (settings) is the final backstop.
      signal: AbortSignal.timeout(55_000),
    });
    if (kind !== 'pre-tool-use') return;
    const body: any = await res.json().catch(() => ({}));
    if (body?.decision === 'allow' || body?.decision === 'deny') {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: body.decision,
          permissionDecisionReason: body.reason || `${body.decision === 'allow' ? 'Approved' : 'Denied'} from your phone (AgentDeck)`,
        },
      }));
    }
    // 'ask'/unexpected → print NOTHING (not an explicit "ask"): a silent hook
    // contributes no decision, so other configured hooks and Claude's normal
    // permission flow are untouched. Precedence between multiple hooks emitting
    // conflicting permissionDecisions is undocumented — silence sidesteps it.
    // Likewise we always exit 0; exit 2 would be a blocking error.
  } catch {
    // Bridge not running / timed out → no opinion.
  }
}

// ---------- the installer ----------

interface HookCommand { type: 'command'; command: string; timeout?: number }
interface HookGroup { matcher?: string; hooks: HookCommand[] }

function isOurs(group: HookGroup): boolean {
  return (group.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(MARKER));
}

function readSettings(): any {
  if (!existsSync(SETTINGS)) return {};
  const raw = readFileSync(SETTINGS, 'utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch (err: any) {
    throw new Error(`${SETTINGS} is not valid JSON (${err.message}) — fix it first, nothing was changed.`);
  }
}

function writeSettings(settings: any) {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

function stripOurs(settings: any) {
  for (const event of Object.keys(settings.hooks ?? {})) {
    settings.hooks[event] = settings.hooks[event].filter((g: HookGroup) => !isOurs(g));
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
}

export function runHooksCommand(args: string[], port: number) {
  const cmd = args[0] ?? 'status';
  const matcherIdx = args.indexOf('--matcher');
  const matcher = matcherIdx >= 0 ? args[matcherIdx + 1] : DEFAULT_MATCHER;

  switch (cmd) {
    case 'install': {
      // Write the self-contained hook client to a stable path, then register
      // commands that point ONLY at stable things: `node` resolved from PATH
      // with the current binary as fallback, and ~/.agentdeck/hook.mjs. App
      // updates and npm upgrades can't break installed hooks.
      mkdirSync(dirname(HOOK_SCRIPT), { recursive: true });
      writeFileSync(HOOK_SCRIPT, HOOK_SCRIPT_SOURCE);
      const nodeFallback = realpathSync(process.execPath);
      const hookCmd = (kind: string) =>
        `"$(command -v node || echo ${q(nodeFallback)})" ${q(HOOK_SCRIPT)} ${kind} --port ${port} ${MARKER}`;

      const settings = readSettings();
      stripOurs(settings);
      settings.hooks ??= {};
      settings.hooks.PreToolUse = [
        ...(settings.hooks.PreToolUse ?? []),
        { matcher, hooks: [{ type: 'command', command: hookCmd('pre-tool-use'), timeout: 90 }] },
      ];
      settings.hooks.Notification = [
        ...(settings.hooks.Notification ?? []),
        { hooks: [{ type: 'command', command: hookCmd('notification'), timeout: 10 }] },
      ];
      settings.hooks.Stop = [
        ...(settings.hooks.Stop ?? []),
        { hooks: [{ type: 'command', command: hookCmd('stop'), timeout: 10 }] },
      ];
      writeSettings(settings);
      console.log(`Installed AgentDeck hooks into ${SETTINGS}`);
      console.log(`  hook client: ${HOOK_SCRIPT} (stable path — survives updates)`);
      console.log(`  PreToolUse (${matcher}), Notification, Stop — bridge port ${port}`);
      console.log('\nTool approvals now reach your phone while the AgentDeck app is open.');
      console.log('If you ignore a prompt, the normal terminal prompt appears — nothing changes.');
      console.log('New Claude Code sessions pick this up automatically; running ones on next restart.');
      break;
    }
    case 'uninstall': {
      const settings = readSettings();
      stripOurs(settings);
      writeSettings(settings);
      try {
        rmSync(HOOK_SCRIPT);
      } catch {
        // already gone
      }
      console.log(`Removed AgentDeck hooks from ${SETTINGS}`);
      break;
    }
    case 'status': {
      const settings = readSettings();
      const events = Object.keys(settings.hooks ?? {}).filter((e) => settings.hooks[e].some(isOurs));
      if (!events.length) {
        console.log('not installed (run: agentdeck hooks install)');
        break;
      }
      console.log(`installed: ${events.join(', ')}`);
      const pre = (settings.hooks.PreToolUse ?? []).find(isOurs);
      if (pre?.matcher) console.log(`PreToolUse matcher: ${pre.matcher}`);
      if (!existsSync(HOOK_SCRIPT)) {
        console.log(`WARNING: ${HOOK_SCRIPT} is missing — approvals are inert. Fix: agentdeck hooks install`);
        process.exitCode = 1;
      }
      break;
    }
    default:
      console.error(`unknown hooks command: ${cmd} (try: install [--matcher <regex>] | uninstall | status)`);
      process.exit(1);
  }
}
