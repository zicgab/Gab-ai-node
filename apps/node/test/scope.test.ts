import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CodeIndex } from '../src/agent/code-index.js';
import { checkScope, ROLE_BRIEFS, withRole } from '../src/agent/roles.js';
import { createTools, createWorkTools, resolveForWrite, resolveInside } from '../src/agent/tools.js';

let root: string;
const SCOPE = ['src/app'];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'gab-scope-'));
  await mkdir(path.join(root, 'src', 'app'), { recursive: true });
  await mkdir(path.join(root, 'src', 'other'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app', 'page.ts'), 'export function renderPage() { return NEEDLE; }\n');
  await writeFile(path.join(root, 'src', 'other', 'secret.ts'), 'export function hiddenThing() { return NEEDLE; }\n');
  await writeFile(path.join(root, 'top.ts'), 'export const NEEDLE = 1;\n');
});

const scoped = () => ({ main: root, extra: {}, scope: SCOPE });
const tool = (tools: ReturnType<typeof createTools>, name: string) => tools.find((t) => t.name === name)!;

describe('folder scope', () => {
  it('reads inside the folders, refuses everything else', async () => {
    expect((await resolveInside(scoped(), 'src/app/page.ts')).rel).toBe('src/app/page.ts');
    expect((await resolveInside(scoped(), 'src/app')).rel).toBe('src/app');
    for (const p of ['src/other/secret.ts', 'top.ts', 'src', '.']) {
      await expect(resolveInside(scoped(), p)).rejects.toThrow(/outside the folders of this task/);
    }
  });

  it('a folder named like a prefix is not inside it (src/app-old is not src/app)', async () => {
    await mkdir(path.join(root, 'src', 'app-old'), { recursive: true });
    await expect(resolveInside(scoped(), 'src/app-old')).rejects.toThrow(/outside the folders/);
  });

  it('without a scope the whole repo is readable', async () => {
    expect((await resolveInside({ main: root, extra: {} }, 'top.ts')).rel).toBe('top.ts');
    expect((await resolveInside({ main: root, extra: {}, scope: [] }, 'top.ts')).rel).toBe('top.ts');
  });

  it('list_dir at the root shows the task folders; grep without a path searches only them', async () => {
    const tools = createTools(scoped(), null);
    expect(await tool(tools, 'list_dir').run({ path: '' })).toContain('src/app/');
    const found = await tool(tools, 'grep').run({ pattern: 'NEEDLE' });
    expect(found).toContain('src/app/page.ts');
    expect(found).not.toContain('secret.ts');
    expect(found).not.toContain('top.ts');
    await expect(tool(tools, 'grep').run({ pattern: 'NEEDLE', path: 'src/other' })).rejects.toThrow(/outside the folders/);
  });

  it('search_code only returns symbols of the folders', async () => {
    const index = await CodeIndex.forCommit(root, path.join(root, '.idx'), 'scope-test');
    const tools = createTools(scoped(), index);
    const all = await tool(createTools({ main: root, extra: {} }, index), 'search_code').run({ query: 'Thing' });
    expect(all).toContain('hiddenThing');
    const inScope = await tool(tools, 'search_code').run({ query: 'Thing' });
    expect(inScope).not.toContain('hiddenThing');
  });

  it('writes are limited to the folders too', async () => {
    expect((await resolveForWrite(scoped(), 'src/app/new.ts')).rel).toBe('src/app/new.ts');
    await expect(resolveForWrite(scoped(), 'src/other/x.ts')).rejects.toThrow(/outside the folders/);
    await expect(resolveForWrite(scoped(), 'top.ts')).rejects.toThrow(/outside the folders/);
    const noSandbox = { run: async () => { throw new Error('no'); } };
    const write = createWorkTools(scoped(), noSandbox as never, { cmdTimeoutMs: 1000 }).find((t) => t.name === 'write_file')!;
    await expect(write.run({ path: 'src/other/y.ts', content: 'x' })).rejects.toThrow(/outside the folders/);
  });
});

describe('roles', () => {
  it('adds the role checklist and the folders to the system prompt', () => {
    const text = withRole('BASE', 'security', ['src/app', 'lib']);
    expect(text.startsWith('BASE')).toBe(true);
    expect(text).toContain(ROLE_BRIEFS.security);
    expect(text).toContain('src/app, lib');
    expect(withRole('BASE', null, [])).toBe('BASE');
  });

  it('every role has a checklist', () => {
    for (const role of ['frontend', 'backend', 'security', 'uxui'] as const) expect(ROLE_BRIEFS[role].length).toBeGreaterThan(100);
  });

  it('checkScope fails on a folder that is not in the repo', async () => {
    await expect(checkScope(root, ['src/app'])).resolves.toBeUndefined();
    await expect(checkScope(root, ['src/app', 'src/typo'])).rejects.toThrow(/src\/typo.*does not exist/);
    await expect(checkScope(root, ['top.ts'])).rejects.toThrow(/does not exist/);
  });
});
