import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { NodeConfig } from '../src/config.js';
import { estimateMemoryMb, modelFolders, probeServers, suggestedModels, toolSmokeTest, useServer, type DetectedServer } from '../src/models/detect.js';

const routes: Record<string, unknown> = {
  '/api/tags': { models: [{ name: 'qwen2.5-coder:14b', size: 9_000_000_000 }] },
  '/v1/models': { data: [{ id: 'local-model' }] },
  '/api/show': { capabilities: ['completion', 'tools'] },
  '/v1/chat/completions': { choices: [{ message: { tool_calls: [{ id: '1', type: 'function', function: { name: 'get_time', arguments: '{"zone":"UTC"}' } }] } }] },
};
async function fakeFetch(): Promise<{ fetchFn: typeof fetch; close(): void }> {
  const srv = createServer((req, res) => {
    const body = routes[req.url ?? ''];
    res.statusCode = body ? 200 : 404; res.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  // every probe address is answered by the one fake server
  const fetchFn = ((url: string, init?: RequestInit) => fetch(url.replace(/^http:\/\/127\.0\.0\.1:\d+/, `http://127.0.0.1:${port}`), init)) as typeof fetch;
  return { fetchFn, close: () => srv.close() };
}

describe('probeServers', () => {
  it('finds Ollama through /api/tags and OpenAI-compatible servers through /v1/models', async () => {
    const { fetchFn, close } = await fakeFetch();
    try {
      const found = await probeServers(fetchFn);
      const ollama = found.find((s) => s.kind === 'ollama')!;
      expect(ollama).toMatchObject({ endpoint: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen2.5-coder:14b', sizeBytes: 9_000_000_000, tools: true }] });
      expect(found.find((s) => s.kind === 'lmstudio')!.models).toEqual([{ id: 'local-model', sizeBytes: null, tools: null }]);
    } finally { close(); }
  });

  it('returns nothing when nothing is listening', async () => {
    expect(await probeServers((() => Promise.reject(new Error('refused'))) as typeof fetch)).toEqual([]);
  });
});

describe('useServer', () => {
  const server: DetectedServer = { kind: 'ollama', endpoint: 'http://127.0.0.1:11434/v1', models: [{ id: 'a', sizeBytes: 5 * 1024 ** 3, tools: true }, { id: 'b', sizeBytes: null, tools: null }] };
  const config = () => NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node', roleModels: { backend: 'old' }, models: [{ id: 'old', memoryMb: 100 }], defaultModel: 'old' });

  it('switches to external mode and replaces the model list', () => {
    const c = config();
    useServer(c, server, ['a', 'b']);
    expect(c).toMatchObject({ modelEndpoint: 'http://127.0.0.1:11434/v1', modelServer: { mode: 'external' }, defaultModel: 'a', roleModels: {} });
    expect(c.models).toEqual([{ id: 'a', memoryMb: 6144, backend: 'local' }, { id: 'b', memoryMb: 8192, backend: 'local' }]);
  });

  it('refuses an unknown model and an empty choice, leaving the config alone', () => {
    const c = config();
    expect(() => useServer(c, server, ['nope'])).toThrow(/no model "nope"/);
    expect(() => useServer(c, server, [])).toThrow(/at least one/);
    expect(c.defaultModel).toBe('old');
  });
});

describe('helpers', () => {
  it('estimates memory and honours OLLAMA_MODELS / HF_HOME', () => {
    expect(estimateMemoryMb(null)).toBe(8192);
    expect(modelFolders({ OLLAMA_MODELS: '/m', HF_HOME: '/hf' }, '/h').map((f) => f.dir)).toEqual(['/m', '/h/.lmstudio/models', '/h/.cache/lm-studio/models', '/hf/hub']);
  });
});

describe('choosing and checking models', () => {
  const m = (id: string, tools: boolean | null) => ({ id, sizeBytes: null, tools });
  it('proposes the tool-capable models, else every model not known to lack tools', () => {
    expect(suggestedModels({ kind: 'ollama', endpoint: 'e', models: [m('a', true), m('b', false), m('c', null)] })).toEqual(['a']);
    expect(suggestedModels({ kind: 'lmstudio', endpoint: 'e', models: [m('b', false), m('c', null)] })).toEqual(['c']);
  });

  it('smoke test passes when the model calls the tool and fails clearly otherwise', async () => {
    const { fetchFn, close } = await fakeFetch();
    try {
      expect(await toolSmokeTest('http://127.0.0.1:11434/v1', 'x', fetchFn)).toEqual({ ok: true, detail: 'called the tool' });
    } finally { close(); }
    const text = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'It is noon' } }] }))) as unknown as typeof fetch;
    expect(await toolSmokeTest('http://e/v1', 'x', text)).toEqual({ ok: false, detail: 'answered without calling the tool' });
    const down = (() => Promise.reject(new Error('refused'))) as typeof fetch;
    expect((await toolSmokeTest('http://e/v1', 'x', down)).ok).toBe(false);
  });
});
