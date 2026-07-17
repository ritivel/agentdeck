import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { jsonLines, type AdapterHandle, type AdapterStartOptions, type PlatformAdapter } from './types.js';
import { commandExists } from './util.js';

/**
 * EXPERIMENTAL Codex adapter speaking the official `codex app-server` protocol
 * (bidirectional JSON-RPC over stdio; https://developers.openai.com/codex/app-server)
 * instead of forking one `codex exec` per prompt.
 *
 * Why this is the right shape: the app-server is the same API the Codex TUI,
 * VS Code extension, and ChatGPT app use. Threads survive turns, multiple
 * clients may subscribe to one thread, interrupts are first-class, and command
 * approvals arrive as server→client REQUESTS — which we forward to the phone.
 *
 * Enable with AGENTDECK_CODEX_APPSERVER=1 (the classic exec adapter stays the
 * default until this has been validated against a real codex install; method
 * and event names follow the published protocol but shapes are parsed
 * defensively).
 */

type PermissionRelay = (req: {
  toolName: string;
  input: unknown;
  cwd?: string;
  nativeSessionId?: string;
}) => Promise<'allow' | 'deny'>;

/** Server.ts injects the phone-approval broker here (experimental plumbing). */
let permissionRelay: PermissionRelay | undefined;
export function setCodexPermissionRelay(relay: PermissionRelay) {
  permissionRelay = relay;
}

interface Rpc {
  send: (msg: object) => void;
  request: (method: string, params?: unknown) => Promise<any>;
  child: ChildProcessWithoutNullStreams;
}

/** One shared app-server process; threads multiplex over it. */
let shared: Promise<Rpc> | null = null;

/** Handlers by threadId for notifications + approval requests. */
const threadHandlers = new Map<string, (msg: any) => void>();
/** Sessions whose thread id is not known yet see broadcast-ish fallback. */
const pendingHandlers = new Set<(msg: any) => void>();

function threadIdOf(params: any): string | undefined {
  return params?.threadId ?? params?.thread_id ?? params?.thread?.id;
}

async function startShared(): Promise<Rpc> {
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.on('exit', () => {
    shared = null;
    for (const h of threadHandlers.values()) h({ method: '__exit' });
    for (const h of pendingHandlers) h({ method: '__exit' });
  });

  let nextId = 1;
  const awaiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  const send = (msg: object) => {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(msg) + '\n');
  };
  const request = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      awaiting.set(id, { resolve, reject });
      send({ id, method, params });
      setTimeout(() => {
        if (awaiting.delete(id)) reject(new Error(`codex app-server: ${method} timed out`));
      }, 60_000).unref?.();
    });

  child.stdout.on('data', jsonLines((msg) => {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = awaiting.get(msg.id);
      if (waiter) {
        awaiting.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else waiter.resolve(msg.result);
      }
      return;
    }
    // Notification or server→client request: route by thread.
    const tid = threadIdOf(msg.params);
    const handler = tid ? threadHandlers.get(tid) : undefined;
    if (handler) handler(msg);
    else for (const h of pendingHandlers) h(msg);
  }));
  child.stderr.on('data', () => {});

  const rpc: Rpc = { send, request, child };
  await request('initialize', {
    clientInfo: { name: 'agentdeck', title: 'AgentDeck', version: '0.2.0' },
  });
  send({ method: 'initialized' });
  return rpc;
}

function getShared(): Promise<Rpc> {
  if (!shared) shared = startShared().catch((err) => { shared = null; throw err; });
  return shared;
}

export const codexAppServerAdapter: PlatformAdapter = {
  platform: 'codex',
  available: async () =>
    process.env.AGENTDECK_CODEX_APPSERVER === '1' && (await commandExists('codex')),

  start(opts: AdapterStartOptions): AdapterHandle {
    let threadId: string | undefined = opts.resumeNativeId;
    let disposed = false;
    let turnActive = false;
    const queued: string[] = [];
    /** Streaming deltas accumulate per item; emitted as one event when done. */
    const itemText = new Map<string, string>();

    const emitError = (message: string) => opts.onEvent({ kind: 'error', message });

    const handle = (msg: any) => {
      const method: string = msg.method ?? '';
      const p = msg.params ?? {};

      if (method === '__exit') {
        if (!disposed) opts.onEvent({ kind: 'status', state: 'exited' });
        return;
      }

      // ---- server→client approval requests → the phone ----
      if (msg.id !== undefined && /approval/i.test(method)) {
        const toolName = /patch/i.test(method) ? 'ApplyPatch' : 'ExecCommand';
        const input = p.command ?? p.changes ?? p;
        opts.onEvent({ kind: 'tool.start', toolName: `${toolName} (approval)`, input });
        const answer = permissionRelay
          ? permissionRelay({ toolName, input, cwd: p.cwd, nativeSessionId: threadId })
          : Promise.resolve('deny' as const);
        answer
          .catch(() => 'deny' as const)
          .then((decision) => {
            void getShared().then((rpc) =>
              rpc.send({ id: msg.id, result: { decision: decision === 'allow' ? 'approved' : 'denied' } }));
            if (decision === 'deny') {
              opts.onEvent({ kind: 'permission.denied', toolName, detail: typeof input === 'string' ? input : undefined });
            }
          });
        return;
      }

      // ---- notifications ----
      const itemId = p.itemId ?? p.item_id ?? p.item?.id ?? 'item';
      if (/agentMessage\/delta$/i.test(method) || /reasoning\/textDelta$/i.test(method)) {
        const delta = p.delta ?? p.text ?? '';
        itemText.set(itemId, (itemText.get(itemId) ?? '') + delta);
      } else if (/item\/completed$/i.test(method) || /item\/done$/i.test(method)) {
        const item = p.item ?? p;
        const text = itemText.get(itemId) ?? item.text ?? '';
        itemText.delete(itemId);
        const type = String(item.type ?? item.itemType ?? '');
        if (/reasoning/i.test(type)) {
          if (text) opts.onEvent({ kind: 'thinking', text });
        } else if (/command/i.test(type)) {
          opts.onEvent({ kind: 'tool.end', toolUseId: itemId, output: String(item.output ?? text).slice(0, 2000), isError: item.exitCode ? item.exitCode !== 0 : false });
        } else if (text) {
          opts.onEvent({ kind: 'text', text });
        }
      } else if (/commandExecution/i.test(method) && /started|begin/i.test(method)) {
        opts.onEvent({ kind: 'tool.start', toolUseId: itemId, toolName: 'ExecCommand', input: p.command });
      } else if (/turn\/completed$/i.test(method) || /turn\/failed$/i.test(method)) {
        // Flush any dangling streamed text so nothing is lost.
        for (const [, text] of itemText) if (text) opts.onEvent({ kind: 'text', text });
        itemText.clear();
        turnActive = false;
        opts.onEvent({ kind: 'turn.end', isError: /failed/i.test(method), result: p.turn?.status });
        const next = queued.shift();
        if (next) void startTurn(next);
      }
    };

    const registerHandler = () => {
      if (threadId) {
        threadHandlers.set(threadId, handle);
        pendingHandlers.delete(handle);
      } else {
        pendingHandlers.add(handle);
      }
    };
    registerHandler();

    const ensureThread = async (rpc: Rpc): Promise<string> => {
      if (threadId) return threadId;
      const result = opts.resumeNativeId
        ? await rpc.request('thread/resume', { threadId: opts.resumeNativeId, cwd: opts.cwd })
        : await rpc.request('thread/start', { cwd: opts.cwd });
      threadId = threadIdOf(result) ?? result?.thread?.id ?? result?.threadId;
      if (!threadId) throw new Error('codex app-server did not return a thread id');
      registerHandler();
      opts.onNativeSessionId(threadId);
      return threadId;
    };

    const startTurn = async (text: string) => {
      try {
        const rpc = await getShared();
        const tid = await ensureThread(rpc);
        turnActive = true;
        await rpc.request('turn/start', { threadId: tid, input: [{ type: 'text', text }] });
      } catch (err: any) {
        turnActive = false;
        emitError(`codex app-server: ${err.message}`);
        opts.onEvent({ kind: 'turn.end', isError: true });
      }
    };

    return {
      send(text: string) {
        if (turnActive) queued.push(text);
        else void startTurn(text);
      },
      interrupt() {
        void getShared()
          .then((rpc) => threadId && rpc.request('turn/interrupt', { threadId }))
          .catch(() => {});
      },
      dispose() {
        disposed = true;
        if (threadId) threadHandlers.delete(threadId);
        pendingHandlers.delete(handle);
        // The shared app-server stays up for other sessions.
      },
    };
  },
};
