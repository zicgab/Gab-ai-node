import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskKind } from '@gab-ai-node/protocol';
import { exec } from '../src/exec.js';
import { allowedKinds, modelServerUp } from '../src/health.js';
import { KeepAwake, pruneMirrors, rotateLogs } from '../src/housekeeping.js';
import { ignoreNewUntracked, untrackedEntries } from '../src/repos.js';
import { changedOutsideScope } from '../src/agent/roles.js';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));

describe('allowedKinds', () => {
  const kinds: TaskKind[] = ['ask', 'bug_hunt', 'scan', 'docs_check'];
  const docker = new Set<TaskKind>(['bug_hunt', 'scan']);
  it('claims everything when healthy', () => {
    expect(allowedKinds(kinds, { docker: true, model: true, freeDiskMb: 50_000 }, docker, 10_240)).toEqual({ kinds, reason: null });
  });
  it('holds back the kinds that run commands while Docker is down', () => {
    const r = allowedKinds(kinds, { docker: false, model: true, freeDiskMb: null }, docker, 10_240);
    expect(r.kinds).toEqual(['ask', 'docs_check']);
    expect(r.reason).toMatch(/Docker/);
  });
  it('claims nothing without a model server or with a full disk', () => {
    expect(allowedKinds(kinds, { docker: true, model: false, freeDiskMb: 50_000 }, docker, 10_240)).toMatchObject({ kinds: [], reason: 'model server not reachable' });
    expect(allowedKinds(kinds, { docker: true, model: true, freeDiskMb: 500 }, docker, 10_240).kinds).toEqual([]);
  });
});

describe('modelServerUp', () => {
  const cfg = { modelEndpoint: 'http://127.0.0.1:1/v1', modelServer: { mode: 'external' as const, binary: 'llama-server', basePort: 8180, idleMinutes: 10 } };
  it('asks /models of an external server', async () => {
    const seen: string[] = [];
    const ok = (async (u: string) => { seen.push(u); return new Response('{}'); }) as unknown as typeof fetch;
    expect(await modelServerUp(cfg, ok)).toBe(true);
    expect(seen).toEqual(['http://127.0.0.1:1/v1/models']);
    expect(await modelServerUp(cfg, (() => Promise.reject(new Error('refused'))) as typeof fetch)).toBe(false);
  });
});

describe('rotateLogs', () => {
  it('rotates big logs in place and keeps a fixed number of copies', async () => {
    const dir = await tmp('gab-logs-');
    const file = path.join(dir, 'launchd.log');
    for (let i = 1; i <= 4; i++) {
      await writeFile(file, `round ${i} `.repeat(20));
      await rotateLogs(dir, 50, 2);
    }
    expect((await stat(file)).size).toBe(0);
    expect(await readFile(`${file}.1`, 'utf8')).toContain('round 4');
    expect(await readFile(`${file}.2`, 'utf8')).toContain('round 3');
    await expect(stat(`${file}.3`)).rejects.toThrow();
    await writeFile(path.join(dir, 'small.log'), 'x');
    expect(await rotateLogs(dir, 50, 2)).toEqual([]);
  });
});

describe('pruneMirrors', () => {
  it('removes mirrors not fetched for a long time, keeps the others', async () => {
    const root = await tmp('gab-mirrors-');
    for (const name of ['old.git', 'fresh.git']) {
      await mkdir(path.join(root, name));
      await exec('git', ['init', '--bare', '-q', path.join(root, name)], { check: true });
      await writeFile(path.join(root, name, 'FETCH_HEAD'), '');
    }
    const old = new Date(Date.now() - 40 * 86_400_000);
    await utimes(path.join(root, 'old.git', 'FETCH_HEAD'), old, old);
    expect(await pruneMirrors(root, 30)).toEqual(['old.git']);
    await expect(stat(path.join(root, 'fresh.git'))).resolves.toBeTruthy();
  });
});

describe('KeepAwake', () => {
  it('runs one caffeinate while any task runs, on macOS only', () => {
    const mac = new KeepAwake('darwin', 'sleep');
    mac.acquire(); mac.acquire();
    expect(mac.active).toBe(true);
    mac.release();
    expect(mac.active).toBe(true);
    mac.release();
    expect(mac.active).toBe(false);
    const linux = new KeepAwake('linux', 'sleep');
    linux.acquire();
    expect(linux.active).toBe(false);
    linux.release();
  });
});

describe('ignoreNewUntracked', () => {
  it('hides what setup made from git in this worktree only, so it is not committed or out of scope', async () => {
    const dir = await tmp('gab-setup-');
    await exec('git', ['init', '-q', dir], { check: true });
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'a.ts'), 'a');
    for (const args of [['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) await exec('git', ['-C', dir, ...args], { check: true });
    await writeFile(path.join(dir, 'mine.txt'), 'untracked before setup');
    const before = await untrackedEntries(dir);
    await mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(dir, 'node_modules', 'x', 'i.js'), '');
    await writeFile(path.join(dir, 'build[1].log'), '');
    expect((await ignoreNewUntracked(dir, before)).sort()).toEqual(['build[1].log', 'node_modules/']);
    await writeFile(path.join(dir, 'src', 'a.ts'), 'changed');
    expect([...(await untrackedEntries(dir))]).toEqual(['mine.txt']);
    expect(await changedOutsideScope(dir, ['src'])).toEqual(['mine.txt']);
    expect(await ignoreNewUntracked(dir, await untrackedEntries(dir))).toEqual([]);
  });
});

describe('NodeAgent claims only what it can run', () => {
  it('sends only the healthy kinds to the coordinator, and nothing while the model server is down', async () => {
    const { NodeAgent } = await import('../src/loop.js');
    const { NodeConfig } = await import('../src/config.js');
    const claims: string[][] = [];
    let model = true;
    const client = { claim: async (req: { acceptKinds: string[] }) => { claims.push(req.acceptKinds); return { available: true, task: null, leaseId: null, github: null }; } };
    const runner = { kinds: ['ask', 'bug_hunt'] as TaskKind[], run: async () => { throw new Error('no task expected'); } };
    const root = await tmp('gab-loop-');
    const agent = new NodeAgent({
      config: NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' }),
      client: client as never, runners: [runner], capabilities: async () => ({}) as never, secrets: { github: null, anthropic: null },
      reposRoot: path.join(root, 'repos'), workRoot: path.join(root, 'work'), isLocallyPaused: () => false, idleMs: 5,
      health: async () => ({ docker: false, model, freeDiskMb: null }), dockerKinds: new Set<TaskKind>(['bug_hunt']),
      keepAwake: new KeepAwake('linux'),
    });
    await agent.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(claims.length).toBeGreaterThan(0);
    expect(new Set(claims.flat())).toEqual(new Set(['ask']));
    model = false;
    const before = claims.length;
    await new Promise((r) => setTimeout(r, 80));
    await agent.stop();
    expect(claims.length - before).toBeLessThanOrEqual(1); // at most the claim already in flight
  });
});

describe('pinned images', () => {
  it('defaults are pinned by digest and old unpinned defaults in saved configs are upgraded; own choices are kept', async () => {
    const { IMAGES, NodeConfig, upgradeImages } = await import('../src/config.js');
    for (const image of Object.values(IMAGES)) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    const c = NodeConfig.parse(upgradeImages({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node', sandbox: { image: 'node:20-bookworm', webImage: 'my/web:1', scannerImages: { semgrep: 'semgrep/semgrep:latest' } } }));
    expect(c.sandbox.image).toBe(IMAGES.sandbox);
    expect(c.sandbox.webImage).toBe('my/web:1');
    expect(c.sandbox.scannerImages).toEqual({ semgrep: IMAGES.semgrep, gitleaks: IMAGES.gitleaks });
  });
});
