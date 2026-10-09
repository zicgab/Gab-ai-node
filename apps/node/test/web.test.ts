import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '@gab-ai-node/protocol';
import { createWebTools } from '../src/agent/web-tools.js';
import { WebRunner } from '../src/agent/web-runner.js';
import { WebSession } from '../src/agent/web-session.js';
import type { ChatMessage, ChatResponse, ModelBackend } from '../src/backends/types.js';
import { NodeConfig } from '../src/config.js';
import type { TaskContext } from '../src/runner.js';
import type { Sandbox } from '../src/sandbox.js';

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-driver.mjs');
const stub = (env: NodeJS.ProcessEnv = {}) => spawn(process.execPath, [STUB], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });

describe('WebSession', () => {
  it('sends actions and returns results; the driver error comes back as an Error', async () => {
    const s = new WebSession(stub());
    expect(await s.call('goto', { url: 'http://localhost:3000/' })).toMatchObject({ title: 'Demo', status: 200 });
    await expect(s.call('click', { selector: '#x' })).rejects.toThrow('stub cannot click');
    s.close();
  });

  it('a driver that cannot start fails the first call with its reason', async () => {
    const s = new WebSession(stub({ STUB_FATAL: '1' }));
    await expect(s.call('goto', { url: 'http://localhost/' })).rejects.toThrow(/browser did not start: stub/);
  });

  it('a driver that dies fails the pending call; a silent one times out', async () => {
    const dying = new WebSession(stub());
    await expect(dying.call('die')).rejects.toThrow(/driver exited \(code 3\)/);
    const silent = new WebSession(stub());
    await expect(silent.call('hang', {}, 200)).rejects.toThrow(/hang timed out/);
    silent.close();
  });
});

describe('web tools', () => {
  it('map every tool to a driver action with its arguments', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const tools = createWebTools({ call: async (a, args = {}) => { calls.push([a, args]); return a === 'elements' ? [{ tag: 'a' }] : 'ok'; } });
    expect(tools.map((t) => t.name)).toEqual(['goto', 'elements', 'text', 'click', 'fill', 'press', 'wait', 'problems']);
    expect(await tools.find((t) => t.name === 'goto')!.run({ url: 'http://localhost:3000' })).toBe('ok');
    expect(await tools.find((t) => t.name === 'elements')!.run({})).toContain('"tag": "a"');
    await tools.find((t) => t.name === 'fill')!.run({ selector: '#a', value: 'x' });
    expect(calls).toEqual([['goto', { url: 'http://localhost:3000' }], ['elements', {}], ['fill', { selector: '#a', value: 'x' }]]);
  });
});

describe('WebRunner', () => {
  let workdir: string;
  const fakeSandbox = (log: string[], opts: { appUp?: boolean } = {}): Sandbox => ({
    async run(command) {
      log.push(command);
      if (command.includes('process.exit(1)') && opts.appUp === false) return { code: 1, stdout: '', stderr: '' };
      if (command.startsWith('tail ')) return { code: 0, stdout: 'Error: Cannot find module next', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    interactive: () => stub(),
    async close() { log.push('closed'); },
  });
  const scripted = (responses: Partial<ChatMessage>[]): ModelBackend & { seen: ChatMessage[][] } => {
    const seen: ChatMessage[][] = []; let i = 0;
    return { model: 'fake', seen, async chat(messages): Promise<ChatResponse> {
      seen.push([...messages]);
      return { message: { role: 'assistant', content: null, ...responses[Math.min(i++, responses.length - 1)]! }, tokens: 5, finishReason: 'stop' };
    } };
  };
  const call = (name: string, args: unknown) => ({ tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });
  const context = async (agentMd: string | null, over: Partial<TaskSpec> = {}): Promise<TaskContext> => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'gab-web-'));
    if (agentMd !== null) await writeFile(path.join(workdir, 'AGENT.md'), agentMd);
    const task: TaskSpec = {
      id: randomUUID(), kind: 'test_web', repo: 'zicgab/demo', extraRepos: [], ref: null, instructions: 'Try the login form', backend: 'local', model: 'fake',
      budget: { maxSteps: 20, maxMinutes: 10, maxTokens: 1e6 }, branch: null, findingId: null, attempt: 1, role: null, paths: [], chat: null, ...over,
    };
    return {
      task, config: NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' }), workdir, extraDirs: {}, signal: new AbortController().signal,
      emit: () => {}, secrets: { github: null, anthropic: null }, modelEndpoint: async () => 'http://unused', commitAndPush: async () => { throw new Error('test_web never pushes'); },
    };
  };
  const AGENT_MD = 'setup: npm ci\nstart: npm run dev -- --port 3000\nurl: http://localhost:3000\n';

  it('needs start and url in AGENT.md', async () => {
    const runner = new WebRunner(async () => fakeSandbox([]), () => scripted([]), STUB);
    await expect(runner.run(await context('setup: npm ci\n'))).rejects.toThrow(/needs "start:".*"url:"/);
    await expect(runner.run(await context(null))).rejects.toThrow(/AGENT\.md/);
  });

  describe('test_electron', () => {
    const ELECTRON_MD = 'setup: npm ci && npm run build\nelectron: dist/main.js\n';
    const electronCtx = async (md: string | null) => context(md, { kind: 'test_electron' });

    it('needs "electron:" in AGENT.md and a path inside the repo', async () => {
      const runner = new WebRunner(async () => fakeSandbox([]), () => scripted([]), STUB);
      await expect(runner.run(await electronCtx('start: x\nurl: http://localhost:3000\n'))).rejects.toThrow(/needs "electron:"/);
      await expect(runner.run(await electronCtx('electron: ../outside.js\n'))).rejects.toThrow(/must be a path inside the repo/);
      await expect(runner.run(await electronCtx('electron: a b.js\n'))).rejects.toThrow(/must be a path inside the repo/);
    });

    it('builds with setup, starts the driver under xvfb with the entry, starts no web server, and reports findings', async () => {
      const log: string[] = [];
      const argvs: string[][] = [];
      const sandbox = { ...fakeSandbox(log), interactive: (argv: string[]) => { argvs.push(argv); return stub(); } };
      const report = { summary: 'opened the app', passed: false, problems: [{ title: 'Settings window crashes', severity: 'high', file: 'src/settings.ts', line: 5, evidence: 'click Settings -> uncaught error: x is undefined' }] };
      const backend = scripted([call('windows', {}), call('problems', {}), { content: JSON.stringify(report) }]);
      const res = await new WebRunner(async () => sandbox, () => backend, STUB).run(await electronCtx(ELECTRON_MD));
      expect(log[0]).toBe('npm ci && npm run build');
      expect(log.some((c) => c.includes('setsid'))).toBe(false); // no web server to start
      expect(argvs[0]).toEqual(['env', 'GAB_APP=electron', 'GAB_ELECTRON_ENTRY=dist/main.js', 'xvfb-run', '-a', 'node', '/work/.gab-ai-web/driver.mjs']);
      expect(backend.seen[0]![0]!.content).toContain('desktop app (Electron)');
      expect(res).toMatchObject({ summary: '1 problem(s)', branch: null });
      expect(res.findings[0]).toMatchObject({ severity: 'high', file: 'src/settings.ts' });
    });

    it('the electron tools have windows, not goto', () => {
      const names = (kind: 'test_web' | 'test_electron') => createWebTools({ call: async () => 'ok' }, kind).map((t) => t.name);
      expect(names('test_electron')).toEqual(['windows', 'window', 'elements', 'text', 'click', 'fill', 'press', 'wait', 'problems']);
      expect(names('test_web')).toContain('goto');
      expect(names('test_web')).not.toContain('windows');
    });
  });

  it('only a localhost url is accepted', async () => {
    const runner = new WebRunner(async () => fakeSandbox([]), () => scripted([]), STUB);
    await expect(runner.run(await context('start: x\nurl: https://example.com/\n'))).rejects.toThrow(/must be http:\/\/localhost/);
  });

  it('installs, starts the app, drives the browser, and turns reported problems into findings (never pushes)', async () => {
    const log: string[] = [];
    const report = { summary: 'tried login', passed: false, problems: [
      { title: 'Login button throws', severity: 'HIGH', file: 'app.js', line: 3, evidence: 'goto /, console.error: boom at app.js:3', suggestedFix: null },
      { title: 'no evidence', severity: 'low', file: null, line: null, evidence: '' },
    ] };
    const backend = scripted([call('goto', { url: 'http://localhost:3000/' }), call('problems', {}), { content: JSON.stringify(report) }]);
    const res = await new WebRunner(async () => fakeSandbox(log), () => backend, STUB).run(await context(AGENT_MD));
    expect(log[0]).toBe('npm ci');
    expect(log[1]).toContain('playwright@1.48.2');
    expect(log[2]).toContain('npm run dev -- --port 3000');
    expect(log.at(-1)).toBe('closed');
    expect(res).toMatchObject({ summary: '1 problem(s)', branch: null, commits: [] });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ title: 'Login button throws', severity: 'high', file: 'app.js', line: 3 });
    expect(backend.seen[0]![0]!.content).toContain('You test a web app');
    expect(await readFile(path.join(workdir, '.gab-ai-web', 'driver.mjs'), 'utf8')).toContain('Stands in for');
  });

  it('a clean run reports "passed"', async () => {
    const backend = scripted([call('goto', { url: 'http://localhost:3000/' }), { content: '{"summary":"all good","passed":true,"problems":[]}' }]);
    const res = await new WebRunner(async () => fakeSandbox([]), () => backend, STUB).run(await context(AGENT_MD));
    expect(res.summary).toBe('passed');
    expect(res.findings).toEqual([]);
  });

  it('an app that never answers fails the task with its own log', async () => {
    const runner = new WebRunner(async () => fakeSandbox([], { appUp: false }), () => scripted([]), STUB, 1);
    await expect(runner.run(await context(AGENT_MD))).rejects.toThrow(/did not answer at http:\/\/localhost:3000.*Cannot find module next/s);
  });

  it('setup failing is not retried', async () => {
    const sandbox: Sandbox = { async run() { return { code: 2, stdout: '', stderr: 'npm ERR! missing script' }; }, interactive: () => stub(), async close() {} };
    await mkdir(os.tmpdir(), { recursive: true });
    await expect(new WebRunner(async () => sandbox, () => scripted([]), STUB).run(await context(AGENT_MD))).rejects.toThrow(/setup "npm ci" failed \(exit 2\)/);
  });
});
