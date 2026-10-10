// Checked before every claim (cached for a short while): a node only claims the task kinds it
// can run right now. Docker Desktop quit: no kinds that run commands. Model server down or disk
// almost full: nothing at all. Without this, tasks are claimed, fail and burn their retries.
// Also nothing while the machine is on battery (unless allowed) or busy above the CPU/memory limits,
// so the node never piles work on a computer that is already loaded. A running task is not slowed.
import { access, readdir, readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TaskKind } from '@gab-ai-node/protocol';
import type { NodeConfig } from './config.js';
import { createDockerEnsurer, startDocker } from './docker.js';
import { exec } from './exec.js';
import { log } from './log.js';
import { llamaServerBin } from './paths.js';

export interface HealthState {
  docker: boolean;
  /** llama-server is installed (the node starts it per model, on demand). */
  model: boolean;
  /** Free space where repos and worktrees live, in MB (null: unknown). */
  freeDiskMb: number | null;
  /** The computer runs on battery now (null: no battery, or unknown). */
  onBattery?: boolean | null;
  /** Whole-machine CPU and memory use in percent (null: unknown). */
  cpuPercent?: number | null;
  memoryPercent?: number | null;
}

export interface Limits { runOnBattery: boolean; maxCpuPercent: number; maxMemoryPercent: number }

/** Kinds this node may claim now, and why the others are held back (for the log). */
export function allowedKinds(kinds: TaskKind[], state: HealthState, dockerKinds: ReadonlySet<TaskKind>, minFreeDiskMb: number, limits?: Limits): { kinds: TaskKind[]; reason: string | null } {
  if (!state.model) return { kinds: [], reason: 'llama-server is not installed (run update.sh / update.ps1)' };
  if (state.freeDiskMb !== null && state.freeDiskMb < minFreeDiskMb) return { kinds: [], reason: `only ${state.freeDiskMb} MB free disk (minimum ${minFreeDiskMb})` };
  if (limits) {
    if (state.onBattery && !limits.runOnBattery) return { kinds: [], reason: 'running on battery (allow with "gab-node settings battery on")' };
    if (state.cpuPercent != null && state.cpuPercent > limits.maxCpuPercent) return { kinds: [], reason: `CPU at ${state.cpuPercent}% (limit ${limits.maxCpuPercent}%)` };
    if (state.memoryPercent != null && state.memoryPercent > limits.maxMemoryPercent) return { kinds: [], reason: `memory at ${state.memoryPercent}% (limit ${limits.maxMemoryPercent}%)` };
  }
  if (state.docker) return { kinds, reason: null };
  const left = kinds.filter((k) => !dockerKinds.has(k));
  return { kinds: left, reason: left.length < kinds.length ? 'Docker not running: kinds that run commands are held back' : null };
}

/**
 * True when the Docker daemon answers. `docker info --format` exits 0 with an empty line when the
 * daemon is down, so the server version must actually come back.
 */
export async function dockerRunning(run: typeof exec = exec): Promise<boolean> {
  const r = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 });
  return r.code === 0 && r.stdout.trim() !== '';
}

/** The node starts llama-server per task: it is enough that the installed program is there. */
export async function modelServerUp(binary: string = llamaServerBin()): Promise<boolean> {
  try { await access(binary); return true; } catch { return false; }
}

export async function freeDiskMb(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Math.floor((s.bavail * s.bsize) / 1024 / 1024);
  } catch { return null; }
}

/** macOS "pmset -g batt" output: on battery when it says so. */
export function parsePmset(out: string): boolean | null {
  if (/'Battery Power'/.test(out)) return true;
  if (/'AC Power'/.test(out)) return false;
  return null;
}

/** Linux /sys/class/power_supply entries: on battery when a battery exists and no mains supply is online. */
export function linuxOnBattery(supplies: { type: string; online: string | null; status: string | null }[]): boolean | null {
  const batteries = supplies.filter((s) => s.type === 'Battery');
  if (batteries.length === 0) return null;
  const mains = supplies.filter((s) => s.type === 'Mains' || s.type === 'USB');
  if (mains.some((s) => s.online === '1')) return false;
  if (mains.length) return true;
  return batteries.some((b) => b.status === 'Discharging');
}

export async function onBattery(platform = process.platform): Promise<boolean | null> {
  try {
    if (platform === 'darwin') {
      const r = await exec('pmset', ['-g', 'batt'], { timeoutMs: 5_000 });
      return r.code === 0 ? parsePmset(r.stdout) : null;
    }
    if (platform === 'linux') {
      const base = '/sys/class/power_supply';
      const read = (f: string) => readFile(f, 'utf8').then((s) => s.trim(), () => null);
      const names = await readdir(base).catch(() => [] as string[]);
      const supplies = await Promise.all(names.map(async (n) => ({ type: (await read(path.join(base, n, 'type'))) ?? '', online: await read(path.join(base, n, 'online')), status: await read(path.join(base, n, 'status')) })));
      return linuxOnBattery(supplies);
    }
    if (platform === 'win32') {
      // BatteryStatus 1 = discharging (on battery); no output = no battery.
      const r = await exec('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery).BatteryStatus'], { timeoutMs: 10_000 });
      const v = r.stdout.trim().split(/\s+/)[0];
      return r.code === 0 && v ? v === '1' : null;
    }
  } catch (err) {
    log.warn('battery check failed', { error: (err as Error).message });
  }
  return null;
}

/** CPU use of the whole machine in percent, measured over sampleMs. */
export async function cpuPercent(sampleMs = 1_000): Promise<number | null> {
  const total = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.all += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, all: 0 });
  const a = total();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = total();
  const all = b.all - a.all;
  return all > 0 ? Math.round(100 * (1 - (b.idle - a.idle) / all)) : null;
}

/** macOS "vm_stat": memory the system can give back (free, inactive, speculative, purgeable pages) counts as available. */
export function parseVmStat(out: string, totalBytes: number): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  const pages = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
  if (!page) return null;
  const available = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * page;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - available / totalBytes))));
}

/** `ps -axo rss=,comm=` output: resident KB of the node's own llama-server processes, in bytes. */
export function parseOwnModelRss(out: string): number {
  let kb = 0;
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && /(^|\/)llama-server$/.test(m[2]!)) kb += Number(m[1]);
  }
  return kb * 1024;
}

/** Memory held by the node's own model servers (a loaded model is the node's work, not another app's). */
async function ownModelBytes(platform: typeof process.platform): Promise<number> {
  if (platform !== 'darwin' && platform !== 'linux') return 0;
  const r = await exec('ps', ['-axo', 'rss=,comm='], { timeoutMs: 5_000 });
  if (r.code !== 0) { log.warn('ps failed; the loaded model counts as memory in use', { code: r.code }); return 0; }
  return parseOwnModelRss(r.stdout);
}

/**
 * Memory use of the machine in percent, not counting the node's own model servers: otherwise a
 * loaded 120B model (kept between tasks) holds the node above the limit and it never claims again.
 */
export async function memoryPercent(platform = process.platform): Promise<number | null> {
  const used = await machineMemoryPercent(platform);
  if (used === null) return null;
  const own = await ownModelBytes(platform).catch((err: unknown) => { log.warn('model memory check failed', { error: (err as Error).message }); return 0; });
  return Math.max(0, Math.round(used - (100 * own) / os.totalmem()));
}

/** Memory use of the whole machine in percent. os.freemem() alone overstates use on macOS and Linux (caches count as used). */
async function machineMemoryPercent(platform: typeof process.platform): Promise<number | null> {
  const total = os.totalmem();
  try {
    if (platform === 'darwin') {
      const r = await exec('vm_stat', [], { timeoutMs: 5_000 });
      if (r.code === 0) return parseVmStat(r.stdout, total);
    } else if (platform === 'linux') {
      const kb = Number(/MemAvailable:\s+(\d+)/.exec(await readFile('/proc/meminfo', 'utf8'))?.[1]);
      if (kb) return Math.round(100 * (1 - (kb * 1024) / total));
    }
  } catch (err) {
    log.warn('memory check failed', { error: (err as Error).message });
  }
  return Math.round(100 * (1 - os.freemem() / total));
}

/** The real checks, cached for ttlMs; logs each change of state once (not every claim). */
export function createHealthCheck(config: NodeConfig, dir: string, ttlMs = 30_000): () => Promise<HealthState> {
  let cached: { at: number; state: HealthState } | null = null;
  let last = '';
  const docker = createDockerEnsurer({ enabled: () => config.dockerAutoStart, isUp: dockerRunning, start: () => startDocker() });
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.state;
    const [dockerUp, model, disk, battery, cpu, mem] = await Promise.all([docker(), modelServerUp(), freeDiskMb(dir), onBattery(), cpuPercent(), memoryPercent()]);
    const state: HealthState = { docker: dockerUp, model, freeDiskMb: disk, onBattery: battery, cpuPercent: cpu, memoryPercent: mem };
    const busy = (cpu ?? 0) > config.maxCpuPercent || (mem ?? 0) > config.maxMemoryPercent;
    const key = `${dockerUp}|${model}|${disk !== null && disk < config.minFreeDiskMb}|${battery}|${busy}`;
    if (key !== last) {
      (dockerUp && model && !busy ? log.info : log.warn)('health', { docker: dockerUp, modelServer: model, freeDiskMb: disk, onBattery: battery, cpuPercent: cpu, memoryPercent: mem });
      last = key;
    }
    cached = { at: Date.now(), state };
    return state;
  };
}
