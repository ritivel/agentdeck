import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { jsonLines, type AdapterHandle, type AdapterStartOptions, type PlatformAdapter } from './types.js';
import { commandExists, contentToText } from './util.js';

/**
 * Claude Code adapter.
 *
 * Runs one long-lived `claude -p --input-format stream-json --output-format stream-json`
 * process per session. Prompts are written to stdin as user messages; events stream
 * back on stdout as JSON lines. Interrupts use the stream-json control protocol.
 */
export const claudeAdapter: PlatformAdapter = {
  platform: 'claude',
  available: () => commandExists('claude'),

  start(opts: AdapterStartOptions): AdapterHandle {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', opts.permissionMode,
    ];
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeNativeId) args.push('--resume', opts.resumeNativeId);

    const child: ChildProcessWithoutNullStreams = spawn('claude', args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let controlSeq = 0;
    let stderrTail = '';

    child.stdout.on('data', jsonLines((msg) => {
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init' && msg.session_id) opts.onNativeSessionId(msg.session_id);
          break;
        case 'assistant': {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              opts.onEvent({ kind: 'text', text: block.text });
            } else if (block.type === 'thinking' && block.thinking) {
              opts.onEvent({ kind: 'thinking', text: block.thinking });
            } else if (block.type === 'tool_use') {
              opts.onEvent({ kind: 'tool.start', toolUseId: block.id, toolName: block.name, input: block.input });
            }
          }
          break;
        }
        case 'user': {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_result') {
              opts.onEvent({
                kind: 'tool.end',
                toolUseId: block.tool_use_id,
                output: contentToText(block.content).slice(0, 2000),
                isError: block.is_error === true,
              });
            }
          }
          break;
        }
        case 'result': {
          for (const denial of msg.permission_denials ?? []) {
            opts.onEvent({ kind: 'permission.denied', toolName: denial.tool_name ?? 'unknown', detail: denial.tool_use_id });
          }
          opts.onEvent({
            kind: 'turn.end',
            result: typeof msg.result === 'string' ? msg.result : undefined,
            isError: msg.is_error === true,
            costUsd: msg.total_cost_usd,
            durationMs: msg.duration_ms,
          });
          break;
        }
      }
    }));

    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        opts.onEvent({ kind: 'error', message: `claude exited with code ${code}: ${stderrTail.trim().slice(-500)}` });
      }
      opts.onEvent({ kind: 'status', state: 'exited' });
    });
    child.on('error', (err) => opts.onEvent({ kind: 'error', message: `failed to start claude: ${err.message}` }));

    return {
      send(text: string) {
        const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
        child.stdin.write(JSON.stringify(msg) + '\n');
      },
      interrupt() {
        const req = { type: 'control_request', request_id: `int_${++controlSeq}`, request: { subtype: 'interrupt' } };
        child.stdin.write(JSON.stringify(req) + '\n');
      },
      dispose() {
        child.stdin.end();
        setTimeout(() => child.kill('SIGTERM'), 3000).unref();
      },
    };
  },
};
