import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskSpec } from '@gab-ai-node/protocol';
import { extractJson, fingerprint, WorkRunner } from '../src/agent/work-runner.js';
import { parseRepoConfig } from '../src/agent/repo-config.js';
import { createWorkTools, resolveForWrite } from '../src/agent/tools.js';
import type { ChatMessage, ChatResponse, ModelBackend } from '../src/backends/types.js';
import { NodeConfig } from '../src/config.js';
import { exec, has } from '../src/exec.js';
import { RetryableError, type TaskContext } from '../src/runner.js';
import { DockerSandbox, type Sandbox } from '../src/sandbox.js';

function scripted(responses: Partial<ChatMessage>[]): ModelBackend & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return {
    model: 'fake', seen,
    async chat(messages): Promise<ChatResponse> {
      seen.push([...messages]);
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return { message: { role: 'assistant', content: null, ...r }, tokens: 10, finishReason: 'stop' };
    },
  };
}
const call = (name: string, args: unknown) => ({ tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });

/** Test-only sandbox: runs in the worktree on the host and records what ran. */
class HostSandbox implements Sandbox {
  runs: { command: string; network: boolean }[] = [];
  closed = false;
  constructor(private readonly dir: string) {}
  async run(command: string, o: { timeoutMs: number; network?: boolean }) {
    this.runs.push({ command, network: !!o.network });
    return exec('sh', ['-c', command], { cwd: this.dir, timeoutMs: o.timeoutMs });
  }
  async close() { this.closed = true; }
}

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'gab-work-'));
  await writeFile(path.join(repo, 'AGENT.md'), '# Agent\nsetup: echo installed > .setup-done\ntest: sh test.sh\n');
  await writeFile(path.join(repo, 'sum.js'), 'module.exports = (a, b) => a - b;\n');
  await writeFile(path.join(repo, 'test.sh'), 'node -e "process.exit(require(\'./sum.js\')(2, 2) === 4 ? 0 : 1)" && echo PASS || { echo FAIL; exit 1; }\n');
  await writeFile(path.join(repo, '.gitignore'), '.setup-done\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) await exec('git', ['-C', repo, ...args], { check: true });
});

function context(kind: TaskSpec['kind'], branch: string | null, pushed: string[], over: Partial<TaskSpec> = {}): TaskContext {
  const task: TaskSpec = {
    id: randomUUID(), kind, repo: 'zicgab/demo', extraRepos: [], ref: null, instructions: kind === 'fix_finding' ? 'Fix: sum subtracts' : '',
    backend: 'local', model: 'fake', budget: { maxSteps: 20, maxMinutes: 10, maxTokens: 1e6 }, branch, findingId: null, attempt: 1, role: null, paths: [], chat: null, ...over,
  };
  return {
    task, config: NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' }), workdir: repo, extraDirs: {},
    signal: new AbortController().signal, emit: () => {}, secrets: { github: null, anthropic: null },
    modelEndpoint: async () => 'http://unused', commitAndPush: async (m) => { pushed.push(m); return 'abc1234'; },
  };
}

const fixSteps = [
  call('run_cmd', { command: 'sh test.sh' }),
  call('replace_in_file', { path: 'sum.js', old_text: 'a - b', new_text: 'a + b' }),
  call('run_cmd', { command: 'sh test.sh' }),
];

describe('WorkRunner bug_hunt', () => {
  it('runs setup with network, commands without, reports findings with fingerprints, pushes the fix', async () => {
    const sb = new HostSandbox(repo);
    const pushed: string[] = [];
    const report = { summary: 'one bug', findings: [
      { title: 'sum() subtracts instead of adding', severity: 'HIGH', file: 'sum.js', line: 1, evidence: 'sh test.sh -> FAIL (exit 1)', suggestedFix: 'use a + b' },
      { title: 'no evidence', severity: 'low', file: null, line: null, evidence: '' },
    ] };
    const backend = scripted([...fixSteps, { content: '```json\n' + JSON.stringify(report) + '\n```' }]);
    const res = await new WorkRunner(async () => sb, () => backend, path.join(repo, '..', 'idx-' + randomUUID()), 0).run(context('bug_hunt', 'agent/test-node/t1-bugs', pushed));

    expect(sb.runs[0]).toEqual({ command: 'echo installed > .setup-done', network: true });
    expect(sb.runs.slice(1).every((r) => !r.network)).toBe(true);
    expect(await readFile(path.join(repo, 'sum.js'), 'utf8')).toContain('a + b');
    expect(res.findings).toHaveLength(1); // the one without evidence is dropped
    expect(res.findings[0]).toMatchObject({ severity: 'high', file: 'sum.js', fingerprint: fingerprint('zicgab/demo', 'sum.js', 'sum() subtracts instead of adding') });
    expect(pushed[0]).toContain('sum() subtracts');
    expect(res).toMatchObject({ branch: 'agent/test-node/t1-bugs', commits: ['abc1234'] });
    expect(sb.closed).toBe(true);
  });

  it('repairs a report that is not JSON with one extra model call', async () => {
    const sb = new HostSandbox(repo);
    const backend = scripted([{ content: 'I found nothing worth reporting.' }, { content: '{"summary":"nothing","findings":[]}' }]);
    const res = await new WorkRunner(async () => sb, () => backend, path.join(repo, '..', 'idx-' + randomUUID()), 0).run(context('bug_hunt', null, []));
    expect(backend.seen).toHaveLength(2);
    expect(res).toMatchObject({ answer: 'nothing', findings: [], branch: null });
  });

  it('says how many files were read and which, so "0 findings" can be judged', async () => {
    const backend = scripted([call('read_file', { path: 'sum.js' }), { content: '{"summary":"nothing wrong","reviewed":["sum.js"],"findings":[]}' }]);
    const res = await new WorkRunner(async () => new HostSandbox(repo), () => backend, path.join(repo, '..', 'idx-' + randomUUID()), 0).run(context('bug_hunt', null, []));
    expect(res.summary).toBe('0 finding(s), 1 file(s) read');
    expect(res.answer).toBe('nothing wrong\n\nReviewed (1): sum.js');
  });

  it('sends an answer back when too few files were read, then lets the model finish', async () => {
    const answer = '{"summary":"all read","reviewed":["sum.js"],"findings":[]}';
    const backend = scripted([{ content: '{"summary":"quick look","findings":[]}' }, call('read_file', { path: 'sum.js' }), { content: answer }]);
    const res = await new WorkRunner(async () => new HostSandbox(repo), () => backend, path.join(repo, '..', 'idx-' + randomUUID()), 1).run(context('bug_hunt', null, []));
    expect(backend.seen).toHaveLength(3);
    expect(backend.seen[1]!.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('too few to conclude') });
    expect(res.summary).toBe('0 finding(s), 1 file(s) read');
  });
});

describe('WorkRunner fix_finding', () => {
  it('pushes the fix and reports the test verdict', async () => {
    const pushed: string[] = [];
    const backend = scripted([...fixSteps, { content: '{"summary":"sum adds now","testsPassed":true,"testOutput":"PASS"}' }]);
    const res = await new WorkRunner(async () => new HostSandbox(repo), () => backend, path.join(repo, '..', 'idx-' + randomUUID())).run(context('fix_finding', 'agent/test-node/t2-fix', pushed));
    expect(res.summary).toBe('fix on agent/test-node/t2-fix, tests passed');
    expect(pushed).toEqual(['fix_finding: sum adds now']);
  });

  it('reports no change when the model changed nothing', async () => {
    const pushed: string[] = [];
    const backend = scripted([{ content: '{"summary":"could not reproduce","testsPassed":false,"testOutput":""}' }]);
    const res = await new WorkRunner(async () => new HostSandbox(repo), () => backend, path.join(repo, '..', 'idx-' + randomUUID())).run(context('fix_finding', 'agent/test-node/t3', pushed));
    expect(res.summary).toBe('no change made');
    expect(pushed).toEqual([]);
  });

  it('a sandbox that cannot start is retryable', async () => {
    const runner = new WorkRunner(async () => { throw new Error('Cannot connect to the Docker daemon'); }, () => scripted([]));
    await expect(runner.run(context('fix_finding', null, []))).rejects.toBeInstanceOf(RetryableError);
  });
});

describe('WorkRunner custom', () => {
  const runner = (backend: ModelBackend) => new WorkRunner(async () => new HostSandbox(repo), () => backend, path.join(repo, '..', 'idx-' + randomUUID()));

  it('does the asked change with the custom prompt, pushes it with a custom: commit', async () => {
    const pushed: string[] = [];
    const backend = scripted([...fixSteps, { content: '{"summary":"sum adds now","testsPassed":true,"testOutput":"PASS"}' }]);
    const res = await runner(backend).run(context('custom', 'agent/test-node/t4-custom', pushed, { instructions: 'Make sum add' }));
    expect(res.summary).toBe('change on agent/test-node/t4-custom, tests passed');
    expect(pushed).toEqual(['custom: sum adds now']);
    expect(backend.seen[0]![0]!.content).toContain('one change that the user asked for');
    expect(backend.seen[0]![1]!.content).toContain('Make sum add');
  });

  it('a scoped task that changes files outside its folders through run_cmd is not committed', async () => {
    await mkdir(path.join(repo, 'docs'));
    const pushed: string[] = [];
    const backend = scripted([call('run_cmd', { command: 'echo // extra >> sum.js' }), { content: '{"summary":"done","testsPassed":true,"testOutput":""}' }]);
    await expect(runner(backend).run(context('custom', 'agent/test-node/t5', pushed, { instructions: 'edit docs', paths: ['docs'] })))
      .rejects.toThrow(/outside its folders \(docs\): sum\.js/);
    expect(pushed).toEqual([]);
  });

  it('a scoped task that stays in its folders is committed', async () => {
    await mkdir(path.join(repo, 'docs'));
    const pushed: string[] = [];
    const backend = scripted([call('write_file', { path: 'docs/readme.md', content: 'hello' }), { content: '{"summary":"added docs","testsPassed":true,"testOutput":""}' }]);
    const res = await runner(backend).run(context('custom', 'agent/test-node/t6', pushed, { instructions: 'add docs', paths: ['docs'] }));
    expect(res.summary).toBe('change on agent/test-node/t6, tests passed');
    expect(pushed).toEqual(['custom: added docs']);
  });

  it('a missing folder fails the task before any work', async () => {
    const backend = scripted([]);
    await expect(runner(backend).run(context('custom', 'agent/test-node/t7', [], { instructions: 'x', paths: ['nope'] }))).rejects.toThrow(/folder "nope" does not exist/);
    expect(backend.seen).toEqual([]);
  });
});

describe('write tools', () => {
  it('refuses .git, extra repos, absolute paths, escapes and symlinks out', async () => {
    const roots = { main: repo, extra: { 'zicgab/x': repo } };
    await expect(resolveForWrite(roots, '.git/config')).rejects.toThrow(/\.git/);
    await expect(resolveForWrite(roots, '@zicgab/x/a.ts')).rejects.toThrow(/read-only/);
    await expect(resolveForWrite(roots, '/etc/passwd')).rejects.toThrow(/relative/);
    await expect(resolveForWrite(roots, '../outside.ts')).rejects.toThrow(/outside/);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'gab-out-'));
    await symlink(outside, path.join(repo, 'link'));
    await expect(resolveForWrite(roots, 'link/new.ts')).rejects.toThrow(/outside/);
    await expect(resolveForWrite(roots, 'new/dir/file.ts')).resolves.toMatchObject({ rel: path.join('new', 'dir', 'file.ts') });
  });

  it('replace_in_file needs exactly one match', async () => {
    await mkdir(path.join(repo, 'd'));
    await writeFile(path.join(repo, 'd', 'a.txt'), 'x x');
    const t = Object.fromEntries(createWorkTools({ main: repo, extra: {} }, new HostSandbox(repo), { cmdTimeoutMs: 10_000 }).map((x) => [x.name, x]));
    await expect(t.replace_in_file!.run({ path: 'd/a.txt', old_text: 'x', new_text: 'y' })).rejects.toThrow(/2 times/);
    await expect(t.run_cmd!.run({ command: 'echo hi; exit 3' })).resolves.toMatch(/^exit 3[\s\S]*hi/);
  });
});

describe('helpers', () => {
  it('parses AGENT.md settings', () => {
    expect(parseRepoConfig('# x\n- `image`: `python:3.12`\nsetup: pip install -r requirements.txt\ntest: pytest\ntest: other')).toEqual({ image: 'python:3.12', setup: 'pip install -r requirements.txt', test: 'pytest', start: null, url: null, electron: null });
    expect(parseRepoConfig('start: npm run dev -- --port 3000\nurl: http://localhost:3000')).toMatchObject({ start: 'npm run dev -- --port 3000', url: 'http://localhost:3000' });
    expect(parseRepoConfig(null)).toEqual({ image: null, setup: null, test: null, start: null, url: null, electron: null });
  });
  it('fingerprints ignore numbers and punctuation', () => {
    expect(fingerprint('a/b', 'f.ts', 'Crash on line 12!')).toBe(fingerprint('a/b', 'f.ts', 'crash on line 40'));
    expect(fingerprint('a/b', 'f.ts', 'x')).not.toBe(fingerprint('a/b', 'g.ts', 'x'));
  });
  it('extracts JSON from fenced or bare answers', () => {
    expect(extractJson('text {"a":1} more')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
});

// Real Docker, only when the daemon and a local image are there (no pulls in tests).
const IMAGE = 'postgres:16';
const dockerReady = (await has('docker')) && (await exec('docker', ['image', 'inspect', IMAGE]).catch(() => ({ code: 1 }))).code === 0;
describe.skipIf(!dockerReady)('DockerSandbox', () => {
  it('mounts only the worktree, has no network by default, enforces timeouts', async () => {
    const sb = await DockerSandbox.start({ image: IMAGE, workdir: repo, name: `gab-test-${randomUUID().slice(0, 8)}`, memoryMb: 512, cpus: 1 });
    try {
      expect((await sb.run('cat sum.js', { timeoutMs: 20_000 })).stdout).toContain('a - b');
      expect((await sb.run('ls /run/secrets 2>/dev/null; env', { timeoutMs: 20_000 })).stdout).not.toMatch(/TOKEN|GITHUB/);
      const net = await sb.run('getent hosts github.com || echo NO_NETWORK', { timeoutMs: 20_000 });
      expect(net.stdout).toContain('NO_NETWORK');
      const slow = await sb.run('sleep 30', { timeoutMs: 2_000 });
      expect(slow.code).not.toBe(0);
    } finally { await sb.close(); }
  }, 60_000);
});
