import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '@gab-ai-node/protocol';
import { ChatRunner } from '../src/agent/chat-runner.js';
import { runAgent } from '../src/agent/loop.js';
import { checkJsonTranslations, placeholders, TranslateRunner } from '../src/agent/translate-runner.js';
import { createWebTools } from '../src/agent/web-tools.js';
import { OpenAICompatibleBackend } from '../src/backends/openai-compatible.js';
import type { ChatMessage, ChatResponse, ModelBackend } from '../src/backends/types.js';
import { NodeConfig } from '../src/config.js';
import { exec } from '../src/exec.js';
import type { TaskContext } from '../src/runner.js';

const config = (extra: Record<string, unknown> = {}) => NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node', ...extra });
const call = (name: string, args: unknown): Partial<ChatMessage> => ({ tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const scripted = (answers: Partial<ChatMessage>[]): ModelBackend & { seen: ChatMessage[][] } => {
  const seen: ChatMessage[][] = []; let i = 0;
  return { model: 'fake', seen, async chat(m): Promise<ChatResponse> {
    seen.push(structuredClone(m));
    return { message: { role: 'assistant', content: null, ...answers[Math.min(i++, answers.length - 1)]! }, tokens: 2, finishReason: 'stop' };
  } };
};

async function server(handler: (body: Record<string, unknown>, res: import('node:http').ServerResponse) => void): Promise<{ url: string; bodies: Record<string, unknown>[]; close(): void }> {
  const bodies: Record<string, unknown>[] = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { const b = raw ? JSON.parse(raw) : {}; bodies.push(b); handler(b, res); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, bodies, close: () => srv.close() };
}

describe('streaming and partial chat replies', () => {
  it('chatStream joins the pieces, reports the text so far, reads usage', async () => {
    const s = await server((_b, res) => {
      res.setHeader('content-type', 'text/event-stream');
      for (const piece of ['Hel', 'lo', ' there']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 42 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    try {
      const seen: string[] = [];
      const r = await new OpenAICompatibleBackend(s.url, 'm').chatStream([{ role: 'user', content: 'hi' }], new AbortController().signal, (t) => seen.push(t));
      expect(r).toMatchObject({ message: { content: 'Hello there' }, tokens: 42, finishReason: 'stop' });
      expect(seen).toEqual(['Hel', 'Hello', 'Hello there']);
      expect(s.bodies[0]).toMatchObject({ stream: true });
    } finally { s.close(); }
  });

  it('the chat runner sends the answer so far as partial progress events (throttled)', async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const backend: ModelBackend = {
      model: 'm', chat: async () => { throw new Error('not used'); },
      async chatStream(_m, _s, onText) { onText('A'); onText('AB'); await new Promise((r) => setTimeout(r, 15)); onText('ABC'); return { message: { role: 'assistant', content: 'ABC' }, tokens: 3, finishReason: 'stop' }; },
    };
    const task = { id: randomUUID(), kind: 'chat', repo: null, extraRepos: [], ref: null, instructions: 'hi', backend: 'local', model: 'm', budget: { maxSteps: 1, maxMinutes: 1, maxTokens: 1e5 }, branch: null, findingId: null, attempt: 1, role: null, paths: [], chat: { system: null, history: [] } } as unknown as TaskSpec;
    const ctx = { task, config: config(), workdir: '', extraDirs: {}, signal: new AbortController().signal, emit: (type: string, data: Record<string, unknown>) => events.push({ type, data }), secrets: { github: null, anthropic: null }, modelEndpoint: async () => '', commitAndPush: async () => null } as unknown as TaskContext;
    const r = await new ChatRunner(() => backend, 10).run(ctx);
    expect(r.answer).toBe('ABC');
    expect(events.filter((e) => e.data.stage === 'partial').map((e) => e.data.text)).toEqual(['A', 'ABC']);
  });
});

describe('unparseable model output', () => {
  it('asks again when llama-server cannot parse the output, and gives up after 3 tries', async () => {
    let n = 0;
    const bad = JSON.stringify({ error: { code: 500, message: 'The model produced output that does not match the expected peg-native format' } });
    const s = await server((_b, res) => { n++; if (n < 3) { res.statusCode = 500; res.end(bad); } else res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); });
    try {
      const r = await new OpenAICompatibleBackend(s.url, 'm').chat([{ role: 'user', content: 'hi' }], [], new AbortController().signal);
      expect(r.message.content).toBe('ok');
      expect(n).toBe(3);
      n = -10; // always bad from now on
      await expect(new OpenAICompatibleBackend(s.url, 'm').chat([{ role: 'user', content: 'hi' }], [], new AbortController().signal)).rejects.toThrow(/peg-native/);
      expect(n).toBe(-7);
    } finally { s.close(); }
  });

  it('does not repeat other server errors', async () => {
    let n = 0;
    const s = await server((_b, res) => { n++; res.statusCode = 500; res.end('{"error":{"message":"out of memory"}}'); });
    try {
      await expect(new OpenAICompatibleBackend(s.url, 'm').chat([{ role: 'user', content: 'hi' }], [], new AbortController().signal)).rejects.toThrow(/out of memory/);
      expect(n).toBe(1);
    } finally { s.close(); }
  });
});

describe('screenshots for vision models', () => {
  it('only a vision model gets the screenshot tool', () => {
    const session = { call: async () => ({}) };
    expect(createWebTools(session).map((t) => t.name)).not.toContain('screenshot');
    expect(createWebTools(session, 'test_web', { vision: true }).map((t) => t.name)).toContain('screenshot');
  });

  it('the screenshot goes to the model as an image; only the newest stays in the conversation', async () => {
    let n = 0;
    const session = { call: async () => ({ url: 'http://localhost:3000/', title: 'Home', image: `data:image/jpeg;base64,IMG${++n}` }) };
    const tools = createWebTools(session, 'test_web', { vision: true });
    const backend = scripted([call('screenshot', {}), call('screenshot', {}), { content: 'done' }]);
    await runAgent({ backend, tools, system: 's', user: 'u', maxSteps: 5, maxTokens: 1e6, signal: new AbortController().signal, emit: () => {} });
    const last = backend.seen[2]!;
    const withImages = last.filter((m) => m.images?.length);
    expect(withImages).toHaveLength(1);
    expect(withImages[0]!.images).toEqual(['data:image/jpeg;base64,IMG2']);
    expect(last.some((m) => m.content?.includes('older screenshot removed'))).toBe(true);
  });

  it('images are sent as OpenAI image parts of a user message', async () => {
    const s = await server((_b, res) => res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));
    try {
      await new OpenAICompatibleBackend(s.url, 'm').chat([{ role: 'user', content: 'look', images: ['data:image/jpeg;base64,AAA'] }], [], new AbortController().signal);
      expect((s.bodies[0]!.messages as unknown[])[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }] });
    } finally { s.close(); }
  });
});

describe('translate', () => {
  it('finds placeholders of the common i18n styles', () => {
    expect(placeholders('Hi {name}, {{count}} items, %s and %1$d, :user')).toEqual(['%1$d', '%s', ':user', '{name}', '{{count}}'].sort());
    expect(placeholders('10:30 at http://x.io')).toEqual([]);
  });

  it('refuses broken JSON and lost placeholders', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gab-tr-'));
    await mkdir(path.join(dir, 'locales'));
    await writeFile(path.join(dir, 'locales', 'en.json'), JSON.stringify({ greet: 'Hi {name}', items: { count: '{{n}} items' } }));
    await writeFile(path.join(dir, 'locales', 'fr.json'), JSON.stringify({ greet: 'Bonjour', items: { count: '{{n}} articles' } }));
    await writeFile(path.join(dir, 'locales', 'es.json'), '{ "greet": ');
    const problems = await checkJsonTranslations(dir, ['locales/fr.json', 'locales/es.json'], 'locales/en.json');
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/fr\.json: "greet"/);
    expect(problems[1]).toMatch(/es\.json: not valid JSON/);
  });

  it('writes the translation and commits it on the agent branch', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gab-tr-repo-'));
    await mkdir(path.join(dir, 'locales'));
    await writeFile(path.join(dir, 'locales', 'en.json'), JSON.stringify({ greet: 'Hi {name}' }, null, 2));
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) await exec('git', ['-C', dir, ...args], { check: true });
    const backend = scripted([
      call('write_file', { path: 'locales/fr.json', content: JSON.stringify({ greet: 'Bonjour {name}' }, null, 2) }),
      { content: JSON.stringify({ summary: 'French added', files: ['locales/fr.json'], languages: ['fr'], notes: null }) },
    ]);
    const commits: string[] = [];
    const task = { id: randomUUID(), kind: 'translate', repo: 'zicgab/app', extraRepos: [], ref: null, instructions: 'Translate the app into French. Source: en', backend: 'local', model: 'fake', budget: { maxSteps: 10, maxMinutes: 5, maxTokens: 1e6 }, branch: 'agent/test/1', findingId: null, attempt: 1, role: null, paths: [], chat: null } as unknown as TaskSpec;
    const ctx = { task, config: config(), workdir: dir, extraDirs: {}, signal: new AbortController().signal, emit: () => {}, secrets: { github: null, anthropic: null }, modelEndpoint: async () => '', commitAndPush: async (m: string) => { commits.push(m); return 'abc123'; } } as unknown as TaskContext;
    const r = await new TranslateRunner(() => backend).run(ctx);
    expect(r).toMatchObject({ branch: 'agent/test/1', commits: ['abc123'] });
    expect(commits[0]).toMatch(/^translate: fr \(1 file\(s\)\)/);
    expect(JSON.parse(await readFile(path.join(dir, 'locales', 'fr.json'), 'utf8'))).toEqual({ greet: 'Bonjour {name}' });
    expect(backend.seen[0]![0]!.content).not.toContain('run_cmd');
  });
});
