// Downloads a catalog model: resumable (.part + HTTP Range), hashed while
// streaming, size and SHA-256 checked before the file is renamed into place.
// A verified file gets a marker so later starts don't rehash 60 GB.
// A vision model has two files (the model and its mmproj); both must be there and verified.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CatalogEntry, PinnedFile } from './catalog.js';
import { catalogFiles, downloadUrl } from './catalog.js';

const filePath = (dir: string, f: PinnedFile) => path.join(dir, f.file);
const markerOf = (dir: string, f: PinnedFile) => `${filePath(dir, f)}.verified`;

export const modelPath = (dir: string, e: CatalogEntry) => filePath(dir, e);
/** The multimodal projector of a vision model (undefined for the others). */
export const mmprojPath = (dir: string, e: CatalogEntry) => (e.mmproj ? filePath(dir, e.mmproj) : undefined);

async function fileInstalled(dir: string, f: PinnedFile): Promise<boolean> {
  try {
    const [s, marker] = await Promise.all([stat(filePath(dir, f)), readFile(markerOf(dir, f), 'utf8')]);
    return s.size === f.sizeBytes && marker.trim() === f.sha256;
  } catch { return false; }
}

/** True when every file is there with the right size and was verified against its pinned hash. */
export async function isInstalled(dir: string, e: CatalogEntry): Promise<boolean> {
  return (await Promise.all(catalogFiles(e).map((f) => fileInstalled(dir, f)))).every(Boolean);
}

async function hashFile(file: string, hash = createHash('sha256')): Promise<ReturnType<typeof createHash>> {
  await pipeline(createReadStream(file), async function* (src) { for await (const chunk of src) hash.update(chunk as Buffer); });
  return hash;
}

/** Rehashes the installed files; removes a file and its marker on mismatch. */
export async function verifyModel(dir: string, e: CatalogEntry): Promise<boolean> {
  let all = true;
  for (const f of catalogFiles(e)) {
    const file = filePath(dir, f);
    let ok = false;
    try { ok = (await stat(file)).size === f.sizeBytes && (await hashFile(file)).digest('hex') === f.sha256; } catch { /* missing */ }
    if (ok) await writeFile(markerOf(dir, f), f.sha256);
    else { all = false; await Promise.all([rm(file, { force: true }), rm(markerOf(dir, f), { force: true })]); }
  }
  return all;
}

/** A failure that trying again cannot fix (wrong hash, no disk space, the server refuses): not retried. */
export class PermanentDownloadError extends Error {}

export interface DownloadOptions {
  /** Replaces the URL of the model's main file (tests). */
  url?: string;
  signal?: AbortSignal;
  /** Progress of the file being downloaded. */
  onProgress?: (doneBytes: number, totalBytes: number, file: string) => void;
  fetchImpl?: typeof fetch;
  /** Tries per file when the connection drops (default 6); each try resumes from the partial file. */
  maxAttempts?: number;
  /** Called before a retry, with the error and the wait in ms (default: a line on stderr). */
  onRetry?: (file: string, err: Error, attempt: number, waitMs: number) => void;
  /** Wait before try n+1 in ms (default 2 s doubling, at most 30 s); tests use 0. */
  backoffMs?: (attempt: number) => number;
}

export async function downloadModel(dir: string, e: CatalogEntry, opts: DownloadOptions = {}): Promise<'already-installed' | 'downloaded'> {
  let downloaded = false;
  for (const f of catalogFiles(e)) {
    const url = f.file === e.file ? opts.url ?? downloadUrl(e) : downloadUrl(e, f.file);
    if (await downloadWithRetry(dir, e.id, f, url, opts) === 'downloaded') downloaded = true;
  }
  return downloaded ? 'downloaded' : 'already-installed';
}

/** A dropped connection ("terminated", reset, 5xx) resumes from the partial file; permanent failures and cancellation stop at once. */
async function downloadWithRetry(dir: string, id: string, f: PinnedFile, url: string, opts: DownloadOptions): Promise<'already-installed' | 'downloaded'> {
  const max = opts.maxAttempts ?? 6;
  for (let attempt = 1; ; attempt++) {
    try { return await downloadFile(dir, id, f, url, opts); }
    catch (err) {
      if (err instanceof PermanentDownloadError || opts.signal?.aborted || attempt >= max) throw err;
      const wait = (opts.backoffMs ?? ((n) => Math.min(30_000, 2_000 * 2 ** (n - 1))))(attempt);
      (opts.onRetry ?? ((file, e, n, ms) => process.stderr.write(`\n${id}: ${file}: ${e.message}; retrying in ${Math.round(ms / 1000)} s (try ${n + 1} of ${max}), resuming where it stopped\n`)))(f.file, err as Error, attempt, wait);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function downloadFile(dir: string, id: string, f: PinnedFile, url: string, opts: DownloadOptions): Promise<'already-installed' | 'downloaded'> {
  if (await fileInstalled(dir, f)) return 'already-installed';
  await mkdir(dir, { recursive: true });
  const file = filePath(dir, f);
  const part = `${file}.part`;

  let have = 0;
  try { have = (await stat(part)).size; } catch { /* no partial download */ }
  if (have > f.sizeBytes) { await rm(part); have = 0; }

  const fs = await statfs(dir);
  const free = fs.bavail * fs.bsize;
  const need = f.sizeBytes - have;
  if (free < need + 1024 ** 3) {
    throw new PermanentDownloadError(`not enough disk space for ${id}: need ${gb(need)} GB + 1 GB margin, ${gb(free)} GB free in ${dir}`);
  }

  const hash = have > 0 ? await hashFile(part) : createHash('sha256');
  const res = await (opts.fetchImpl ?? fetch)(url, {
    headers: have > 0 ? { range: `bytes=${have}-` } : {},
    redirect: 'follow',
    signal: opts.signal,
  });
  if (res.status === 200 && have > 0) {
    // Server ignored the range: start over.
    return restart();
  }
  if (res.status !== 200 && res.status !== 206) {
    const msg = `download of ${id} (${f.file}) failed: HTTP ${res.status}`;
    throw res.status >= 500 || res.status === 429 ? new Error(msg) : new PermanentDownloadError(msg);
  }
  if (!res.body) throw new Error(`download of ${id} (${f.file}) failed: empty body`);
  await stream(res.body, hash, have);
  return finish(hash);

  async function restart(): Promise<'downloaded'> {
    await rm(part, { force: true });
    const fresh = createHash('sha256');
    const again = await (opts.fetchImpl ?? fetch)(url, { redirect: 'follow', signal: opts.signal });
    if (again.status !== 200 || !again.body) throw again.status >= 500 || again.status === 429 ? new Error(`download of ${id} (${f.file}) failed: HTTP ${again.status}`) : new PermanentDownloadError(`download of ${id} (${f.file}) failed: HTTP ${again.status}`);
    await stream(again.body, fresh, 0);
    return finish(fresh);
  }

  async function stream(body: ReadableStream<Uint8Array>, h: ReturnType<typeof createHash>, start: number): Promise<void> {
    let done = start;
    let lastReport = 0;
    await pipeline(
      Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>),
      async function* (src) {
        for await (const chunk of src) {
          const buf = chunk as Buffer;
          h.update(buf);
          done += buf.length;
          if (done > f.sizeBytes) throw new PermanentDownloadError(`download of ${id} (${f.file}) is larger than the pinned ${f.sizeBytes} bytes`);
          if (opts.onProgress && (done - lastReport > 64 * 1024 ** 2 || done === f.sizeBytes)) { lastReport = done; opts.onProgress(done, f.sizeBytes, f.file); }
          yield buf;
        }
      },
      createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }),
      { signal: opts.signal },
    );
  }

  async function finish(h: ReturnType<typeof createHash>): Promise<'downloaded'> {
    const size = (await stat(part)).size;
    const digest = h.digest('hex');
    if (size !== f.sizeBytes || digest !== f.sha256) {
      await rm(part, { force: true });
      throw new PermanentDownloadError(`download of ${id} (${f.file}) rejected: got ${size} bytes sha256 ${digest}, expected ${f.sizeBytes} bytes sha256 ${f.sha256}`);
    }
    await rename(part, file);
    await writeFile(markerOf(dir, f), f.sha256);
    return 'downloaded';
  }
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
