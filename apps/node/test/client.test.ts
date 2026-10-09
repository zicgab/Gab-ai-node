// The node client against a fake backend: the paths and headers gasysteme's ai-worker/agent expects.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, CoordinatorClient } from '../src/client.js';

interface Seen { method: string; url: string; auth: string | undefined; version: string | undefined; body: unknown }
const TOKEN = 't'.repeat(43);

describe('CoordinatorClient', () => {
  let server: Server;
  let base: string;
  let seen: Seen[];
  let reply: (url: string) => { status: number; body: unknown };

  beforeEach(async () => {
    seen = [];
    reply = () => ({ status: 200, body: {} });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, version: req.headers['x-worker-version'] as string | undefined, body: text ? JSON.parse(text) : null });
        const r = reply(req.url ?? '');
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('registers with the node key on /node/agent/register and returns the node token', async () => {
    reply = () => ({ status: 200, body: { name: 'mac', project: 'agent', created: true, token: TOKEN } });
    const res = await CoordinatorClient.register(base, 'k'.repeat(40), 'mac');
    expect(res.token).toBe(TOKEN);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/node/agent/register', auth: `Bearer ${'k'.repeat(40)}`, body: { name: 'mac' } });
  });

  it('refuses a registration answer without a real token', async () => {
    reply = () => ({ status: 200, body: { name: 'mac', project: 'agent', created: true, token: 'short' } });
    await expect(CoordinatorClient.register(base, 'k'.repeat(40), 'mac')).rejects.toThrow();
  });

  it('calls /worker/agent/* with the node token and its version', async () => {
    reply = () => ({ status: 200, body: { held: [], cancel: [], available: true, leaseSeconds: 120 } });
    await new CoordinatorClient(base, TOKEN).heartbeat([]);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/worker/agent/heartbeat', auth: `Bearer ${TOKEN}`, version: '0.1.0' });
  });

  it('turns a 401 into a final ApiError carrying the backend message', async () => {
    reply = () => ({ status: 401, body: { success: false, message: 'Missing or invalid worker token' } });
    const err = await new CoordinatorClient(base, TOKEN).heartbeat([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).final).toBe(true);
    expect((err as ApiError).message).toContain('Missing or invalid worker token');
  });

  it('downloads only its own version and code, to a file', async () => {
    reply = () => ({ status: 200, body: { sha: 'a'.repeat(40) } });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gab-client-'));
    const file = path.join(dir, 'version.json');
    await new CoordinatorClient(base, TOKEN).download('/node/agent/version', file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sha: 'a'.repeat(40) });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/node/agent/version', auth: `Bearer ${TOKEN}` });
    for (const bad of ['/node/retouch/code?ref=' + 'a'.repeat(40), '/worker/agent/claim', '/node/agent/code?ref=main', 'http://evil/x']) {
      await expect(new CoordinatorClient(base, TOKEN).download(bad, file)).rejects.toThrow(/refusing/);
    }
  });
});
