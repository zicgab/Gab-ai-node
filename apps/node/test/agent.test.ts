import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTools, resolveInside } from '../src/agent/tools.js';
import { CodeIndex } from '../src/agent/code-index.js';
import { runAgent } from '../src/agent/loop.js';
import type { ChatMessage, ChatResponse, ModelBackend } from '../src/backends/types.js';

let root: string; let extra: string; let outside: string;

beforeAll(async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'gab-agent-'));
  root = path.join(tmp, 'repo'); extra = path.join(tmp, 'extra'); outside = path.join(tmp, 'secret.txt');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(extra, { recursive: true });
  await writeFile(outside, 'TOP SECRET');
  await writeFile(path.join(root, 'src', 'users.ts'), 'export async function getUserById(id: string) {\n  return db.find(id);\n}\nexport class UserService {}\nrouter.post(\'/users/login\', handler);\n');
  await writeFile(path.join(root, 'worker.py'), 'def claim_batch(worker):\n    pass\n');
  await writeFile(path.join(extra, 'api.md'), 'extra repo docs');
  await symlink(outside, path.join(root, 'leak.txt'));
});

const roots = () => ({ main: root, extra: { 'zicgab/front': extra } });

describe('path confinement', () => {
  it.each(['../secret.txt', '/etc/passwd', 'src/../../secret.txt', 'C:/Windows'])('refuses %s', async (p) => {
    await expect(resolveInside(roots(), p)).rejects.toThrow();
  });
  it('refuses symlinks leading outside', async () => {
    await expect(resolveInside(roots(), 'leak.txt')).rejects.toThrow(/links outside/);
  });
  it('resolves extra repos by @owner/name', async () => {
    expect((await resolveInside(roots(), '@zicgab/front/api.md')).rel).toBe('api.md');
    await expect(resolveInside(roots(), '@zicgab/nope/x')).rejects.toThrow(/unknown repo/);
  });
});

describe('tools', () => {
  it('reads with line numbers, lists, greps', async () => {
    const tools = Object.fromEntries(createTools(roots(), null).map((t) => [t.name, t]));
    expect(await tools.read_file!.run({ path: 'src/users.ts', start: 2, end: 2 })).toContain('2\t  return db.find(id);');
    expect(await tools.list_dir!.run({ path: '' })).toMatch(/src\/\n.*worker\.py/s);
    expect(await tools.grep!.run({ pattern: 'claim_batch' })).toMatch(/worker\.py:1:/);
  });
});

describe('CodeIndex', () => {
  it('finds definitions by name, part of name and words', async () => {
    const index = await CodeIndex.build(root);
    expect(index.search('getUserById')[0]).toMatchObject({ file: 'src/users.ts', line: 1, kind: 'function' });
    expect(index.search('UserService')[0]).toMatchObject({ kind: 'class' });
    expect(index.search('claim batch')[0]).toMatchObject({ file: 'worker.py' });
    expect(index.search('login').map((h) => h.name)).toContain('POST /users/login');
  });
});

/** Scripted model: returns the given responses in order. */
function scripted(responses: Partial<ChatMessage>[]): ModelBackend & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return {
    model: 'fake', seen,
    async chat(messages): Promise<ChatResponse> {
      seen.push([...messages]);
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return { message: { role: 'assistant', content: null, ...r }, tokens: 100, finishReason: 'stop' };
    },
  };
}
const call = (name: string, args: unknown, id = 'c1') => ({ tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });

describe('runAgent', () => {
  const base = { system: 's', user: 'u', maxTokens: 1e6, signal: new AbortController().signal, emit: () => {} };

  it('calls tools, feeds results back, returns the answer', async () => {
    const backend = scripted([call('read_file', { path: 'src/users.ts' }), { content: 'Defined at src/users.ts:1' }]);
    const run = await runAgent({ ...base, backend, tools: createTools(roots(), null), maxSteps: 10 });
    expect(run).toMatchObject({ answer: 'Defined at src/users.ts:1', steps: 2, stoppedBy: 'answer' });
    const toolMsg = backend.seen[1]!.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('getUserById');
  });

  it('tool errors go back to the model instead of failing the task', async () => {
    const backend = scripted([call('read_file', { path: '../secret.txt' }), { content: 'cannot read it' }]);
    const run = await runAgent({ ...base, backend, tools: createTools(roots(), null), maxSteps: 10 });
    const toolMsg = backend.seen[1]!.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/^Error: .*outside/);
    expect(toolMsg?.content).not.toContain('TOP SECRET');
    expect(run.answer).toBe('cannot read it');
  });

  it('forces an answer when the step budget ends', async () => {
    const backend = scripted([call('list_dir', { path: '' }), call('list_dir', { path: '' }), { content: 'partial answer' }]);
    const run = await runAgent({ ...base, backend, tools: createTools(roots(), null), maxSteps: 2 });
    expect(run).toMatchObject({ steps: 2, stoppedBy: 'steps', answer: '(the model returned an empty answer)' });
  });

  it('stops on abort', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(runAgent({ ...base, signal: ac.signal, backend: scripted([{ content: 'x' }]), tools: [], maxSteps: 3 })).rejects.toThrow();
  });
});
