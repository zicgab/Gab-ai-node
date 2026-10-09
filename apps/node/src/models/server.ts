// Runs llama.cpp llama-server, one process per model, started when a task
// needs the model and stopped after it sits idle. Bound to 127.0.0.1 only.
// Before loading a model that would not fit next to the loaded ones, idle
// models are unloaded first.
import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../log.js';
import { RetryableError } from '../runner.js';

export interface HostedModel {
  id: string;
  file: string;
  memoryMb: number;
  contextSize: number;
  serverArgs: string[];
}

/** Gives tasks an OpenAI-compatible endpoint for a model; release when done. */
export interface ModelHost {
  acquire(model: string, signal: AbortSignal): Promise<{ endpoint: string; release(): void }>;
  stop(): Promise<void>;
}

/** Endpoint of a server I run myself (config.modelEndpoint); nothing to start. */
export class ExternalModelHost implements ModelHost {
  constructor(private readonly endpoint: string) {}
  async acquire() { return { endpoint: this.endpoint, release: () => {} }; }
  async stop() {}
}

interface Loaded {
  model: HostedModel;
  port: number;
  proc: ChildProcess;
  ready: Promise<void>;
  users: number;
  idleTimer: NodeJS.Timeout | null;
  stderrTail: string[];
  exited: boolean;
}

export interface LlamaHostOptions {
  /** Program and leading arguments, e.g. ['llama-server'] (tests use a fake server). */
  command: string[];
  models: HostedModel[];
  budgetMb: number;
  basePort: number;
  idleMs: number;
  startTimeoutMs?: number;
}

export class LlamaServerHost implements ModelHost {
  private readonly loaded = new Map<string, Loaded>();
  private stopped = false;

  constructor(private readonly o: LlamaHostOptions) {}

  async acquire(id: string, signal: AbortSignal): Promise<{ endpoint: string; release(): void }> {
    if (this.stopped) throw new RetryableError('model host is stopping');
    const model = this.o.models.find((m) => m.id === id);
    if (!model) throw new Error(`model ${id} is not installed on this node (gab-node models pull ${id})`);
    let l = this.loaded.get(id);
    if (!l) l = await this.start(model);
    l.users++;
    if (l.idleTimer) { clearTimeout(l.idleTimer); l.idleTimer = null; }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      l.users--;
      if (l.users === 0 && !l.exited) l.idleTimer = setTimeout(() => void this.unload(l, 'idle'), this.o.idleMs);
    };
    try {
      await Promise.race([l.ready, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    } catch (err) { release(); throw err; }
    return { endpoint: `http://127.0.0.1:${l.port}/v1`, release };
  }

  private async start(model: HostedModel): Promise<Loaded> {
    await this.makeRoom(model);
    const port = this.o.basePort + this.o.models.indexOf(model);
    const [program, ...prefix] = this.o.command;
    const args = [...prefix, '--model', model.file, '--host', '127.0.0.1', '--port', String(port),
      '--ctx-size', String(model.contextSize), '--n-gpu-layers', '999', '--jinja', '--alias', model.id, ...model.serverArgs];
    log.info('starting model server', { model: model.id, port });
    const proc = spawn(program!, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const l: Loaded = { model, port, proc, users: 0, idleTimer: null, stderrTail: [], exited: false, ready: Promise.resolve() };
    proc.stderr!.on('data', (d: Buffer) => {
      l.stderrTail.push(...d.toString().split('\n').filter(Boolean));
      if (l.stderrTail.length > 40) l.stderrTail.splice(0, l.stderrTail.length - 40);
    });
    const exited = new Promise<never>((_, reject) => {
      const fail = (why: string) => {
        l.exited = true;
        if (l.idleTimer) clearTimeout(l.idleTimer);
        if (this.loaded.get(model.id) === l) this.loaded.delete(model.id);
        reject(new RetryableError(`model server for ${model.id} ${why}: ${l.stderrTail.slice(-5).join(' | ')}`));
      };
      proc.on('error', (err) => fail(`could not start (${err.message})`));
      proc.on('exit', (code, sig) => {
        if (!this.stopped && l.users > 0) log.error('model server exited while in use', { model: model.id, code, sig });
        fail(`exited (code ${code ?? sig})`);
      });
    });
    exited.catch(() => {}); // observed through ready
    l.ready = Promise.race([this.waitHealthy(port, model.id), exited]);
    this.loaded.set(model.id, l);
    l.ready.then(() => log.info('model server ready', { model: model.id, port }), () => {});
    l.ready.catch(() => { if (!l.exited) void this.unload(l, 'failed to start'); });
    return l;
  }

  private async waitHealthy(port: number, id: string): Promise<void> {
    const deadline = Date.now() + (this.o.startTimeoutMs ?? 10 * 60_000);
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return;
      } catch { /* still loading */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new RetryableError(`model server for ${id} not healthy after ${Math.round((this.o.startTimeoutMs ?? 600_000) / 1000)} s`);
  }

  /** Unloads idle models until `model` fits in the budget; refuses when busy ones fill it. */
  private async makeRoom(model: HostedModel): Promise<void> {
    const used = () => [...this.loaded.values()].reduce((s, l) => s + l.model.memoryMb, 0);
    for (const l of [...this.loaded.values()].filter((x) => x.users === 0)) {
      if (used() + model.memoryMb <= this.o.budgetMb) break;
      await this.unload(l, `making room for ${model.id}`);
    }
    if (used() + model.memoryMb > this.o.budgetMb) {
      throw new RetryableError(`${model.id} (${model.memoryMb} MB) does not fit next to models in use (${used()} of ${this.o.budgetMb} MB)`);
    }
  }

  private async unload(l: Loaded, why: string): Promise<void> {
    if (l.idleTimer) { clearTimeout(l.idleTimer); l.idleTimer = null; }
    if (this.loaded.get(l.model.id) === l) this.loaded.delete(l.model.id);
    if (l.exited) return;
    log.info('stopping model server', { model: l.model.id, why });
    const gone = new Promise<void>((r) => l.proc.once('exit', () => r()));
    l.proc.kill('SIGTERM');
    const killer = setTimeout(() => l.proc.kill('SIGKILL'), 10_000);
    await gone;
    clearTimeout(killer);
  }

  /** Model ids currently loaded (for status). */
  loadedModels(): string[] { return [...this.loaded.keys()]; }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.loaded.values()].map((l) => this.unload(l, 'node stopping')));
  }
}
