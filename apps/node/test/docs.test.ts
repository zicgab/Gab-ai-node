import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '@gab-ai-node/protocol';
import { DocsRunner, LENSES, parseLens } from '../src/agent/docs-runner.js';
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

async function setup(instructions: string): Promise<TaskContext> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'gab-docs-'));
  const appDir = path.join(tmp, 'bos'); const apiDir = path.join(tmp, 'api');
  await mkdir(appDir, { recursive: true }); await mkdir(apiDir, { recursive: true });
  await writeFile(path.join(appDir, 'page.tsx'), 'export default () => <p>Export to CSV</p>;\n');
  await writeFile(path.join(apiDir, 'routes.js'), "router.get('/expenses/export.xlsx', h);\n");
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) await exec('git', ['-C', appDir, ...args], { check: true });
  const task: TaskSpec = {
    id: randomUUID(), kind: 'docs_check', repo: 'zicgab/bos', extraRepos: ['zicgab/api'], ref: null, instructions, backend: 'local', model: 'fake',
    budget: { maxSteps: 20, maxMinutes: 10, maxTokens: 1e6 }, branch: null, findingId: null, attempt: 1, role: null, paths: [], chat: null,
  };
  return {
    task, config: NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' }), workdir: appDir, extraDirs: { 'zicgab/api': apiDir },
    signal: new AbortController().signal, emit: () => {}, secrets: { github: null, anthropic: null }, modelEndpoint: async () => 'http://unused',
    commitAndPush: async () => { throw new Error('docs_check never pushes'); },
  };
}

describe('parseLens', () => {
  it('reads and strips the marker, cycles past the last lens, defaults to the first', () => {
    expect(parseLens('[lens:2] check expenses')).toEqual({ lens: 2, rest: 'check expenses' });
    expect(parseLens(`[lens:${LENSES.length + 1}] x`).lens).toBe(1);
    expect(parseLens('plain')).toEqual({ lens: 0, rest: 'plain' });
  });
});

describe('DocsRunner', () => {
  it('starts from the lens of the task and reports a gap as a finding', async () => {
    const report = { summary: 'compared', problems: [{
      title: 'Export to XLSX is not documented', severity: 'medium', file: '@zicgab/api/routes.js', line: 1,
      evidence: 'backend routes.js:1 serves export.xlsx; docs page.tsx only says CSV', suggestedFix: 'mention XLSX export',
    }] };
    const backend = scripted([{ content: JSON.stringify(report) }]);
    const res = await new DocsRunner(() => backend, path.join(os.tmpdir(), 'idx-' + randomUUID())).run(await setup('[lens:2] expenses'));
    expect(res.findings).toHaveLength(1);
    expect(res.summary).toBe('lens 3/5: 1 gap(s) between the product and its docs');
    expect(res).toMatchObject({ branch: null, commits: [] });
    const user = backend.seen[0]![1]!.content as string;
    expect(user).toContain(LENSES[2]);
    expect(user).toContain('Task:\nexpenses');
    expect(user).not.toContain('[lens:');
  });

  it('keeps a report whose line is "absent" or a range instead of a number (it used to be thrown away)', async () => {
    const problem = (title: string, line: unknown) => ({ title, severity: 'low', file: 'page.tsx', line, evidence: `app a.tsx:1 vs docs page.tsx: ${title}` });
    const report = { summary: 'compared', problems: [problem('no line', 'absent'), problem('range', '12-20'), problem('number', 7), problem('empty', '')] };
    const backend = scripted([{ content: JSON.stringify(report) }]);
    const res = await new DocsRunner(() => backend, path.join(os.tmpdir(), 'idx-' + randomUUID())).run(await setup('[lens:0] expenses'));
    expect(backend.seen).toHaveLength(1);
    expect(Object.fromEntries(res.findings.map((f) => [f.title, f.line]))).toEqual({ 'no line': null, range: 12, number: 7, empty: null });
  });
});
