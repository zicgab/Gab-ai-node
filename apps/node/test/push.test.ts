import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { addWorktree, commitAndPush, syncMirror } from '../src/repos.js';
import { exec } from '../src/exec.js';

let origin: string; let tree: Awaited<ReturnType<typeof addWorktree>>;
const branch = 'agent/mac/1234abcd-fix-login';
const refs = async () => (await exec('git', ['-C', origin, 'for-each-ref', '--format=%(refname) %(objectname)'], { check: true })).stdout;

beforeEach(async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'gab-push-'));
  origin = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  await exec('git', ['init', '-q', '-b', 'main', seed], { check: true });
  await writeFile(path.join(seed, 'a.txt'), 'v1');
  await exec('git', ['-C', seed, 'add', '.'], { check: true });
  await exec('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { check: true });
  await exec('git', ['-C', seed, 'branch', 'dev'], { check: true });
  await exec('git', ['clone', '-q', '--bare', seed, origin], { check: true });
  const mirror = await syncMirror('zicgab/demo', null, { root: path.join(tmp, 'repos'), remoteUrl: origin });
  tree = await addWorktree(mirror, 'task1', 'repo', null, path.join(tmp, 'work'));
});

const push = (over: Partial<Parameters<typeof commitAndPush>[0]> = {}) => commitAndPush({
  dir: tree.dir, repo: 'zicgab/demo', branch, taskBranch: branch, message: 'fix: login', token: null, author: 'mac', remoteUrl: origin, ...over,
});

describe('commitAndPush', () => {
  it('pushes only the agent branch; main and dev are untouched', async () => {
    const before = await refs();
    await writeFile(path.join(tree.dir, 'a.txt'), 'v2');
    const commit = await push();
    expect(commit).toMatch(/^[a-f0-9]{40}$/);
    const after = await refs();
    expect(after).toContain(`refs/heads/${branch} ${commit}`);
    const keep = (s: string) => s.split('\n').filter((l) => !l.includes('agent/')).join('\n');
    expect(keep(after)).toBe(keep(before));
    const author = (await exec('git', ['-C', origin, 'log', '-1', '--format=%an', commit!], { check: true })).stdout.trim();
    expect(author).toBe('gab-ai-node (mac)');
  });

  it('returns null when nothing changed', async () => expect(await push()).toBeNull());

  it.each([
    ['main', { branch: 'main', taskBranch: 'main' }],
    ['another task branch', { branch: 'agent/mac/other' }],
    ['a task without a branch', { taskBranch: null }],
  ])('refuses to push %s', async (_n, over) => {
    await writeFile(path.join(tree.dir, 'a.txt'), 'v3');
    const before = await refs();
    await expect(push(over as never)).rejects.toThrow(/refusing|may not push/);
    expect(await refs()).toBe(before);
  });

  it('never force-pushes over a moved branch', async () => {
    await writeFile(path.join(tree.dir, 'a.txt'), 'v2');
    await push();
    await exec('git', ['-C', tree.dir, 'reset', '-q', '--hard', 'HEAD~1'], { check: true });
    await writeFile(path.join(tree.dir, 'a.txt'), 'other');
    await expect(push()).rejects.toThrow(/push/);
  });
});
