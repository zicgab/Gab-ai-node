import { spawn } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string }

/**
 * Runs a program without a shell (arguments are never parsed by a shell).
 * Rejects on spawn failure or timeout; a non-zero exit is returned, not thrown,
 * unless check is set.
 */
export function exec(
  file: string, args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; check?: boolean; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal });
    let stdout = '';
    let stderr = '';
    const cap = 4 * 1024 * 1024;
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < cap) stderr += d.toString(); });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      const res = { code: code ?? (sig ? 128 : 1), stdout, stderr };
      if (opts.check && res.code !== 0) {
        reject(new Error(`${file} ${args[0] ?? ''} failed (exit ${res.code}): ${stderr.trim().slice(0, 500)}`));
      } else resolve(res);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Whether a program is on PATH. */
export async function has(program: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try { return (await exec(finder, [program])).code === 0; } catch { return false; }
}
