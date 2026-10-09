// Tools the agent may call. Repo content is untrusted input: every path is
// resolved and checked to stay inside the task's checkouts (symlinks out are
// refused), outputs are capped. Write tools only touch the primary repo.
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exec, has } from '../exec.js';
import type { Sandbox } from '../sandbox.js';
import type { CodeIndex } from './code-index.js';

const MAX_OUTPUT = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', '.venv', '__pycache__', 'vendor', 'Pods']);

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Text for the model; a tool may also return a screenshot (data: URL) for a vision model. */
  run(args: Record<string, unknown>): Promise<string | { text: string; image: string }>;
}

/** Roots the agent can see: "" is the primary repo, "@owner/name" an extra repo. */
export interface Roots {
  main: string;
  extra: Record<string, string>;
  /** Folders of the primary repo the task is limited to (read and write); empty or missing = the whole repo. */
  scope?: string[];
}

const toSlash = (rel: string) => rel.split(path.sep).join('/');
const scoped = (roots: Roots): string[] | null => (roots.scope?.length ? roots.scope : null);

/** True when rel (a path inside the primary repo) lies in one of the task's folders. */
export function inScope(scope: string[], rel: string): boolean {
  const r = toSlash(rel);
  return scope.some((s) => r === s || r.startsWith(`${s}/`));
}

function outsideScope(p: unknown, scope: string[]): Error {
  return new Error(`${String(p)} is outside the folders of this task (${scope.join(', ')})`);
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… [truncated ${text.length - MAX_OUTPUT} chars]` : text;
}

/**
 * Maps an agent path ("src/a.ts" or "@owner/name/src/a.ts") to a real path
 * inside its root, or throws. Refuses absolute paths, "..", and symlinks that
 * lead outside the root.
 */
export async function resolveInside(roots: Roots, p: unknown): Promise<{ abs: string; root: string; rel: string }> {
  if (typeof p !== 'string') throw new Error('path must be a string');
  let root = roots.main;
  let rel = p.trim() === '' || p.trim() === '.' ? '.' : p.trim();
  if (rel.startsWith('@')) {
    const m = /^@([^/]+\/[^/]+)(?:\/(.*))?$/.exec(rel);
    const extra = m ? roots.extra[m[1]!] : undefined;
    if (!m || !extra) throw new Error(`unknown repo in ${p}; available: ${Object.keys(roots.extra).map((r) => '@' + r).join(', ') || 'none'}`);
    root = extra;
    rel = m[2] || '.';
  }
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error('use paths relative to the repo root');
  const realRoot = await realpath(root);
  const abs = path.resolve(realRoot, rel);
  const inside = (x: string) => x === realRoot || x.startsWith(realRoot + path.sep);
  if (!inside(abs)) throw new Error(`${p} is outside the repo`);
  let real: string;
  try { real = await realpath(abs); } catch { throw new Error(`${p} does not exist`); }
  if (!inside(real)) throw new Error(`${p} links outside the repo`);
  const relReal = path.relative(realRoot, real) || '.';
  const scope = scoped(roots);
  if (scope && root === roots.main && !inScope(scope, relReal)) throw outsideScope(p, scope);
  return { abs: real, root: realRoot, rel: relReal };
}

async function grepJs(dir: string, re: RegExp, root: string, out: string[], limit: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await grepJs(full, re, root, out, limit); continue; }
    if ((await stat(full)).size > MAX_FILE_BYTES) continue;
    const text = await readFile(full, 'utf8').catch(() => '');
    if (text.includes('\u0000')) continue; // binary
    text.split('\n').forEach((line, i) => { if (out.length < limit && re.test(line)) out.push(`${path.relative(root, full)}:${i + 1}:${line.slice(0, 300)}`); });
  }
}

export function createTools(roots: Roots, index: CodeIndex | null): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'read_file',
      description: 'Read a text file of the repo (with line numbers). Optional 1-based start/end lines. Extra repos: "@owner/name/path".',
      parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['path'] },
      async run(args) {
        const { abs, rel } = await resolveInside(roots, args.path);
        const s = await stat(abs);
        if (s.isDirectory()) throw new Error(`${rel} is a directory; use list_dir`);
        if (s.size > MAX_FILE_BYTES) throw new Error(`${rel} is too large (${s.size} bytes); use grep`);
        const lines = (await readFile(abs, 'utf8')).split('\n');
        const start = Math.max(1, Number(args.start) || 1);
        const end = Math.min(lines.length, Number(args.end) || start + 399);
        const body = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n');
        return cap(`${rel} (lines ${start}-${end} of ${lines.length})\n${body}`);
      },
    },
    {
      name: 'list_dir',
      description: 'List a directory of the repo ("" for the root). Dependency/build folders are hidden.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async run(args) {
        const scope = scoped(roots);
        const asked = typeof args.path === 'string' ? args.path.trim() : '';
        if (scope && (asked === '' || asked === '.')) return `This task is limited to these folders:\n${scope.map((f) => `${f}/`).join('\n')}`;
        const { abs, rel } = await resolveInside(roots, args.path ?? '');
        const entries = await readdir(abs, { withFileTypes: true });
        const lines = entries
          .filter((e) => !SKIP_DIRS.has(e.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return cap(`${rel}/\n${lines.join('\n')}`);
      },
    },
    {
      name: 'grep',
      description: 'Search file contents with a regular expression. Optional path (folder) and glob (e.g. "*.ts"). Returns file:line:text.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] },
      async run(args) {
        const pattern = String(args.pattern ?? '');
        if (!pattern || pattern.length > 500) throw new Error('pattern must be 1-500 characters');
        const scope = scoped(roots);
        const asked = typeof args.path === 'string' ? args.path.trim() : '';
        // Without a path, a scoped task searches its own folders only.
        const targets = scope && (asked === '' || asked === '.')
          ? await Promise.all(scope.map((f) => resolveInside(roots, f)))
          : [await resolveInside(roots, args.path ?? '')];
        const root = targets[0]!.root;
        const glob = typeof args.glob === 'string' && /^[A-Za-z0-9*?._{},\/-]{1,100}$/.test(args.glob) ? args.glob : null;
        if (await has('rg')) {
          const rgArgs = ['--line-number', '--no-heading', '--color=never', '--max-count=50', '--max-columns=300', '-e', pattern];
          if (glob) rgArgs.push('--glob', glob);
          rgArgs.push('--', ...targets.map((t) => t.abs));
          const r = await exec('rg', rgArgs, { timeoutMs: 30_000 });
          if (r.code > 1) throw new Error(`grep failed: ${r.stderr.trim().slice(0, 300)}`);
          const lines = r.stdout.split('\n').filter(Boolean).slice(0, 200).map((l) => (l.startsWith(root) ? l.slice(root.length + 1) : l));
          return cap(lines.join('\n') || 'no matches');
        }
        let re: RegExp;
        try { re = new RegExp(pattern); } catch (err) { throw new Error(`bad pattern: ${(err as Error).message}`); }
        const out: string[] = [];
        for (const t of targets) {
          if ((await lstat(t.abs)).isDirectory()) await grepJs(t.abs, re, root, out, 200);
        }
        return cap(out.join('\n') || 'no matches');
      },
    },
  ];
  if (index) {
    tools.push({
      name: 'search_code',
      description: 'Find where functions, classes, types, routes or constants are defined, by name or words. Faster than grep for "where is X defined".',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async run(args) {
        const q = String(args.query ?? '').trim();
        if (!q) throw new Error('query is required');
        const scope = scoped(roots);
        const hits = scope ? index.search(q, 500).filter((h) => inScope(scope, h.file)).slice(0, 30) : index.search(q, 30);
        return hits.length ? hits.map((h) => `${h.file}:${h.line}  ${h.kind} ${h.name}`).join('\n') : 'no matches (try grep)';
      },
    });
  }
  return tools;
}

/** Path for writing in the primary repo: parent must exist inside it (or is created inside it); never .git. */
export async function resolveForWrite(roots: Roots, p: unknown): Promise<{ abs: string; rel: string }> {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path must be a non-empty string');
  const rel = p.trim();
  if (rel.startsWith('@')) throw new Error('extra repos are read-only');
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error('use paths relative to the repo root');
  const realRoot = await realpath(roots.main);
  const abs = path.resolve(realRoot, rel);
  const inside = (x: string) => x.startsWith(realRoot + path.sep);
  if (!inside(abs)) throw new Error(`${p} is outside the repo`);
  const relPath = path.relative(realRoot, abs);
  if (relPath.split(path.sep).some((part) => part === '.git')) throw new Error('.git is off limits');
  const scope = scoped(roots);
  if (scope && !inScope(scope, relPath)) throw outsideScope(p, scope);
  // Walk up to the deepest existing ancestor and check it resolves inside the root (no symlink escape).
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== realRoot && !inside(real)) throw new Error(`${p} links outside the repo`);
      if (probe === abs && (await lstat(abs)).isSymbolicLink()) throw new Error(`${p} is a symlink`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      probe = path.dirname(probe);
    }
  }
  return { abs, rel: relPath };
}

/** Tools that change the primary repo and run commands in the sandbox. */
export function createWorkTools(roots: Roots, sandbox: Sandbox, opts: { cmdTimeoutMs: number }): ToolDef[] {
  return [
    {
      name: 'write_file',
      description: 'Create or overwrite a file in the repo with the full content given.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      async run(args) {
        if (typeof args.content !== 'string') throw new Error('content must be a string');
        if (args.content.length > MAX_FILE_BYTES) throw new Error('content too large');
        const { abs, rel } = await resolveForWrite(roots, args.path);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, args.content);
        return `wrote ${rel} (${args.content.length} chars)`;
      },
    },
    {
      name: 'replace_in_file',
      description: 'Replace one exact occurrence of old_text with new_text in a repo file. old_text must appear exactly once.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
      async run(args) {
        const { abs, rel } = await resolveForWrite(roots, args.path);
        if (typeof args.old_text !== 'string' || !args.old_text || typeof args.new_text !== 'string') throw new Error('old_text (non-empty) and new_text must be strings');
        let text: string;
        try { text = await readFile(abs, 'utf8'); } catch { throw new Error(`${rel} does not exist`); }
        const count = text.split(args.old_text).length - 1;
        if (count !== 1) throw new Error(`old_text found ${count} times in ${rel}; it must be exactly once (add surrounding lines)`);
        await writeFile(abs, text.replace(args.old_text, () => args.new_text as string));
        return `edited ${rel}`;
      },
    },
    {
      name: 'run_cmd',
      description: 'Run a shell command in the repo root inside an isolated container WITHOUT network (dependencies were installed by the setup step). Use it to run tests, linters, builds, or scripts that reproduce a bug. Returns exit code and output.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer' } }, required: ['command'] },
      async run(args) {
        const command = String(args.command ?? '').trim();
        if (!command || command.length > 4_000) throw new Error('command must be 1-4000 characters');
        const timeoutMs = Math.min(opts.cmdTimeoutMs, Math.max(5, Number(args.timeout_seconds) || 300) * 1000);
        const r = await sandbox.run(command, { timeoutMs });
        const tail = (t: string) => (t.length > 8_000 ? `… ${t.slice(-8_000)}` : t);
        return cap(`exit ${r.code}\n--- stdout ---\n${tail(r.stdout)}\n--- stderr ---\n${tail(r.stderr)}`);
      },
    },
  ];
}
