import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { addWorktree, collectChanges, commitLocal, syncMirror } from '../src/repos.js';
import { exec } from '../src/exec.js';

// Nodes never push: they commit locally and upload the change; the backend commits it on GitHub.
let origin: string; let tree: Awaited<ReturnType<typeof addWorktree>>;
const branch = 'agent/mac/1234abcd-fix-login';
const refs = async () => (await exec('git', ['-C', origin, 'for-each-ref', '--format=%(refname) %(objectname)'], { check: true })).stdout;

beforeEach(async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'gab-push-'));
  origin = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  await exec('git', ['init', '-q', '-b', 'main', seed], { check: true });
  await writeFile(path.join(seed, 'a.txt'), 'v1');
  await writeFile(path.join(seed, 'gone.txt'), 'bye');
  await exec('git', ['-C', seed, 'add', '.'], { check: true });
  await exec('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { check: true });
  await exec('git', ['clone', '-q', '--bare', seed, origin], { check: true });
  const mirror = await syncMirror('zicgab/demo', null, { root: path.join(tmp, 'repos'), remoteUrl: origin });
  tree = await addWorktree(mirror, 'task1', 'repo', null, path.join(tmp, 'work'));
});

const commit = (over: Partial<Parameters<typeof commitLocal>[0]> = {}) =>
  commitLocal({ dir: tree.dir, branch, taskBranch: branch, message: 'fix: login', author: 'mac', ...over });

describe('commitLocal + collectChanges', () => {
  it('commits locally only (origin untouched) and lists added, changed, deleted, executable and binary files', async () => {
    const before = await refs();
    await writeFile(path.join(tree.dir, 'a.txt'), 'v2');
    await writeFile(path.join(tree.dir, 'run.sh'), '#!/bin/sh\n');
    await chmod(path.join(tree.dir, 'run.sh'), 0o755);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]);
    await writeFile(path.join(tree.dir, 'logo.png'), png);
    await rm(path.join(tree.dir, 'gone.txt'));
    const local = await commit();
    expect(local).toMatch(/^[a-f0-9]{40}$/);
    expect(await refs()).toBe(before);
    const author = (await exec('git', ['-C', tree.dir, 'log', '-1', '--format=%an'], { check: true })).stdout.trim();
    expect(author).toBe('gab-ai-node (mac)');

    const changes = await collectChanges(tree.dir, tree.commit, local!);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(byPath['gone.txt']).toEqual({ path: 'gone.txt', deleted: true });
    expect(byPath['a.txt']).toEqual({ path: 'a.txt', mode: '100644', contentBase64: Buffer.from('v2').toString('base64') });
    expect(byPath['run.sh']).toMatchObject({ mode: '100755' });
    expect(Buffer.from((byPath['logo.png'] as { contentBase64: string }).contentBase64, 'base64')).toEqual(png);
    expect(changes).toHaveLength(4);
  });

  it('a second commit lists only what changed since the previous upload', async () => {
    await writeFile(path.join(tree.dir, 'a.txt'), 'v2');
    const first = await commit();
    await writeFile(path.join(tree.dir, 'b.txt'), 'new');
    const second = await commit({ message: 'more' });
    expect((await collectChanges(tree.dir, first!, second!)).map((c) => c.path)).toEqual(['b.txt']);
  });

  it('returns null when nothing changed', async () => expect(await commit()).toBeNull());

  it('refuses symlinks (the backend accepts regular files only)', async () => {
    await symlink('/etc/passwd', path.join(tree.dir, 'link'));
    const local = await commit();
    await expect(collectChanges(tree.dir, tree.commit, local!)).rejects.toThrow(/only regular files/);
  });

  it.each([
    ['main', { branch: 'main', taskBranch: 'main' }],
    ['another task branch', { branch: 'agent/mac/other' }],
    ['a task without a branch', { taskBranch: null }],
  ])('refuses %s', async (_n, over) => {
    await writeFile(path.join(tree.dir, 'a.txt'), 'v3');
    await expect(commit(over as never)).rejects.toThrow(/refusing|may not push/);
  });
});
