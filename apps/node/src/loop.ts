// The node's main loop: claim tasks while allowed, heartbeat the running ones,
// stop any the coordinator says are no longer held, enforce time budgets, and
// always report the outcome (complete or fail) and clean up the worktree.
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Capabilities, ClaimResponse, GithubToken, TaskKind, TaskResult, TaskSpec } from '@gab-ai-node/protocol';
import { HEARTBEAT_SECONDS } from '@gab-ai-node/protocol';
import { ApiError, type CoordinatorClient } from './client.js';
import type { NodeConfig } from './config.js';
import { modelsThatFit } from './fit.js';
import { ExternalModelHost, type ModelHost } from './models/server.js';
import { log } from './log.js';
import { modelFor } from './models/pick.js';
import { pauseFile, reposDir, workDir } from './paths.js';
import { addWorktree, cleanWorkDir, commitAndPush, syncMirror, type Worktree } from './repos.js';
import { RetryableError, type TaskContext, type TaskRunner } from './runner.js';

type StopReason = 'cancelled' | 'budget' | 'shutdown';

interface Running {
  task: TaskSpec;
  leaseId: string;
  abort: AbortController;
  reason: StopReason | null;
  model: string | null;
  events: { type: string; data: Record<string, unknown> }[];
  done: Promise<void>;
  /** Per-task GitHub App token from the claim (null: use the node's own read token). */
  github: GithubToken | null;
}

export interface NodeDeps {
  config: NodeConfig;
  client: CoordinatorClient;
  runners: TaskRunner[];
  capabilities: () => Promise<Capabilities>;
  secrets: { github: string | null; anthropic: string | null };
  /** Overridable for tests. */
  reposRoot?: string;
  workRoot?: string;
  remoteUrl?: (repo: string) => string;
  isLocallyPaused?: () => boolean;
  /** Serves models to tasks; default: the external server at config.modelEndpoint. */
  modelHost?: ModelHost;
  idleMs?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class NodeAgent {
  private readonly running = new Map<string, Running>();
  private readonly stopping = new AbortController();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private loopDone: Promise<void> | null = null;
  private heartbeats = 0;

  private readonly modelHost: ModelHost;

  constructor(private readonly d: NodeDeps) {
    this.modelHost = d.modelHost ?? new ExternalModelHost(d.config.modelEndpoint);
  }

  private get kinds(): TaskKind[] {
    return [...new Set(this.d.runners.flatMap((r) => r.kinds))];
  }

  private locallyPaused(): boolean {
    return this.d.isLocallyPaused ? this.d.isLocallyPaused() : existsSync(pauseFile());
  }

  async start(): Promise<void> {
    await cleanWorkDir(this.d.workRoot ?? workDir());
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_SECONDS * 1000);
    this.loopDone = this.claimLoop();
    log.info('node started', { name: this.d.config.name, kinds: this.kinds, backends: this.d.config.backends });
  }

  /** Stops claiming, stops running tasks (reported as retryable so another node can take them), waits. */
  async stop(): Promise<void> {
    this.stopping.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const r of this.running.values()) this.abortTask(r, 'shutdown');
    await Promise.allSettled([this.loopDone, ...[...this.running.values()].map((r) => r.done)]);
    await this.modelHost.stop().catch((err) => log.error('stopping model servers failed', { err }));
    log.info('node stopped');
  }

  private abortTask(r: Running, reason: StopReason): void {
    if (r.reason) return;
    r.reason = reason;
    r.abort.abort(new Error(reason));
  }

  private async claimLoop(): Promise<void> {
    const idle = this.d.idleMs ?? 5_000;
    let backoff = idle;
    let warnedNoKinds = false;
    while (!this.stopping.signal.aborted) {
      const { config } = this.d;
      if (this.kinds.length === 0) {
        if (!warnedNoKinds) log.warn('no task runners installed: not claiming');
        warnedNoKinds = true;
        await sleep(60_000, this.stopping.signal);
        continue;
      }
      if (this.locallyPaused() || this.running.size >= config.maxConcurrent) {
        await sleep(idle, this.stopping.signal);
        continue;
      }
      const runningModels = [...this.running.values()].map((r) => r.model).filter((m): m is string => !!m);
      const fit = modelsThatFit(config.models, runningModels, config.memoryBudgetMb);
      // Tasks without a model use the default one: don't claim if it can't load now.
      if (config.backends.includes('local') && config.defaultModel && !fit.includes(config.defaultModel)) {
        await sleep(idle, this.stopping.signal);
        continue;
      }
      let res: ClaimResponse;
      try {
        res = await this.d.client.claim({ acceptModels: fit, acceptKinds: this.kinds, acceptBackends: config.backends, wait: true }, this.stopping.signal);
        backoff = idle;
      } catch (err) {
        if (this.stopping.signal.aborted) break;
        const revoked = err instanceof ApiError && err.status === 401;
        log.error(revoked ? 'node token rejected (node turned off or registered again elsewhere): run gab-node register again' : 'claim failed', { err });
        backoff = Math.min(revoked ? 300_000 : 60_000, backoff * 2);
        await sleep(backoff, this.stopping.signal);
        continue;
      }
      if (!res.available) { await sleep(Math.max(idle, 30_000), this.stopping.signal); continue; }
      if (res.task && res.leaseId) this.startTask(res.task, res.leaseId, res.github);
    }
  }

  private startTask(task: TaskSpec, leaseId: string, github: GithubToken | null): void {
    const r: Running = {
      task, leaseId, abort: new AbortController(), reason: null, github,
      model: task.backend === 'local' ? modelFor(task, this.d.config) : null,
      events: [], done: Promise.resolve(),
    };
    this.running.set(task.id, r);
    log.info('task started', { taskId: task.id, kind: task.kind, repo: task.repo, attempt: task.attempt, model: r.model });
    r.done = this.runTask(r).finally(() => this.running.delete(task.id));
  }

  private async runTask(r: Running): Promise<void> {
    const { task } = r;
    const runner = this.d.runners.find((x) => x.kinds.includes(task.kind));
    const budget = setTimeout(() => this.abortTask(r, 'budget'), task.budget.maxMinutes * 60_000);
    const flush = setInterval(() => void this.flushEvents(r), 5_000);
    const trees: Worktree[] = [];
    const releases: (() => void)[] = [];
    const endpoints = new Map<string, Promise<string>>();
    let outcome: { result: TaskResult } | { error: string; retryable: boolean };
    try {
      if (!runner) throw new Error(`no runner for task kind ${task.kind}`);
      const root = this.d.workRoot ?? workDir();
      const prepare = async (repo: string, label: string, ref: string | null) => {
        const mirror = await syncMirror(repo, r.github?.token ?? this.d.secrets.github, { root: this.d.reposRoot ?? reposDir(), remoteUrl: this.d.remoteUrl?.(repo), signal: r.abort.signal });
        const tree = await addWorktree(mirror, task.id, label, ref, root);
        trees.push(tree);
        return tree;
      };
      // A chat message has no repo: nothing to fetch.
      let main: Worktree | null = null;
      if (task.repo) {
        try { main = await prepare(task.repo, 'repo', task.ref); }
        catch (err) { throw new RetryableError(`preparing ${task.repo} failed: ${(err as Error).message}`); }
      }
      const extraDirs: Record<string, string> = {};
      for (const [i, repo] of task.extraRepos.entries()) extraDirs[repo] = (await prepare(repo, `extra-${i}`, null)).dir;

      const ctx: TaskContext = {
        task, config: this.d.config, workdir: main?.dir ?? '', extraDirs, signal: r.abort.signal, secrets: this.d.secrets,
        modelEndpoint: (model) => {
          let p = endpoints.get(model);
          if (!p) {
            p = this.modelHost.acquire(model, r.abort.signal).then((a) => { releases.push(a.release); return a.endpoint; });
            endpoints.set(model, p);
          }
          return p;
        },
        commitAndPush: async (message) => {
          if (!main || !task.repo) throw new Error('this task has no repo to commit to');
          if (!r.github?.canPush) throw new Error('this task has no GitHub write token (repo not pushable, or no GitHub App on the coordinator)');
          // Installation tokens last 1 hour: refresh when less than 10 minutes are left.
          if (Date.parse(r.github.expiresAt) - Date.now() < 10 * 60_000) r.github = await this.d.client.githubToken(task.id, r.leaseId);
          const commit = await commitAndPush({
            dir: main.dir, repo: task.repo, branch: task.branch ?? '', taskBranch: task.branch, message,
            token: r.github.token, author: this.d.config.name, remoteUrl: this.d.remoteUrl?.(task.repo), signal: r.abort.signal,
          });
          if (commit) ctx.emit('progress', { stage: 'pushed', branch: task.branch, commit });
          return commit;
        },
        emit: (type, data) => { r.events.push({ type, data }); if (r.events.length >= 50) void this.flushEvents(r); },
      };
      ctx.emit('progress', { stage: 'started', commit: main?.commit ?? null });
      const result = await runner.run(ctx);
      if (r.reason) throw new Error(r.reason);
      outcome = { result };
    } catch (err) {
      const message = (err as Error).message;
      if (r.reason === 'budget') outcome = { error: `time budget of ${task.budget.maxMinutes} min exceeded`, retryable: false };
      else if (r.reason === 'shutdown') outcome = { error: 'node shutting down', retryable: true };
      else outcome = { error: message, retryable: err instanceof RetryableError };
    } finally {
      clearTimeout(budget);
      clearInterval(flush);
      for (const release of releases) release();
      for (const t of trees.reverse()) await t.remove().catch((err) => log.error('worktree cleanup failed', { taskId: task.id, err }));
      await rm(path.join(this.d.workRoot ?? workDir(), task.id), { recursive: true, force: true })
        .catch((err) => log.error('task folder cleanup failed', { taskId: task.id, err }));
    }

    if (r.reason === 'cancelled') {
      log.warn('task stopped: cancelled or lease lost', { taskId: task.id });
      return; // the coordinator already moved it on; nothing to report
    }
    await this.flushEvents(r);
    const onRetry = (err: Error, n: number) => log.warn('report failed, retrying', { taskId: task.id, attempt: n, err });
    try {
      if ('result' in outcome) {
        await this.d.client.complete(task.id, r.leaseId, outcome.result, onRetry);
        log.info('task completed', { taskId: task.id, findings: outcome.result.findings.length, branch: outcome.result.branch });
      } else {
        await this.d.client.fail(task.id, r.leaseId, outcome.error, outcome.retryable, onRetry);
        log.warn('task failed', { taskId: task.id, error: outcome.error, retryable: outcome.retryable });
      }
    } catch (err) {
      log.error('could not report task outcome (lease will expire and the task will be retried)', { taskId: task.id, err });
    }
  }

  private async flushEvents(r: Running): Promise<void> {
    if (r.events.length === 0) return;
    const batch = r.events.splice(0, 100);
    try { await this.d.client.events(r.task.id, r.leaseId, batch); }
    catch (err) {
      if (err instanceof ApiError && err.status === 409) { this.abortTask(r, 'cancelled'); return; }
      log.warn('sending task events failed; dropped', { taskId: r.task.id, count: batch.length, err });
    }
  }

  async heartbeat(): Promise<void> {
    const list = [...this.running.values()].map((r) => ({ taskId: r.task.id, leaseId: r.leaseId }));
    try {
      // Full capabilities every 10th beat (disk, tools change rarely).
      const caps = this.heartbeats++ % 10 === 0 ? await this.d.capabilities() : undefined;
      const res = await this.d.client.heartbeat(list, caps);
      for (const id of res.cancel) {
        const r = this.running.get(id);
        if (r) this.abortTask(r, 'cancelled');
      }
    } catch (err) {
      log.warn('heartbeat failed (tasks keep running until the lease expires)', { err });
    }
  }

  /** For status output and tests. */
  get runningTaskIds(): string[] { return [...this.running.keys()]; }
}
