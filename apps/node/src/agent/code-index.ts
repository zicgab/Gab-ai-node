// Per-repo symbol index: where functions, classes, types, routes and constants
// are defined. Built once per commit and cached, so `ask` doesn't rescan the
// repo each time. (Embeddings can be added on top later without changing callers.)
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';

export interface SymbolHit { name: string; kind: string; file: string; line: number }

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', '.venv', '__pycache__', 'vendor', 'Pods', 'coverage']);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 512 * 1024;

type Rule = { kind: string; re: RegExp };
const JS: Rule[] = [
  { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/ },
  { kind: 'const', re: /^\s*export\s+const\s+([A-Z_][A-Z0-9_]*)\s*=/ },
  { kind: 'route', re: /\b(?:app|router|r)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)/ },
];
const RULES: Record<string, Rule[]> = {
  '.ts': JS, '.tsx': JS, '.js': JS, '.jsx': JS, '.mjs': JS, '.cjs': JS,
  '.py': [
    { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
  ],
  '.rs': [
    { kind: 'function', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/ },
  ],
  '.go': [
    { kind: 'function', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^type\s+([A-Za-z_]\w*)/ },
  ],
  '.sh': [{ kind: 'function', re: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/ }],
  '.ps1': [{ kind: 'function', re: /^\s*function\s+([A-Za-z_][\w-]*)/i }],
  '.sql': [{ kind: 'table', re: /^\s*CREATE\s+(?:TABLE|VIEW|FUNCTION|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)/i }],
  '.swift': [{ kind: 'type', re: /^\s*(?:public\s+|private\s+)?(?:final\s+)?(?:class|struct|enum|protocol)\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^\s*(?:public\s+|private\s+)?func\s+([A-Za-z_]\w*)/ }],
  '.kt': [{ kind: 'type', re: /^\s*(?:data\s+)?(?:class|interface|object)\s+([A-Za-z_]\w*)/ }, { kind: 'function', re: /^\s*fun\s+([A-Za-z_]\w*)/ }],
};

/** Words of an identifier: getUserById -> get user by id. */
function words(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export class CodeIndex {
  constructor(readonly symbols: SymbolHit[]) {}

  static async build(root: string): Promise<CodeIndex> {
    const symbols: SymbolHit[] = [];
    let files = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (files >= MAX_FILES || e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full); continue; }
        const rules = RULES[path.extname(e.name).toLowerCase()];
        if (!rules) continue;
        files++;
        if ((await stat(full)).size > MAX_FILE_BYTES) continue;
        const rel = path.relative(root, full).split(path.sep).join('/');
        (await readFile(full, 'utf8')).split('\n').forEach((line, i) => {
          for (const r of rules) {
            const m = r.re.exec(line);
            if (!m) continue;
            const name = r.kind === 'route' ? `${m[1]!.toUpperCase()} ${m[2]}` : m[1]!;
            symbols.push({ name, kind: r.kind, file: rel, line: i + 1 });
            break;
          }
        });
      }
    };
    await walk(root);
    return new CodeIndex(symbols);
  }

  /** Cached per commit under cacheDir; rebuilt when missing or unreadable. */
  static async forCommit(root: string, cacheDir: string, key: string): Promise<CodeIndex> {
    const file = path.join(cacheDir, `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
    try { return new CodeIndex(JSON.parse(await readFile(file, 'utf8')) as SymbolHit[]); }
    catch { /* not cached yet */ }
    const started = Date.now();
    const index = await CodeIndex.build(root);
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(`${file}.new`, JSON.stringify(index.symbols));
      await rename(`${file}.new`, file);
    } catch (err) { log.warn('could not cache the code index', { err }); }
    log.info('code index built', { key, symbols: index.symbols.length, ms: Date.now() - started });
    return index;
  }

  /** Exact name first, then names containing the query, then by shared words. */
  search(query: string, limit = 30): SymbolHit[] {
    const q = query.trim();
    const ql = q.toLowerCase();
    const qw = new Set(words(q));
    const scored: { h: SymbolHit; s: number }[] = [];
    for (const h of this.symbols) {
      const nl = h.name.toLowerCase();
      let s = 0;
      if (nl === ql) s = 100;
      else if (nl.includes(ql)) s = 50;
      else {
        const shared = words(h.name).filter((w) => qw.has(w)).length;
        if (shared) s = 10 * shared;
      }
      if (s) scored.push({ h, s });
    }
    return scored.sort((a, b) => b.s - a.s || a.h.file.localeCompare(b.h.file)).slice(0, limit).map((x) => x.h);
  }
}
