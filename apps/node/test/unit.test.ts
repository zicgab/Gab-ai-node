import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelsThatFit } from '../src/fit.js';
import { FileStore } from '../src/secrets/file.js';
import { addWorktree, gitEnv, mirrorPath, syncMirror } from '../src/repos.js';
import { exec } from '../src/exec.js';

describe('modelsThatFit', () => {
  const models = [
    { id: 'small', memoryMb: 20_000, backend: 'local' as const },
    { id: 'big', memoryMb: 70_000, backend: 'local' as const },
    { id: 'claude', memoryMb: 1, backend: 'anthropic-api' as const },
  ];
  it('all fit when idle', () => expect(modelsThatFit(models, [], 96_000)).toEqual(['small', 'big', 'claude']));
  it('a running model is shared', () => expect(modelsThatFit(models, ['big'], 96_000)).toEqual(['small', 'big', 'claude']));
  it('two big ones never run together', () => expect(modelsThatFit(models, ['big', 'small'], 96_000)).toEqual(['small', 'big', 'claude']));
  it('refuses what does not fit', () => expect(modelsThatFit(models, ['small'], 80_000)).toEqual(['small', 'claude']));
});

describe('FileStore', () => {
  it('stores secrets in a 0600 file and refuses odd values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gab-secrets-'));
    const store = new FileStore(path.join(dir, 's.json'));
    await store.set('GITHUB_TOKEN', 'ghp_abcdefgh12345');
    expect(await store.get('GITHUB_TOKEN')).toBe('ghp_abcdefgh12345');
    if (process.platform !== 'win32') expect((await stat(path.join(dir, 's.json'))).mode & 0o777).toBe(0o600);
    await expect(store.set('GITHUB_TOKEN', 'bad value\nx')).rejects.toThrow(/characters/);
    await store.delete('GITHUB_TOKEN');
    expect(await store.get('GITHUB_TOKEN')).toBeNull();
  });
});

describe('repos', () => {
  it('passes the token as a header env, never in a URL', () => {
    const env = gitEnv('ghp_secret123');
    expect(env.GIT_CONFIG_VALUE_0).toMatch(/^AUTHORIZATION: basic /);
    expect(JSON.stringify(env)).not.toContain('ghp_secret123');
  });

  it('refuses bad repo names and refs', async () => {
    expect(() => mirrorPath('../etc')).toThrow();
    await expect(addWorktree('/nonexistent', 't', 'repo', '--upload-pack=x')).rejects.toThrow(/invalid ref/);
  });

  it('mirrors, checks out a worktree and removes it', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'gab-repos-'));
    const origin = path.join(tmp, 'origin');
    await exec('git', ['init', '-q', '-b', 'main', origin], { check: true });
    await writeFile(path.join(origin, 'a.txt'), 'hello');
    await exec('git', ['-C', origin, 'add', '.'], { check: true });
    await exec('git', ['-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { check: true });

    const mirror = await syncMirror('zicgab/demo', null, { root: path.join(tmp, 'repos'), remoteUrl: origin });
    const tree = await addWorktree(mirror, 'task1', 'repo', 'main', path.join(tmp, 'work'));
    expect(await readFile(path.join(tree.dir, 'a.txt'), 'utf8')).toBe('hello');
    await tree.remove();
    expect(existsSync(tree.dir)).toBe(false);
    // Second sync fetches instead of cloning.
    await syncMirror('zicgab/demo', null, { root: path.join(tmp, 'repos'), remoteUrl: origin });
  });
});
