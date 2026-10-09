// Keeps a long-running node tidy: log files that do not grow forever, repo mirrors of repos
// no longer used, stale worktree entries left by a crash, and (macOS) no sleep mid-task.
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, readdir, rename, rm, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { exec } from './exec.js';
import { log } from './log.js';

/**
 * Rotates every *.log in dir bigger than maxBytes: .log -> .log.1 -> .log.2 ... (keep copies).
 * Copies then truncates in place, because launchd keeps the file open and appends to it.
 */
export async function rotateLogs(dir: string, maxBytes = 20 * 1024 * 1024, keep = 3): Promise<string[]> {
  const rotated: string[] = [];
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith('.log'))) {
    const file = path.join(dir, name);
    const s = await stat(file).catch(() => null);
    if (!s || s.size <= maxBytes) continue;
    await rm(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
    await copyFile(file, `${file}.1`);
    await truncate(file, 0);
    rotated.push(name);
  }
  return rotated;
}

/**
 * Removes stale worktree entries in every mirror (a crash leaves them behind), and deletes
 * mirrors not fetched for maxAgeDays (a repo the node no longer works on). Returns removed mirrors.
 */
export async function pruneMirrors(root: string, maxAgeDays = 30, now = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith('.git'))) {
    const mirror = path.join(root, name);
    // FETCH_HEAD is written by every fetch; a fresh clone has none yet, so fall back to the folder.
    const s = (await stat(path.join(mirror, 'FETCH_HEAD')).catch(() => null)) ?? (await stat(mirror).catch(() => null));
    if (!s) continue;
    if (now - s.mtimeMs > maxAgeDays * 86_400_000) {
      await rm(mirror, { recursive: true, force: true });
      removed.push(name);
      continue;
    }
    await exec('git', ['-C', mirror, 'worktree', 'prune']);
  }
  return removed;
}

/** macOS: keeps the machine awake while at least one task runs ("caffeinate -i"). Elsewhere: nothing. */
export class KeepAwake {
  private child: ChildProcess | null = null;
  private count = 0;
  constructor(private readonly platform = process.platform, private readonly command = 'caffeinate') {}

  acquire(): void {
    if (this.count++ > 0 || this.platform !== 'darwin') return;
    try {
      this.child = spawn(this.command, ['-i'], { stdio: 'ignore' });
      this.child.on('error', (err) => { log.warn('caffeinate failed: the Mac may sleep during tasks', { err }); this.child = null; });
    } catch (err) { log.warn('caffeinate failed: the Mac may sleep during tasks', { err: err as Error }); }
  }

  release(): void {
    if (this.count === 0) return;
    if (--this.count > 0) return;
    this.child?.kill();
    this.child = null;
  }

  get active(): boolean { return this.child !== null; }
}
