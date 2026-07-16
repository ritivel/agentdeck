import { spawn, type ChildProcess } from 'node:child_process';
import { jsonLines, type AdapterHandle, type AdapterStartOptions, type PlatformAdapter } from './types.js';
import { commandExists } from './util.js';

/**
 * OpenAI Codex adapter.
 *
 * Uses `codex exec --json` for the first turn (capturing the thread id from the
 * thread.started event) and `codex exec resume <threadId> --json` for follow-ups.
 * Codex emits JSONL events: thread.started, turn.started, item.completed
 * (agent_message / reasoning / command_execution / file_change), turn.completed.
 */
export const codexAdapter: PlatformAdapter = {
  platform: 'codex',
  available: () => commandExists('codex'),

  start(opts: AdapterStartOptions): AdapterHandle {
    let threadId: string | undefined = opts.resumeNativeId;
    let current: ChildProcess | null = null;
    let disposed = false;
    const queue: string[] = [];

    const sandboxFor = (mode: string): string => {
      if (mode === 'bypassPermissions') return 'danger-full-access';
      if (mode === 'plan') return 'read-only';
      return 'workspace-write';
    };

    const runTurn = async (text: string) => {
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandboxFor(opts.permissionMode)];
      if (opts.model) args.push('--model', opts.model);
      if (threadId) args.splice(1, 0, 'resume', threadId);
      args.push(text);

      const child = spawn('codex', args, { cwd: opts.cwd, env: process.env });
      current = child;
      let sawEnd = false;
      let stderrTail = '';

      child.stdout!.on('data', jsonLines((msg) => {
        const type = msg.type ?? '';
        if (type === 'thread.started' && msg.thread_id) {
          threadId = msg.thread_id;
          opts.onNativeSessionId(msg.thread_id);
        } else if (type === 'item.completed' || type === 'item.updated') {
          const item = msg.item ?? {};
          if (type === 'item.completed') {
            switch (item.item_type ?? item.type) {
              case 'agent_message':
                if (item.text) opts.onEvent({ kind: 'text', text: item.text });
                break;
              case 'reasoning':
                if (item.text) opts.onEvent({ kind: 'thinking', text: item.text });
                break;
              case 'command_execution':
                opts.onEvent({ kind: 'tool.start', toolUseId: item.id, toolName: 'command', input: { command: item.command } });
                opts.onEvent({
                  kind: 'tool.end',
                  toolUseId: item.id,
                  output: String(item.aggregated_output ?? '').slice(0, 2000),
                  isError: item.exit_code !== 0 && item.exit_code != null,
                });
                break;
              case 'file_change':
                opts.onEvent({ kind: 'tool.start', toolUseId: item.id, toolName: 'file_change', input: item.changes });
                opts.onEvent({ kind: 'tool.end', toolUseId: item.id });
                break;
            }
          }
        } else if (type === 'turn.completed') {
          sawEnd = true;
          opts.onEvent({ kind: 'turn.end' });
        } else if (type === 'turn.failed' || type === 'error') {
          sawEnd = true;
          opts.onEvent({ kind: 'error', message: String(msg.error?.message ?? msg.message ?? 'codex turn failed') });
          opts.onEvent({ kind: 'turn.end', isError: true });
        }
      }));
      child.stderr!.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

      await new Promise<void>((resolve) => {
        child.on('exit', (code) => {
          if (!sawEnd) {
            if (code !== 0 && code !== null) {
              opts.onEvent({ kind: 'error', message: `codex exited with code ${code}: ${stderrTail.trim().slice(-500)}` });
            }
            opts.onEvent({ kind: 'turn.end', isError: code !== 0 });
          }
          resolve();
        });
        child.on('error', (err) => {
          opts.onEvent({ kind: 'error', message: `failed to start codex: ${err.message}` });
          resolve();
        });
      });

      current = null;
      const next = queue.shift();
      if (next !== undefined && !disposed) void runTurn(next);
    };

    return {
      send(text: string) {
        if (current) queue.push(text);
        else void runTurn(text);
      },
      interrupt() {
        queue.length = 0;
        current?.kill('SIGINT');
      },
      dispose() {
        disposed = true;
        queue.length = 0;
        current?.kill('SIGTERM');
      },
    };
  },
};
