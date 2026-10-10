// The node needs Docker for every task kind that runs commands. When Docker is not running it starts it itself,
// without a window or a question, so a rebooted or logged-out machine gets back to work alone.
// Turn it off with: gab-node settings docker-autostart off
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exec, has } from './exec.js';
import { log } from './log.js';

/** How to start Docker in the background; null when it is not possible without sudo. */
export function dockerStartCommand(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | null {
  switch (platform) {
    case 'darwin': return { command: 'open', args: ['-g', '-j', '-a', 'Docker'] }; // background, window hidden
    case 'win32': return { command: path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'), args: [] };
    case 'linux': return { command: 'systemctl', args: ['--user', 'start', 'docker'] }; // rootless Docker; the system service needs sudo
    default: return null;
  }
}

/** Docker Desktop's settings file (macOS, Windows); Linux runs Docker Engine without a window. */
export function dockerDesktopSettingsFile(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform === 'darwin') return path.join(env.HOME ?? '', 'Library', 'Group Containers', 'group.com.docker', 'settings-store.json');
  if (platform === 'win32') return path.join(env.APPDATA ?? '', 'Docker', 'settings-store.json');
  return null;
}

/** Docker Desktop must never open its window (the dashboard) when the node starts it; it also starts at login. */
export async function quietDockerDesktop(file: string | null = dockerDesktopSettingsFile()): Promise<void> {
  if (!file) return;
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`cannot read ${file}: ${(err as Error).message}`); }
  if (settings.OpenUIOnStartupDisabled === true && settings.AutoStart === true) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...settings, OpenUIOnStartupDisabled: true, AutoStart: true }, null, 2));
}

/** Starts Docker and returns at once (it needs a minute or two to come up; the next health check sees it). */
export async function startDocker(platform: NodeJS.Platform = process.platform): Promise<void> {
  const plan = dockerStartCommand(platform);
  if (!plan) throw new Error(`Docker cannot be started automatically on ${platform}`);
  if (!(await has('docker'))) throw new Error('Docker is not installed (no "docker" command): install Docker Desktop, then the node can start it');
  try { await quietDockerDesktop(dockerDesktopSettingsFile(platform)); }
  catch (err) { log.warn('could not turn off the Docker Desktop window (it may open once)', { err: (err as Error).message }); }
  if (platform === 'win32') {
    const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => log.warn('could not start Docker Desktop', { err }));
    child.unref();
    return;
  }
  const r = await exec(plan.command, plan.args, { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`${plan.command} ${plan.args.join(' ')} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
}

export interface DockerEnsurerOptions {
  enabled: () => boolean;
  isUp: () => Promise<boolean>;
  start: () => Promise<void>;
  /** Least time between two start attempts (Docker needs a while to come up; do not start it again meanwhile). */
  retryMs?: number;
  now?: () => number;
}

/** Whether Docker is running; when it is not and autostart is on, starts it (at most once per retryMs). */
export function createDockerEnsurer(o: DockerEnsurerOptions): () => Promise<boolean> {
  const retryMs = o.retryMs ?? 5 * 60_000;
  const now = o.now ?? Date.now;
  let lastTry = -Infinity;
  return async () => {
    if (await o.isUp()) return true;
    if (!o.enabled() || now() - lastTry < retryMs) return false;
    lastTry = now();
    log.info('Docker is not running: starting it');
    try { await o.start(); }
    catch (err) { log.warn('could not start Docker (kinds that run commands stay held back; start it by hand)', { err: (err as Error).message }); }
    return false;
  };
}
