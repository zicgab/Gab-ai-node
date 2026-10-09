// Downloads a catalog model: resumable (.part + HTTP Range), hashed while
// streaming, size and SHA-256 checked before the file is renamed into place.
// A verified file gets a marker so later starts don't rehash 60 GB.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CatalogEntry } from './catalog.js';
import { downloadUrl } from './catalog.js';

export const modelPath = (dir: string, e: CatalogEntry) => path.join(dir, e.file);
const markerPath = (dir: string, e: CatalogEntry) => `${modelPath(dir, e)}.verified`;

/** True when the file is there with the right size and was verified against the pinned hash. */
export async function isInstalled(dir: string, e: CatalogEntry): Promise<boolean> {
  try {
    const [s, marker] = await Promise.all([stat(modelPath(dir, e)), readFile(markerPath(dir, e), 'utf8')]);
    return s.size === e.sizeBytes && marker.trim() === e.sha256;
  } catch { return false; }
}

async function hashFile(file: string, hash = createHash('sha256')): Promise<ReturnType<typeof createHash>> {
  await pipeline(createReadStream(file), async function* (src) { for await (const chunk of src) hash.update(chunk as Buffer); });
  return hash;
}

/** Rehashes the installed file; removes it and its marker on mismatch. */
export async function verifyModel(dir: string, e: CatalogEntry): Promise<boolean> {
  const file = modelPath(dir, e);
  const ok = (await stat(file)).size === e.sizeBytes && (await hashFile(file)).digest('hex') === e.sha256;
  if (ok) await writeFile(markerPath(dir, e), e.sha256);
  else await Promise.all([rm(file, { force: true }), rm(markerPath(dir, e), { force: true })]);
  return ok;
}

export interface DownloadOptions {
  url?: string;
  signal?: AbortSignal;
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  fetchImpl?: typeof fetch;
}

export async function downloadModel(dir: string, e: CatalogEntry, opts: DownloadOptions = {}): Promise<'already-installed' | 'downloaded'> {
  if (await isInstalled(dir, e)) return 'already-installed';
  await mkdir(dir, { recursive: true });
  const file = modelPath(dir, e);
  const part = `${file}.part`;

  let have = 0;
  try { have = (await stat(part)).size; } catch { /* no partial download */ }
  if (have > e.sizeBytes) { await rm(part); have = 0; }

  const fs = await statfs(dir);
  const free = fs.bavail * fs.bsize;
  const need = e.sizeBytes - have;
  if (free < need + 1024 ** 3) {
    throw new Error(`not enough disk space for ${e.id}: need ${gb(need)} GB + 1 GB margin, ${gb(free)} GB free in ${dir}`);
  }

  const hash = have > 0 ? await hashFile(part) : createHash('sha256');
  const res = await (opts.fetchImpl ?? fetch)(opts.url ?? downloadUrl(e), {
    headers: have > 0 ? { range: `bytes=${have}-` } : {},
    redirect: 'follow',
    signal: opts.signal,
  });
  if (res.status === 200 && have > 0) {
    // Server ignored the range: start over.
    return restart();
  }
  if (res.status !== 200 && res.status !== 206) throw new Error(`download of ${e.id} failed: HTTP ${res.status}`);
  if (!res.body) throw new Error(`download of ${e.id} failed: empty body`);
  await stream(res.body, hash, have);
  return finish(hash);

  async function restart(): Promise<'downloaded'> {
    await rm(part, { force: true });
    const fresh = createHash('sha256');
    const again = await (opts.fetchImpl ?? fetch)(opts.url ?? downloadUrl(e), { redirect: 'follow', signal: opts.signal });
    if (again.status !== 200 || !again.body) throw new Error(`download of ${e.id} failed: HTTP ${again.status}`);
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
          if (done > e.sizeBytes) throw new Error(`download of ${e.id} is larger than the pinned ${e.sizeBytes} bytes`);
          if (opts.onProgress && (done - lastReport > 64 * 1024 ** 2 || done === e.sizeBytes)) { lastReport = done; opts.onProgress(done, e.sizeBytes); }
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
    if (size !== e.sizeBytes || digest !== e.sha256) {
      await rm(part, { force: true });
      throw new Error(`download of ${e.id} rejected: got ${size} bytes sha256 ${digest}, expected ${e.sizeBytes} bytes sha256 ${e.sha256}`);
    }
    await rename(part, file);
    await writeFile(markerPath(dir, e), e.sha256);
    return 'downloaded';
  }
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
