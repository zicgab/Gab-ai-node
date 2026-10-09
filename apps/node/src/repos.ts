// Repo checkouts: one bare mirror per repo (fetched before each task), and one
// throwaway worktree per task under work/<task-id>. Worktrees are always removed.
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RepoName, isAgentBranch } from '@gab-ai-node/protocol';
import { exec } from './exec.js';
import { reposDir, workDir } from './paths.js';

/**
 * Env for git with the GitHub token as an HTTP header set through git's
 * GIT_CONFIG_* variables: never in a URL, a command line or a config file.
 */
export function gitEnv(token: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

export function mirrorPath(repo: string, root = reposDir()): string {
  RepoName.parse(repo);
  return path.join(root, `${repo.replace('/', '__')}.git`);
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** Clones the mirror the first time, else fetches. Returns its path. */
export async function syncMirror(repo: string, token: string | null, opts: { root?: string; remoteUrl?: string; signal?: AbortSignal } = {}): Promise<string> {
  const mirror = mirrorPath(repo, opts.root);
  const url = opts.remoteUrl ?? `https://github.com/${repo}.git`;
  const env = gitEnv(token);
  if (!(await exists(mirror))) {
    await mkdir(path.dirname(mirror), { recursive: true });
    await exec('git', ['clone', '--mirror', '--quiet', url, mirror], { env, check: true, signal: opts.signal, timeoutMs: 30 * 60_000 });
  } else {
    await exec('git', ['-C', mirror, 'fetch', '--prune', '--quiet', 'origin'], { env, check: true, signal: opts.signal, timeoutMs: 15 * 60_000 });
  }
  return mirror;
}

export interface Worktree { dir: string; commit: string; remove(): Promise<void> }

/** A detached worktree of ref (default: the mirror's HEAD) in a fresh folder. */
export async function addWorktree(mirror: string, taskId: string, label: string, ref: string | null, root = workDir()): Promise<Worktree> {
  if (ref !== null && !/^[A-Za-z0-9._\/-]{1,200}$/.test(ref)) throw new Error(`invalid ref ${ref}`);
  if (ref?.startsWith('-')) throw new Error(`invalid ref ${ref}`);
  const dir = path.join(root, taskId, label);
  await mkdir(path.dirname(dir), { recursive: true });
  const target = ref ?? 'HEAD';
  const resolved = await exec('git', ['-C', mirror, 'rev-parse', '--verify', '--quiet', `${target}^{commit}`]);
  if (resolved.code !== 0) throw new Error(`ref ${target} not found in ${path.basename(mirror)}`);
  const commit = resolved.stdout.trim();
  await exec('git', ['-C', mirror, 'worktree', 'add', '--detach', '--quiet', dir, commit], { check: true });
  return {
    dir,
    commit,
    remove: async () => {
      await exec('git', ['-C', mirror, 'worktree', 'remove', '--force', dir]);
      await rm(dir, { recursive: true, force: true });
      await exec('git', ['-C', mirror, 'worktree', 'prune']);
    },
  };
}

/** Untracked entries as git shows them (folders collapsed, e.g. "node_modules/"). */
export async function untrackedEntries(dir: string): Promise<Set<string>> {
  const out = (await exec('git', ['-C', dir, 'status', '--porcelain', '-z'], { check: true })).stdout;
  return new Set(out.split('\0').filter((e) => e.startsWith('?? ')).map((e) => e.slice(3)));
}

/**
 * Makes the untracked files that appeared since `before` invisible to git in THIS worktree only
 * (a per-worktree core.excludesFile), so files made by the repo's setup (node_modules, build
 * output not in .gitignore) are never committed and never count as changes outside the task's folders.
 */
export async function ignoreNewUntracked(dir: string, before: Set<string>): Promise<string[]> {
  const added = [...(await untrackedEntries(dir))].filter((e) => !before.has(e));
  if (added.length === 0) return [];
  const file = `${dir}.setup-exclude`;
  await writeFile(file, added.map((e) => `/${e.replace(/([*?[\\!#])/g, '\\$1')}`).join('\n') + '\n');
  await exec('git', ['-C', dir, 'config', 'extensions.worktreeConfig', 'true'], { check: true });
  await exec('git', ['-C', dir, 'config', '--worktree', 'core.excludesFile', file], { check: true });
  return added;
}

/** Removes leftovers of tasks interrupted by a crash (run at start). */
export async function cleanWorkDir(root = workDir()): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}

/**
 * Commits everything changed in the worktree and pushes it to branch, which
 * must be an agent branch and the task's own. Pushes to the repo URL with an
 * explicit refspec (never to the mirror's "origin", whose mirror setting would
 * push every ref) and never forces. Returns the commit, or null if nothing changed.
 */
export async function commitAndPush(opts: {
  dir: string; repo: string; branch: string; taskBranch: string | null; message: string;
  token: string | null; author: string; remoteUrl?: string; signal?: AbortSignal;
}): Promise<string | null> {
  if (opts.taskBranch === null) throw new Error('this task may not push (no agent branch)');
  if (opts.branch !== opts.taskBranch) throw new Error(`refusing to push ${opts.branch}: the task's branch is ${opts.taskBranch}`);
  if (!isAgentBranch(opts.branch)) throw new Error(`refusing to push ${opts.branch}: not an agent/** branch`);
  const message = opts.message.trim().slice(0, 5_000);
  if (!message) throw new Error('commit message is empty');

  await exec('git', ['-C', opts.dir, 'add', '-A'], { check: true });
  const staged = await exec('git', ['-C', opts.dir, 'diff', '--cached', '--quiet']);
  if (staged.code === 0) return null;
  const email = `${opts.author}@gab-ai-node.invalid`;
  await exec('git', ['-C', opts.dir, '-c', `user.name=gab-ai-node (${opts.author})`, '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--no-verify', '-F', '-'], { check: true, input: message });
  const commit = (await exec('git', ['-C', opts.dir, 'rev-parse', 'HEAD'], { check: true })).stdout.trim();
  const url = opts.remoteUrl ?? `https://github.com/${RepoName.parse(opts.repo)}.git`;
  await exec('git', ['-C', opts.dir, 'push', '--quiet', '--no-verify', url, `HEAD:refs/heads/${opts.branch}`],
    { env: gitEnv(opts.token), check: true, signal: opts.signal, timeoutMs: 10 * 60_000 });
  return commit;
}
