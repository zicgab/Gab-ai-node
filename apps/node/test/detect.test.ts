import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { NodeConfig } from '../src/config.js';
import { estimateMemoryMb, modelFolders, probeServers, useServer, type DetectedServer } from '../src/models/detect.js';

const routes: Record<string, unknown> = {
  '/api/tags': { models: [{ name: 'qwen2.5-coder:14b', size: 9_000_000_000 }] },
  '/v1/models': { data: [{ id: 'local-model' }] },
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
      expect(ollama).toMatchObject({ endpoint: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen2.5-coder:14b', sizeBytes: 9_000_000_000 }] });
      expect(found.find((s) => s.kind === 'lmstudio')!.models).toEqual([{ id: 'local-model', sizeBytes: null }]);
    } finally { close(); }
  });

  it('returns nothing when nothing is listening', async () => {
    expect(await probeServers((() => Promise.reject(new Error('refused'))) as typeof fetch)).toEqual([]);
  });
});

describe('useServer', () => {
  const server: DetectedServer = { kind: 'ollama', endpoint: 'http://127.0.0.1:11434/v1', models: [{ id: 'a', sizeBytes: 5 * 1024 ** 3 }, { id: 'b', sizeBytes: null }] };
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
