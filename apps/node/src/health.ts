// Checked before every claim (cached for a short while): a node only claims the task kinds it
// can run right now. Docker Desktop quit: no kinds that run commands. Model server down or disk
// almost full: nothing at all. Without this, tasks are claimed, fail and burn their retries.
import { statfs } from 'node:fs/promises';
import type { TaskKind } from '@gab-ai-node/protocol';
import type { NodeConfig } from './config.js';
import { exec, has } from './exec.js';
import { log } from './log.js';

export interface HealthState {
  docker: boolean;
  model: boolean;
  /** Free space where repos and worktrees live, in MB (null: unknown). */
  freeDiskMb: number | null;
}

/** Kinds this node may claim now, and why the others are held back (for the log). */
export function allowedKinds(kinds: TaskKind[], state: HealthState, dockerKinds: ReadonlySet<TaskKind>, minFreeDiskMb: number): { kinds: TaskKind[]; reason: string | null } {
  if (!state.model) return { kinds: [], reason: 'model server not reachable' };
  if (state.freeDiskMb !== null && state.freeDiskMb < minFreeDiskMb) return { kinds: [], reason: `only ${state.freeDiskMb} MB free disk (minimum ${minFreeDiskMb})` };
  if (state.docker) return { kinds, reason: null };
  const left = kinds.filter((k) => !dockerKinds.has(k));
  return { kinds: left, reason: left.length < kinds.length ? 'Docker not running: kinds that run commands are held back' : null };
}

export async function dockerRunning(): Promise<boolean> {
  return (await exec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 })).code === 0;
}

export async function modelServerUp(config: Pick<NodeConfig, 'modelEndpoint' | 'modelServer'>, fetchFn: typeof fetch = fetch): Promise<boolean> {
  // Managed mode starts llama-server per task: it is enough that the program is there.
  if (config.modelServer.mode === 'managed') return has(config.modelServer.binary);
  try {
    const res = await fetchFn(`${config.modelEndpoint.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch { return false; }
}

export async function freeDiskMb(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Math.floor((s.bavail * s.bsize) / 1024 / 1024);
  } catch { return null; }
}

/** The real checks, cached for ttlMs; logs each change of state once (not every claim). */
export function createHealthCheck(config: NodeConfig, dir: string, ttlMs = 30_000): () => Promise<HealthState> {
  let cached: { at: number; state: HealthState } | null = null;
  let last = '';
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.state;
    const [docker, model, disk] = await Promise.all([dockerRunning(), modelServerUp(config), freeDiskMb(dir)]);
    const state: HealthState = { docker, model, freeDiskMb: disk };
    const key = `${docker}|${model}|${disk !== null && disk < config.minFreeDiskMb}`;
    if (key !== last) {
      (docker && model ? log.info : log.warn)('health', { docker, modelServer: model, freeDiskMb: disk, endpoint: config.modelEndpoint });
      last = key;
    }
    cached = { at: Date.now(), state };
    return state;
  };
}
