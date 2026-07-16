import { spawn, type ChildProcess } from 'node:child_process';
import { jsonLines, type AdapterHandle, type AdapterStartOptions, type PlatformAdapter } from './types.js';
import { commandExists, contentToText } from './util.js';

/**
 * Cursor adapter.
 *
 * cursor-agent's print mode is one-shot per turn, so this adapter creates a chat id
 * up front (`cursor-agent create-chat`) and spawns
 * `cursor-agent -p --output-format stream-json --resume <chatId> <prompt>`
 * for every prompt. Interrupt kills the in-flight turn; the chat id preserves context.
 */
export const cursorAdapter: PlatformAdapter = {
  platform: 'cursor',
  available: () => commandExists('cursor-agent'),

  start(opts: AdapterStartOptions): AdapterHandle {
    let chatId: string | undefined = opts.resumeNativeId;
    let current: ChildProcess | null = null;
    let disposed = false;
    const queue: string[] = [];

    const ensureChat = async (): Promise<string> => {
      if (chatId) return chatId;
      chatId = await new Promise<string>((resolve, reject) => {
        const p = spawn('cursor-agent', ['create-chat'], { cwd: opts.cwd, env: process.env });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('exit', (code) => {
          const id = out.trim().split('\n').pop()?.trim();
          if (code === 0 && id) resolve(id);
          else reject(new Error(`create-chat failed (${code}): ${err.slice(-300)}`));
        });
        p.on('error', reject);
      });
      opts.onNativeSessionId(chatId);
      return chatId;
    };

    const runTurn = async (text: string) => {
      try {
        const id = await ensureChat();
        if (disposed) return;
        const args = [
          '-p',
          '--output-format', 'stream-json',
          '--trust',
          '--resume', id,
        ];
        if (opts.permissionMode === 'bypassPermissions') args.push('--force');
        if (opts.model) args.push('--model', opts.model);
        args.push(text);

        const child = spawn('cursor-agent', args, { cwd: opts.cwd, env: process.env });
        current = child;
        let sawResult = false;
        let stderrTail = '';

        child.stdout!.on('data', jsonLines((msg) => {
          switch (msg.type) {
            case 'assistant': {
              for (const block of msg.message?.content ?? []) {
                if (block.type === 'text' && block.text) opts.onEvent({ kind: 'text', text: block.text });
                if (block.type === 'thinking' && (block.thinking || block.text)) {
                  opts.onEvent({ kind: 'thinking', text: block.thinking ?? block.text });
                }
              }
              break;
            }
            case 'tool_call': {
              const tc = msg.tool_call ?? msg;
              const name = tc.name ?? tc.tool ?? tc.subtype ?? 'tool';
              if (msg.subtype === 'started' || !msg.subtype) {
                opts.onEvent({ kind: 'tool.start', toolUseId: tc.id ?? tc.tool_call_id, toolName: String(name), input: tc.args ?? tc.input });
              } else if (msg.subtype === 'completed') {
                opts.onEvent({ kind: 'tool.end', toolUseId: tc.id ?? tc.tool_call_id, output: contentToText(tc.result ?? tc.output).slice(0, 2000) });
              }
              break;
            }
            case 'result': {
              sawResult = true;
              opts.onEvent({
                kind: 'turn.end',
                result: typeof msg.result === 'string' ? msg.result : undefined,
                isError: msg.is_error === true || msg.subtype === 'error',
                durationMs: msg.duration_ms,
              });
              break;
            }
          }
        }));
        child.stderr!.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

        await new Promise<void>((resolve) => {
          child.on('exit', (code) => {
            if (!sawResult) {
              if (code !== 0 && code !== null) {
                opts.onEvent({ kind: 'error', message: `cursor-agent exited with code ${code}: ${stderrTail.trim().slice(-500)}` });
              }
              opts.onEvent({ kind: 'turn.end', isError: code !== 0 });
            }
            resolve();
          });
          child.on('error', (err) => {
            opts.onEvent({ kind: 'error', message: `failed to start cursor-agent: ${err.message}` });
            resolve();
          });
        });
      } catch (err: any) {
        opts.onEvent({ kind: 'error', message: err.message });
        opts.onEvent({ kind: 'turn.end', isError: true });
      } finally {
        current = null;
        const next = queue.shift();
        if (next !== undefined && !disposed) void runTurn(next);
      }
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
