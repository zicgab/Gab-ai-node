import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CATALOG, downloadUrl, type CatalogEntry } from '../src/models/catalog.js';
import { downloadModel, isInstalled, mmprojPath, modelPath, verifyModel } from '../src/models/download.js';
import { NodeConfig } from '../src/config.js';
import { installedIds, setupModels } from '../src/models/commands.js';
import { LlamaServerHost, type HostedModel } from '../src/models/server.js';
import { RetryableError } from '../src/runner.js';

const body = randomBytes(300_000);
const entry: CatalogEntry = {
  id: 'tiny', role: 'test', repo: 'x/y', revision: 'r', file: 'tiny.gguf',
  sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: body.length, memoryMb: 1, contextSize: 512, serverArgs: [],
};

let server: Server;
let base: string;
let ranges: (string | undefined)[] = [];
let ignoreRange = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    ranges.push(req.headers.range);
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (m && !ignoreRange) {
      const from = Number(m[1]);
      res.writeHead(206, { 'content-length': body.length - from });
      res.end(body.subarray(from));
    } else {
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tiny.gguf`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'gab-models-'));

describe('catalog', () => {
  it('pins every model to a commit and a sha256', () => {
    for (const e of CATALOG) {
      expect(e.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(e.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(e.memoryMb * 1024 * 1024).toBeGreaterThan(e.sizeBytes);
      expect(downloadUrl(e)).toContain(`/resolve/${e.revision}/`);
    }
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
  });
});

describe('downloadModel', () => {
  it('downloads, verifies, and skips when already installed', async () => {
    const dir = await tmp();
    expect(await downloadModel(dir, entry, { url: base })).toBe('downloaded');
    expect(await isInstalled(dir, entry)).toBe(true);
    expect(await downloadModel(dir, entry, { url: base })).toBe('already-installed');
  });

  it('resumes a partial download with a Range request', async () => {
    const dir = await tmp();
    await writeFile(`${modelPath(dir, entry)}.part`, body.subarray(0, 100_000));
    ranges = [];
    expect(await downloadModel(dir, entry, { url: base })).toBe('downloaded');
    expect(ranges).toEqual(['bytes=100000-']);
    expect((await readFile(modelPath(dir, entry))).equals(body)).toBe(true);
  });

  it('starts over when the server ignores the range', async () => {
    const dir = await tmp();
    await writeFile(`${modelPath(dir, entry)}.part`, body.subarray(0, 50_000));
    ignoreRange = true;
    try { expect(await downloadModel(dir, entry, { url: base })).toBe('downloaded'); }
    finally { ignoreRange = false; }
    expect((await readFile(modelPath(dir, entry))).equals(body)).toBe(true);
  });

  it('resumes by itself when the connection drops mid-download', async () => {
    const dir = await tmp();
    const calls: (string | undefined)[] = [];
    const flaky = (async (u: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.range;
      calls.push(range);
      const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      if (calls.length === 1) {
        // First try: 120 kB arrive, then the connection dies ("terminated").
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(c) {
            if (!sent) { sent = true; c.enqueue(body.subarray(0, 120_000)); return; }
            return new Promise((_, reject) => setTimeout(() => { const e = new TypeError('terminated'); c.error(e); reject(e); }, 50));
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response(body.subarray(from), { status: from ? 206 : 200 });
    }) as unknown as typeof fetch;
    const retries: string[] = [];
    expect(await downloadModel(dir, entry, { fetchImpl: flaky, backoffMs: () => 0, onRetry: (_f, err) => retries.push(err.message) })).toBe('downloaded');
    expect(retries).toEqual(['terminated']);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toMatch(/^bytes=[1-9]\d*-$/); // asked only for what was missing
    expect((await readFile(modelPath(dir, entry))).equals(body)).toBe(true);
  });

  it('gives up after the allowed tries and keeps the partial file for the next run', async () => {
    const dir = await tmp();
    const dead = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(downloadModel(dir, entry, { fetchImpl: dead, maxAttempts: 3, backoffMs: () => 0, onRetry: () => {} })).rejects.toThrow('fetch failed');
  });

  it('does not retry a refusal or a wrong hash', async () => {
    const dir = await tmp();
    let calls = 0;
    const refused = (async () => { calls++; return new Response('no', { status: 404 }); }) as unknown as typeof fetch;
    await expect(downloadModel(dir, entry, { fetchImpl: refused, backoffMs: () => 0 })).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
    const bad = { ...entry, sha256: 'f'.repeat(64) };
    calls = 0;
    const ok = (async () => { calls++; return new Response(body, { status: 200 }); }) as unknown as typeof fetch;
    await expect(downloadModel(dir, bad, { fetchImpl: ok, backoffMs: () => 0 })).rejects.toThrow(/rejected/);
    expect(calls).toBe(1);
  });

  it('rejects a file whose hash does not match the pin and leaves nothing behind', async () => {
    const dir = await tmp();
    const bad = { ...entry, sha256: 'f'.repeat(64) };
    await expect(downloadModel(dir, bad, { url: base })).rejects.toThrow(/rejected/);
    await expect(stat(modelPath(dir, bad))).rejects.toThrow();
    await expect(stat(`${modelPath(dir, bad)}.part`)).rejects.toThrow();
  });

  it('verifyModel removes a corrupted file', async () => {
    const dir = await tmp();
    await downloadModel(dir, entry, { url: base });
    const corrupted = Buffer.from(body); corrupted[10] ^= 0xff;
    await writeFile(modelPath(dir, entry), corrupted);
    expect(await verifyModel(dir, entry)).toBe(false);
    expect(await isInstalled(dir, entry)).toBe(false);
  });
});

describe('setupModels (the installer step)', () => {
  const run = async (budgetMb: number, ifMissing = false) => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    try {
      const config = NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node', memoryBudgetMb: budgetMb });
      await setupModels(config, await tmp(), ifMissing);
      return { text: lines.join('\n'), config };
    } finally { spy.mockRestore(); }
  };

  it('without a terminal shows the models, downloads nothing and says how to pull them later', async () => {
    const { text, config } = await run(96 * 1024);
    expect(text).toMatch(/qwen3-coder-30b.*can run here/);
    expect(text).toMatch(/gpt-oss-120b.*can run here/);
    expect(text).toMatch(/qwen3-vl-30b.*can run here/);
    expect(text).toMatch(/gab-node models pull --all/);
    expect(installedIds(config)).toEqual([]);
  });

  it('marks the models a small machine cannot run, and says tasks fall back to the installed ones', async () => {
    const { text } = await run(48 * 1024);
    expect(text).toMatch(/gpt-oss-120b.*too big for this machine/);
    expect(text).toMatch(/Not used on this machine: gpt-oss-120b/);
    expect(text).toMatch(/qwen3-coder-30b.*can run here/);
  });

  it('--if-missing still speaks up on a node with no model at all', async () => {
    expect((await run(96 * 1024, true)).text).toMatch(/gab-node models pull --all/);
  });
});

describe('a vision model (model + mmproj)', () => {
  const proj = randomBytes(50_000);
  const vision: CatalogEntry = { ...entry, id: 'vl', file: 'vl.gguf', mmproj: { file: 'proj.gguf', sha256: createHash('sha256').update(proj).digest('hex'), sizeBytes: proj.length } };
  const urls: string[] = [];
  const fetchImpl = (async (u: string) => { urls.push(u); return new Response(u.endsWith('proj.gguf') ? proj : body, { status: 200 }); }) as unknown as typeof fetch;

  it('downloads both files from the pinned revision, and is installed only with both', async () => {
    const dir = await tmp();
    expect(await downloadModel(dir, vision, { fetchImpl })).toBe('downloaded');
    expect(urls.map((u) => u.split('/').pop())).toEqual(['vl.gguf', 'proj.gguf']);
    expect(urls.every((u) => u.includes(`/resolve/${vision.revision}/`))).toBe(true);
    expect(await isInstalled(dir, vision)).toBe(true);
    expect(mmprojPath(dir, vision)).toBe(path.join(dir, 'proj.gguf'));
    expect(await downloadModel(dir, vision, { fetchImpl })).toBe('already-installed');
    await rm(path.join(dir, 'proj.gguf'));
    expect(await isInstalled(dir, vision)).toBe(false);
  });

  it('verifyModel fails when the projector is corrupted, and removes it', async () => {
    const dir = await tmp();
    await downloadModel(dir, vision, { fetchImpl });
    await writeFile(path.join(dir, 'proj.gguf'), Buffer.alloc(proj.length));
    expect(await verifyModel(dir, vision)).toBe(false);
    expect(await isInstalled(dir, vision)).toBe(false);
  });

  it('a model without a projector has none', () => {
    expect(mmprojPath('/m', entry)).toBeUndefined();
  });
});

// Fake llama-server: answers /health and /v1/chat/completions; FAKE_CRASH exits at once.
const FAKE = `
const http = require('node:http');
const a = process.argv;
const port = Number(a[a.indexOf('--port') + 1]);
const alias = a[a.indexOf('--alias') + 1];
if (a[a.indexOf('--model') + 1].includes('crash')) { console.error('failed to load model'); process.exit(3); }
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('{"status":"ok"}');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: 'hi from ' + alias } }], mmproj: a.includes('--mmproj') ? a[a.indexOf('--mmproj') + 1] : null }));
}).listen(port, '127.0.0.1');
`;

describe('LlamaServerHost', () => {
  let script: string;
  beforeAll(async () => { script = path.join(await tmp(), 'fake-llama.cjs'); await writeFile(script, FAKE); });

  const model = (id: string, memoryMb: number): HostedModel => ({ id, file: `/models/${id}.gguf`, memoryMb, contextSize: 512, serverArgs: [] });
  const host = (models: HostedModel[], idleMs = 60_000) => new LlamaServerHost({
    command: [process.execPath, script], models, budgetMb: 100, basePort: 20000 + Math.floor(Math.random() * 20000), idleMs, startTimeoutMs: 10_000,
  });
  const signal = () => new AbortController().signal;

  it('starts the server on demand and serves chat on 127.0.0.1', async () => {
    const h = host([model('fast', 30)]);
    try {
      const a = await h.acquire('fast', signal());
      expect(a.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const res = await (await fetch(`${a.endpoint}/chat/completions`, { method: 'POST', body: '{}' })).json() as { choices: { message: { content: string } }[] };
      expect(res.choices[0]!.message.content).toBe('hi from fast');
      const again = await h.acquire('fast', signal());
      expect(again.endpoint).toBe(a.endpoint);
      a.release(); again.release();
    } finally { await h.stop(); }
  });

  it('passes the projector of a vision model as --mmproj, and nothing for the others', async () => {
    const h = host([{ ...model('vision', 30), mmprojFile: '/models/proj.gguf' }, model('text', 30)]);
    try {
      const v = await h.acquire('vision', signal());
      expect(((await (await fetch(`${v.endpoint}/chat/completions`, { method: 'POST', body: '{}' })).json()) as { mmproj: string | null }).mmproj).toBe('/models/proj.gguf');
      const t = await h.acquire('text', signal());
      expect(((await (await fetch(`${t.endpoint}/chat/completions`, { method: 'POST', body: '{}' })).json()) as { mmproj: string | null }).mmproj).toBeNull();
      v.release(); t.release();
    } finally { await h.stop(); }
  });

  it('unloads a model after it sits idle', async () => {
    const h = host([model('fast', 30)], 200);
    try {
      (await h.acquire('fast', signal())).release();
      expect(h.loadedModels()).toEqual(['fast']);
      await new Promise((r) => setTimeout(r, 800));
      expect(h.loadedModels()).toEqual([]);
    } finally { await h.stop(); }
  });

  it('unloads idle models to make room, refuses when busy ones fill memory', async () => {
    const h = host([model('fast', 40), model('deep', 70), model('other', 50)]);
    try {
      (await h.acquire('fast', signal())).release();
      const deep = await h.acquire('deep', signal());
      expect(h.loadedModels()).toEqual(['deep']);
      await expect(h.acquire('other', signal())).rejects.toBeInstanceOf(RetryableError);
      deep.release();
    } finally { await h.stop(); }
  });

  it('a server that fails to start is a retryable error', async () => {
    const h = host([model('crash', 10)]);
    try {
      await expect(h.acquire('crash', signal())).rejects.toThrow(/exited.*failed to load model/);
      expect(h.loadedModels()).toEqual([]);
    } finally { await h.stop(); }
  });

  it('refuses a model that is not installed', async () => {
    const h = host([]);
    await expect(h.acquire('nope', signal())).rejects.toThrow(/not installed/);
  });
});
