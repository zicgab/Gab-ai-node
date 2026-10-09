// Calls to the coordinator. Network failures are retried with backoff where
// losing the call would lose work (complete, fail); a 4xx is final.
import {
  ClaimResponse, GithubToken, HeartbeatResponse, RegisterResponse,
  type ClaimRequest, type Capabilities, type TaskResult,
} from '@gab-ai-node/protocol';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { z } from 'zod';
import { AGENT_VERSION } from './capabilities.js';

/** Where the node's calls go on the backend (gasysteme ai-worker/agent/node-router.js). */
const API = '/worker/agent';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
  /** Client errors (bad token, task no longer held) won't succeed if repeated. */
  get final(): boolean { return this.status >= 400 && this.status < 500; }
}

export class CoordinatorClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private async call<S extends z.ZodTypeAny>(path: string, body: unknown, schema: S | null, timeoutMs = 30_000, signal?: AbortSignal): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', 'x-worker-version': AGENT_VERSION },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ApiError(0, `cannot reach the backend at ${this.baseUrl}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try { message = (JSON.parse(text) as { message?: string }).message ?? message; } catch { /* not JSON */ }
      throw new ApiError(res.status, `HTTP ${res.status} on ${path}: ${message}`);
    }
    const json: unknown = text ? JSON.parse(text) : {};
    return schema ? schema.parse(json) : json;
  }

  /** Retries network and 5xx errors with backoff (up to ~5 minutes); rethrows final errors at once. */
  private async retrying<T>(what: string, fn: () => Promise<T>, onRetry?: (err: Error, attempt: number) => void): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (err) {
        if ((err instanceof ApiError && err.final) || attempt >= 10) throw err;
        onRetry?.(err as Error, attempt);
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
      }
    }
  }

  /**
   * Registers this machine as an agent node with the install key (backend NODE_API_KEY, used once,
   * never saved). Registering a name again gives it a new token: the old one stops working.
   */
  static async register(baseUrl: string, nodeKey: string, name: string): Promise<RegisterResponse> {
    return new CoordinatorClient(baseUrl, nodeKey).call('/node/agent/register', { name }, RegisterResponse);
  }

  /**
   * GET of the node's own code or version (update.sh), saved to a file. The token never leaves this
   * process. Only the backend's /node/agent/version and /node/agent/code are allowed.
   */
  async download(path: string, file: string): Promise<void> {
    if (!/^\/node\/agent\/(version|code\?ref=[0-9a-f]{40})$/.test(path)) throw new Error(`refusing to download ${path}`);
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), { headers: { authorization: `Bearer ${this.token}`, 'x-worker-version': AGENT_VERSION }, signal: AbortSignal.timeout(10 * 60_000) });
    } catch (err) {
      throw new ApiError(0, `cannot reach the backend at ${this.baseUrl}: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let message = text.slice(0, 300);
      try { message = (JSON.parse(text) as { message?: string }).message ?? message; } catch { /* not JSON */ }
      throw new ApiError(res.status, `HTTP ${res.status} on ${path}: ${message}`);
    }
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file, { mode: 0o600 }));
  }

  /** Uninstall: the backend puts the tasks this node holds back in the queue and turns the node off. */
  retire(): Promise<{ released: number }> {
    return this.call('/worker/retire', {}, null) as Promise<{ released: number }>;
  }

  /** Long-poll: the coordinator waits up to CLAIM_WAIT_SECONDS for work. */
  claim(req: ClaimRequest, signal?: AbortSignal): Promise<ClaimResponse> {
    return this.call(`${API}/claim`, req, ClaimResponse, 60_000, signal);
  }

  heartbeat(running: { taskId: string; leaseId: string }[], capabilities?: Capabilities): Promise<HeartbeatResponse> {
    return this.call(`${API}/heartbeat`, { running, capabilities }, HeartbeatResponse);
  }

  githubToken(taskId: string, leaseId: string): Promise<GithubToken> {
    return this.call(`${API}/tasks/${taskId}/github-token`, { leaseId }, GithubToken);
  }

  events(taskId: string, leaseId: string, events: { type: string; data: Record<string, unknown> }[]): Promise<unknown> {
    return this.call(`${API}/tasks/${taskId}/events`, { leaseId, events }, null);
  }

  complete(taskId: string, leaseId: string, result: TaskResult, onRetry?: (e: Error, n: number) => void): Promise<unknown> {
    return this.retrying('complete', () => this.call(`${API}/tasks/${taskId}/complete`, { leaseId, result }, null), onRetry);
  }

  fail(taskId: string, leaseId: string, error: string, retryable: boolean, onRetry?: (e: Error, n: number) => void): Promise<unknown> {
    return this.retrying('fail', () => this.call(`${API}/tasks/${taskId}/fail`, { leaseId, error: error.slice(0, 4000), retryable }, null), onRetry);
  }
}
