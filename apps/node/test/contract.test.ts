import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '@gab-ai-node/protocol';
import { ContractRunner } from '../src/agent/contract-runner.js';
import type { ChatMessage, ChatResponse, ModelBackend } from '../src/backends/types.js';
import { NodeConfig } from '../src/config.js';
import { exec } from '../src/exec.js';
import type { TaskContext } from '../src/runner.js';

const scripted = (responses: Partial<ChatMessage>[]): ModelBackend & { seen: ChatMessage[][] } => {
  const seen: ChatMessage[][] = []; let i = 0;
  return { model: 'fake', seen, async chat(messages): Promise<ChatResponse> {
    seen.push([...messages]);
    return { message: { role: 'assistant', content: null, ...responses[Math.min(i++, responses.length - 1)]! }, tokens: 5, finishReason: 'stop' };
  } };
};
const call = (name: string, args: unknown) => ({ tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });

async function setup(withClient: boolean): Promise<TaskContext> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'gab-contract-'));
  const backendDir = path.join(tmp, 'backend'); const clientDir = path.join(tmp, 'client');
  await mkdir(backendDir, { recursive: true }); await mkdir(clientDir, { recursive: true });
  await writeFile(path.join(backendDir, 'routes.js'), "router.post('/orders', (req, res) => res.json({ orderId: 1 }));\n");
  await writeFile(path.join(clientDir, 'api.ts'), "export const create = () => fetch('/order', { method: 'POST' });\n");
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) await exec('git', ['-C', backendDir, ...args], { check: true });
  const task: TaskSpec = {
    id: randomUUID(), kind: 'contract_check', repo: 'zicgab/backend', extraRepos: withClient ? ['zicgab/app'] : [], ref: null, instructions: '', backend: 'local', model: 'fake',
    budget: { maxSteps: 20, maxMinutes: 10, maxTokens: 1e6 }, branch: null, findingId: null, attempt: 1, role: null, paths: [], chat: null,
  };
  return {
    task, config: NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' }), workdir: backendDir, extraDirs: withClient ? { 'zicgab/app': clientDir } : {},
    signal: new AbortController().signal, emit: () => {}, secrets: { github: null, anthropic: null }, modelEndpoint: async () => 'http://unused',
    commitAndPush: async () => { throw new Error('contract_check never pushes'); },
  };
}

describe('ContractRunner', () => {
  it('needs at least one client repo', async () => {
    await expect(new ContractRunner(() => scripted([]), os.tmpdir()).run(await setup(false))).rejects.toThrow(/at least one client repo/);
  });

  it('reads both sides and reports a mismatch as a finding with both sides in the evidence', async () => {
    const report = { summary: 'compared 1 call', problems: [{
      title: 'Client calls /order, backend serves /orders', severity: 'high', file: '@zicgab/app/api.ts', line: 1,
      evidence: 'backend routes.js:1 POST /orders vs client @zicgab/app/api.ts:1 POST /order', suggestedFix: 'rename the client path',
    }] };
    const backend = scripted([call('read_file', { path: '@zicgab/app/api.ts' }), call('grep', { pattern: 'orders' }), { content: JSON.stringify(report) }]);
    const res = await new ContractRunner(() => backend, path.join(os.tmpdir(), 'idx-' + randomUUID())).run(await setup(true));
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ severity: 'high', file: '@zicgab/app/api.ts', line: 1 });
    expect(res.summary).toBe('1 mismatch(es) between zicgab/backend and 1 client(s)');
    expect(res).toMatchObject({ branch: null, commits: [] });
    expect(backend.seen[0]![1]!.content).toContain('Clients: @zicgab/app/');
  });
});
