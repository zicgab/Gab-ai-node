import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

interface Pending { resolve(value: unknown): void; reject(err: Error): void; timer: NodeJS.Timeout }

/**
 * Talks to the browser driver (assets/web-driver.mjs) in JSON lines. One call at a
 * time is in flight; a driver that dies or stays silent fails the call, never hangs it.
 */
export class WebSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderr = '';
  private exited: string | null = null;
  private readonly ready: Promise<void>;

  constructor(private readonly child: ChildProcessWithoutNullStreams, startupMs = 60_000) {
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the browser driver did not start in time')), startupMs);
      this.onReady = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } };
    });
    // A failed start is reported by the first call; nobody else awaits this promise.
    this.ready.catch(() => {});
    child.stderr.on('data', (d: Buffer) => { if (this.stderr.length < 4000) this.stderr += d.toString(); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.on('error', (err) => this.fail(`driver could not run: ${err.message}`));
    child.on('close', (code) => this.fail(`driver exited (code ${code})${this.stderr ? `: ${this.stderr.trim().slice(-300)}` : ''}`));
  }

  private onReady!: { resolve(): void; reject(err: Error): void };

  private onLine(line: string): void {
    let msg: { ready?: boolean; fatal?: string; id?: number | null; ok?: boolean; result?: unknown; error?: string };
    try { msg = JSON.parse(line); } catch { return; } // not ours (stray output)
    if (msg.ready) return this.onReady.resolve();
    if (msg.fatal) return this.fail(msg.fatal);
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id as number);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'driver error'));
  }

  private fail(reason: string): void {
    this.exited ??= reason;
    this.onReady.reject(new Error(reason));
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); this.pending.delete(id); }
  }

  /** Runs one browser action; rejects with the driver's one-line error. */
  async call(action: string, args: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<unknown> {
    await this.ready;
    if (this.exited) throw new Error(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${action} timed out after ${timeoutMs / 1000} s`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, action, ...args })}\n`, (err) => {
        if (err) { this.pending.delete(id); clearTimeout(timer); reject(err); }
      });
    });
  }

  close(): void {
    this.child.stdin.end();
    setTimeout(() => this.child.kill('SIGKILL'), 5_000).unref();
  }
}
