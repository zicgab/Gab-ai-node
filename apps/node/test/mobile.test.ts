import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '@gab-ai-node/protocol';
import { buildFlow } from '../src/agent/maestro-flow.js';
import { MobileRunner, type HostExec } from '../src/agent/mobile-runner.js';
import type { ChatMessage, ChatResponse, ModelBackend } from '../src/backends/types.js';
import { NodeConfig } from '../src/config.js';
import type { TaskContext } from '../src/runner.js';

describe('buildFlow', () => {
  it('writes YAML for the allowed steps, strings quoted', () => {
    const yaml = buildFlow('com.example.app', [
      { action: 'launchApp', clearState: true }, { action: 'tapOn', text: 'Log in' }, { action: 'tapOn', id: 'submit' },
      { action: 'inputText', text: 'a "quoted": value\nnext' }, { action: 'assertVisible', text: 'Welcome' }, { action: 'swipe', direction: 'UP' },
      { action: 'pressKey', key: 'Enter' }, { action: 'scroll' }, { action: 'back' }, { action: 'waitForAnimationToEnd' }, { action: 'takeScreenshot', name: 'home-1' },
    ]);
    expect(yaml).toBe([
      'appId: "com.example.app"', '---', '- launchApp:\n    clearState: true', '- tapOn: "Log in"', '- tapOn:\n    id: "submit"',
      '- inputText: "a \\"quoted\\": value\\nnext"', '- assertVisible: "Welcome"', '- swipe:\n    direction: UP', '- pressKey: Enter', '- scroll', '- back',
      '- waitForAnimationToEnd', '- takeScreenshot: "home-1"', '',
    ].join('\n'));
  });

  it.each([
    [[{ action: 'runScript', file: 'x.js' }], /step 1: unknown action "runScript"/],
    [[{ action: 'evalScript', script: 'x' }], /unknown action "evalScript"/],
    [[{ action: 'openLink', link: 'https://evil' }], /unknown action "openLink"/],
    [[{ action: 'runFlow', file: '../x.yaml' }], /unknown action "runFlow"/],
    [[{ action: 'tapOn', text: 'a', id: 'b' }], /exactly one of text or id/],
    [[{ action: 'tapOn' }], /exactly one of text or id/],
    [[{ action: 'tapOn', text: 'ok', point: '50%,50%' }], /step 1 \(tapOn\)/], // an extra key is refused
    [[{ action: 'pressKey', key: 'Power' }], /step 1 \(pressKey\)/],
    [[{ action: 'takeScreenshot', name: '../../etc' }], /step 1 \(takeScreenshot\)/],
    [[{ action: 'inputText', text: '' }], /step 1 \(inputText\)/],
    [[], /1-60 steps/],
    ['launchApp', /1-60 steps/],
    [Array.from({ length: 61 }, () => ({ action: 'back' })), /1-60 steps/],
    [[{ action: 'back' }, { action: '__proto__' }], /step 2: unknown action/],
  ])('refuses %j', (steps, message) => {
    expect(() => buildFlow('com.example.app', steps)).toThrow(message);
  });

  it('the app id is checked', () => {
    expect(() => buildFlow('com.example.app"\n- runScript: x', [{ action: 'back' }])).toThrow();
  });
});

describe('MobileRunner', () => {
  let workdir: string;
  const scripted = (responses: Partial<ChatMessage>[]): ModelBackend & { seen: ChatMessage[][] } => {
    const seen: ChatMessage[][] = []; let i = 0;
    return { model: 'fake', seen, async chat(messages): Promise<ChatResponse> {
      seen.push([...messages]);
      return { message: { role: 'assistant', content: null, ...responses[Math.min(i++, responses.length - 1)]! }, tokens: 5, finishReason: 'stop' };
    } };
  };
  const call = (name: string, args: unknown) => ({ tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });
  const MOBILE = { enabled: true, platform: 'ios', apps: { 'zicgab/app': { build: 'npx expo run:ios', app: 'ios/App.app', appId: 'com.example.app' } } };
  const context = async (mobile: unknown = MOBILE, over: Partial<TaskSpec> = {}): Promise<TaskContext> => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'gab-mobile-'));
    await mkdir(path.join(workdir, 'ios', 'App.app'), { recursive: true });
    const task: TaskSpec = {
      id: randomUUID(), kind: 'test_mobile', repo: 'zicgab/app', extraRepos: [], ref: null, instructions: 'Try signing in', backend: 'local', model: 'fake',
      budget: { maxSteps: 20, maxMinutes: 10, maxTokens: 1e6 }, branch: null, findingId: null, attempt: 1, role: null, paths: [], chat: null, ...over,
    };
    return {
      task, config: NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node', mobile }), workdir, extraDirs: {}, signal: new AbortController().signal,
      emit: () => {}, secrets: { github: null, anthropic: null }, modelEndpoint: async () => 'http://unused', commitAndPush: async () => { throw new Error('test_mobile never pushes'); },
    };
  };
  const hostLog = (results: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) => {
    const calls: { file: string; args: string[]; cwd?: string }[] = [];
    const host: HostExec = async (file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd });
      const key = `${file} ${args[0] ?? ''}`;
      const r = results[key] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    return { host, calls };
  };

  it('is off by default and only for the repos in the node config', async () => {
    const { host } = hostLog();
    await expect(new MobileRunner(() => scripted([]), host).run(await context({}))).rejects.toThrow(/test_mobile is off/);
    await expect(new MobileRunner(() => scripted([]), host).run(await context({ ...MOBILE, apps: {} }))).rejects.toThrow(/not set up for test_mobile/);
  });

  it('builds, installs on the booted simulator, lets the model write and run flows, reports findings, never pushes', async () => {
    const { host, calls } = hostLog({ 'maestro test': { code: 1, stdout: 'Assert that "Welcome" is visible... FAILED' }, 'maestro hierarchy': { code: 0, stdout: '{"text":"Sign in"}' } });
    const report = { summary: 'sign in does not reach home', passed: false, problems: [{ title: 'Sign in never shows Welcome', severity: 'high', file: 'src/Login.tsx', line: 20, evidence: 'flow login: tapOn Log in, assertVisible Welcome FAILED; screen still shows Sign in' }] };
    const backend = scripted([
      call('flow_write', { name: 'login', steps: [{ action: 'launchApp' }, { action: 'tapOn', text: 'Log in' }, { action: 'assertVisible', text: 'Welcome' }] }),
      call('flow_run', { name: 'login' }), call('screen', {}), { content: JSON.stringify(report) },
    ]);
    const res = await new MobileRunner(() => backend, host).run(await context());
    expect(calls.map((c) => `${c.file} ${c.args.slice(0, 2).join(' ')}`)).toEqual([
      'sh -c npx expo run:ios', `xcrun simctl install`, 'maestro test login.yaml', 'maestro hierarchy',
    ]);
    expect(calls[0]!.cwd).toBe(workdir);
    expect(calls[1]!.args).toEqual(['simctl', 'install', 'booted', path.join(workdir, 'ios', 'App.app')]);
    expect(res).toMatchObject({ summary: '1 problem(s)', branch: null, commits: [] });
    expect(res.findings[0]).toMatchObject({ severity: 'high', file: 'src/Login.tsx' });
    expect(backend.seen[0]![1]!.content).toContain('com.example.app');
    // the flows live outside the repo and are removed afterwards
    expect(calls[2]!.cwd).not.toContain(workdir);
    expect(await readdir(workdir)).toEqual(['ios']);
  });

  it('a flow with a smuggled command is refused and nothing is written or run', async () => {
    const { host, calls } = hostLog();
    const backend = scripted([call('flow_write', { name: 'bad', steps: [{ action: 'runScript', file: 'x.js' }] }), call('flow_run', { name: 'bad' }), { content: '{"summary":"s","passed":true,"problems":[]}' }]);
    await new MobileRunner(() => backend, host).run(await context({ ...MOBILE, apps: { 'zicgab/app': { ...MOBILE.apps['zicgab/app'], build: null } } }));
    expect(calls.map((c) => c.file)).toEqual(['xcrun', 'maestro']); // install, then flow_run of a flow that was never written
    expect(calls[1]!.args).toEqual(['test', 'bad.yaml']);
    const toolOutputs = backend.seen.flat().filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolOutputs[0]).toContain('unknown action "runScript"');
  });

  it('a failing build is an error; no device is retryable; android uses adb', async () => {
    await expect(new MobileRunner(() => scripted([]), hostLog({ 'sh -c': { code: 2, stderr: 'xcodebuild: error' } }).host).run(await context())).rejects.toThrow(/mobile build failed \(exit 2\).*xcodebuild/s);
    await expect(new MobileRunner(() => scripted([]), hostLog({ 'xcrun simctl': { code: 1, stderr: 'No devices are booted' } }).host).run(await context())).rejects.toThrow(/could not install.*booted/s);
    const { host, calls } = hostLog();
    const backend = scripted([{ content: '{"summary":"s","passed":true,"problems":[]}' }]);
    const res = await new MobileRunner(() => backend, host).run(await context({ ...MOBILE, platform: 'android', apps: { 'zicgab/app': { ...MOBILE.apps['zicgab/app'], build: null } } }));
    expect(calls[0]).toMatchObject({ file: 'adb', args: ['install', '-r', path.join(workdir, 'ios', 'App.app')] });
    expect(res.summary).toBe('passed');
  });

  it('an app path that leaves the repo is refused before anything is installed', async () => {
    const { host, calls } = hostLog();
    const ctx = await context({ ...MOBILE, apps: { 'zicgab/app': { build: null, app: '../outside.app', appId: 'com.example.app' } } });
    await expect(new MobileRunner(() => scripted([]), host).run(ctx)).rejects.toThrow(/must be inside the repo/);
    expect(calls).toEqual([]);
    expect(await readFile(path.join(workdir, '..', 'nope'), 'utf8').catch(() => 'x')).toBe('x');
  });

  it('config: mobile is off by default and the app id is checked', () => {
    expect(NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' }).mobile).toEqual({ enabled: false, platform: 'ios', apps: {} });
    expect(NodeConfig.safeParse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node', mobile: { apps: { 'zicgab/app': { app: 'a.app', appId: 'x y' } } } }).success).toBe(false);
  });
});
