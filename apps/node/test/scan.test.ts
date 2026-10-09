import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '@gab-ai-node/protocol';
import { extractJson, fingerprint, parseReport, toFindings } from '../src/agent/findings.js';
import { ScanRunner } from '../src/agent/scan-runner.js';
import { parseGitleaks, parseNpmAudit, parseSemgrep, rankCandidates, SCAN_DIR, type Candidate, type Scanner } from '../src/agent/scanners.js';
import type { ChatMessage, ChatResponse, ModelBackend } from '../src/backends/types.js';
import { NodeConfig } from '../src/config.js';
import type { TaskContext } from '../src/runner.js';
import type { Sandbox } from '../src/sandbox.js';
import { z } from 'zod';

describe('scanner parsers', () => {
  it('npm audit: severities mapped, advisory titles used, an error answer is a failure', () => {
    const out = parseNpmAudit({ vulnerabilities: {
      lodash: { name: 'lodash', severity: 'moderate', range: '<4.17.21', via: [{ title: 'Prototype Pollution', url: 'x' }] },
      'dep-a': { name: 'dep-a', severity: 'high', via: ['lodash'] },
    } });
    expect(out).toEqual([
      { scanner: 'npm-audit', rule: 'npm:lodash', file: 'package-lock.json', line: null, message: 'lodash <4.17.21: Prototype Pollution', severity: 'medium' },
      { scanner: 'npm-audit', rule: 'npm:dep-a', file: 'package-lock.json', line: null, message: 'dep-a: vulnerable through lodash', severity: 'high' },
    ]);
    expect(() => parseNpmAudit({ error: { code: 'ENOAUDIT', summary: 'registry down' } })).toThrow(/registry down/);
    expect(parseNpmAudit({})).toEqual([]);
  });

  it('semgrep: rule, path without the /work prefix, line, severity', () => {
    const out = parseSemgrep({ results: [{ check_id: 'javascript.express.security.audit.xss', path: '/work/src/app.js', start: { line: 12, col: 1 }, extra: { message: 'XSS', severity: 'ERROR' } }] });
    expect(out).toEqual([{ scanner: 'semgrep', rule: 'javascript.express.security.audit.xss', file: 'src/app.js', line: 12, message: 'XSS', severity: 'high' }]);
    expect(() => parseSemgrep({ results: [{ nope: 1 }] })).toThrow();
  });

  it('gitleaks: the secret value never leaves the parser', () => {
    const out = parseGitleaks([{ RuleID: 'aws-access-token', Description: 'AWS key', File: '/work/.env', StartLine: 3, Secret: 'AKIAIOSFODNN7EXAMPLE', Match: 'KEY=AKIAIOSFODNN7EXAMPLE' }]);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('AKIA');
    expect(out[0]).toMatchObject({ scanner: 'gitleaks', rule: 'aws-access-token', file: '.env', line: 3, severity: 'high' });
    expect(out[0]!.message).toContain('20-character');
    expect(parseGitleaks(null)).toEqual([]);
  });

  it('rankCandidates: severity first, folders respected, capped', () => {
    const mk = (severity: Candidate['severity'], file: string): Candidate => ({ scanner: 'semgrep', rule: 'r', file, line: 1, message: 'm', severity });
    const all = [mk('low', 'a/x.js'), mk('critical', 'b/y.js'), mk('high', 'a/z.js')];
    expect(rankCandidates(all, []).kept.map((c) => c.severity)).toEqual(['critical', 'high', 'low']);
    expect(rankCandidates(all, ['a']).kept.map((c) => c.file)).toEqual(['a/z.js', 'a/x.js']);
    expect(rankCandidates(all, ['a']).dropped).toBe(1);
  });
});

describe('findings helpers', () => {
  it('extractJson reads bare and fenced JSON; fingerprints ignore numbers and punctuation', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('text {"a":2} text')).toEqual({ a: 2 });
    expect(fingerprint('r/x', 'f.js', 'Bug #12: bad')).toBe(fingerprint('r/x', 'f.js', 'bug 99 bad'));
  });

  it('toFindings drops problems without evidence and logs them', () => {
    const logs: unknown[] = [];
    const out = toFindings('r/x', [
      { title: 'real', severity: 'HIGH', file: 'a.js', line: 2.7, evidence: 'steps' },
      { title: 'no proof', severity: 'low', evidence: '' },
    ], (_t, d) => logs.push(d));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'high', line: 2 });
    expect(logs).toHaveLength(1);
  });

  it('parseReport repairs once, then gives up with null', async () => {
    const schema = z.object({ ok: z.boolean() });
    const backend = (content: string): ModelBackend => ({ model: 'f', chat: async () => ({ message: { role: 'assistant', content }, tokens: 3, finishReason: 'stop' }) });
    const signal = new AbortController().signal;
    expect(await parseReport(schema, 'not json', '{}', backend('{"ok":true}'), signal)).toEqual({ report: { ok: true }, tokens: 3 });
    expect(await parseReport(schema, 'not json', '{}', backend('still not'), signal)).toEqual({ report: null, tokens: 3 });
    expect(await parseReport(schema, '{"ok":false}', '{}', backend('x'), signal)).toEqual({ report: { ok: false }, tokens: 0 });
  });
});

describe('ScanRunner', () => {
  const scripted = (responses: Partial<ChatMessage>[]): ModelBackend & { seen: ChatMessage[][] } => {
    const seen: ChatMessage[][] = []; let i = 0;
    return { model: 'fake', seen, async chat(messages): Promise<ChatResponse> {
      seen.push([...messages]);
      return { message: { role: 'assistant', content: null, ...responses[Math.min(i++, responses.length - 1)]! }, tokens: 5, finishReason: 'stop' };
    } };
  };
  let workdir: string;
  const context = async (over: Partial<TaskSpec> = {}): Promise<TaskContext> => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'gab-scan-'));
    await mkdir(path.join(workdir, 'src'), { recursive: true });
    await writeFile(path.join(workdir, 'src', 'app.js'), 'app.get("/x", (req, res) => res.send(req.query.q));\n');
    await writeFile(path.join(workdir, '.env'), 'KEY=AKIAIOSFODNN7EXAMPLE\n');
    const task: TaskSpec = {
      id: randomUUID(), kind: 'scan', repo: 'zicgab/demo', extraRepos: [], ref: null, instructions: '', backend: 'local', model: 'fake',
      budget: { maxSteps: 20, maxMinutes: 10, maxTokens: 1e6 }, branch: null, findingId: null, attempt: 1, role: null, paths: [], chat: null, ...over,
    };
    return {
      task, config: NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' }), workdir, extraDirs: {}, signal: new AbortController().signal,
      emit: () => {}, secrets: { github: null, anthropic: null }, modelEndpoint: async () => 'http://unused', commitAndPush: async () => { throw new Error('scan never pushes'); },
    };
  };
  /** A scanner whose "container" writes the given JSON the way the real one writes its file. */
  const fakeScanner = (name: Candidate['scanner'], output: unknown, parse: Scanner['parse']): Scanner => ({
    name, image: () => 'fake', applies: async () => true, command: `run ${name}`, outputFile: `${name}.json`, parse,
  });
  const sandboxWriting = (files: Record<string, unknown>): ((ctx: TaskContext, image: string, name: string) => Promise<Sandbox>) =>
    async (ctx, _image, name) => ({
      async run() {
        if (name in files) {
          await mkdir(path.join(ctx.workdir, SCAN_DIR), { recursive: true });
          await writeFile(path.join(ctx.workdir, SCAN_DIR, `${name}.json`), JSON.stringify(files[name]));
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      async close() {},
    });

  const semgrepOut = { results: [{ check_id: 'xss', path: '/work/src/app.js', start: { line: 1 }, extra: { message: 'reflected', severity: 'ERROR' } }] };
  const gitleaksOut = [{ RuleID: 'aws-access-token', Description: 'AWS', File: '/work/.env', StartLine: 1, Secret: 'AKIAIOSFODNN7EXAMPLE' }];

  it('hands scanner candidates to the model and turns confirmed ones into findings with the scanner\'s file and line', async () => {
    const scanners = [fakeScanner('semgrep', semgrepOut, parseSemgrep), fakeScanner('gitleaks', gitleaksOut, parseGitleaks)];
    const backend = scripted([{ content: JSON.stringify({
      summary: 'one real xss, one real key',
      confirmed: [
        { id: 0, title: 'Secret AKIAIOSFODNN7EXAMPLE leaked', severity: 'high', evidence: 'KEY=AKIAIOSFODNN7EXAMPLE in .env', suggestedFix: 'x' },
        { id: 1, title: 'Reflected XSS in /x', severity: 'high', evidence: 'src/app.js:1 req.query.q goes to res.send unescaped', suggestedFix: 'escape it' },
        { id: 9, title: 'invented', severity: 'low', evidence: 'x' },
      ],
      rejected: [],
    }) }]);
    const res = await new ScanRunner(sandboxWriting({ semgrep: semgrepOut, gitleaks: gitleaksOut }), () => backend, scanners).run(await context());
    expect(backend.seen[0]![1]!.content).toContain('#0 [high] gitleaks aws-access-token .env:1');
    expect(backend.seen[0]![1]!.content).not.toContain('AKIA');
    expect(res.findings).toHaveLength(2);
    const xss = res.findings.find((f) => f.title.includes('XSS'))!;
    expect(xss).toMatchObject({ file: 'src/app.js', line: 1 });
    const secret = res.findings.find((f) => f.title.startsWith('Secret in repository'))!;
    expect(JSON.stringify(secret)).not.toContain('AKIA'); // the model quoted it; the finding does not
    expect(secret).toMatchObject({ file: '.env', line: 1 });
    expect(res).toMatchObject({ branch: null, commits: [] });
    expect(res.summary).toContain('2 confirmed of 2 candidate(s)');
    // The scanners' raw files (gitleaks keeps the secret values) are gone before the model's file tools could read them.
    expect(await readdir(path.join(workdir, SCAN_DIR))).toEqual([]);
  });

  it('no candidates: the model is not called', async () => {
    const backend = scripted([]);
    const res = await new ScanRunner(sandboxWriting({ semgrep: { results: [] } }), () => backend, [fakeScanner('semgrep', {}, parseSemgrep)]).run(await context());
    expect(res.findings).toEqual([]);
    expect(res.summary).toContain('no candidates');
    expect(backend.seen).toEqual([]);
  });

  it('one scanner failing is reported, the others still count; all failing is retryable', async () => {
    const scanners = [fakeScanner('semgrep', semgrepOut, parseSemgrep), fakeScanner('gitleaks', gitleaksOut, parseGitleaks)];
    const backend = scripted([{ content: '{"summary":"none real","confirmed":[],"rejected":[{"id":0}]}' }]);
    const res = await new ScanRunner(sandboxWriting({ semgrep: semgrepOut }), () => backend, scanners).run(await context());
    expect(res.summary).toContain('gitleaks: FAILED');
    expect(res.summary).toContain('0 confirmed of 1');
    await expect(new ScanRunner(sandboxWriting({}), () => backend, scanners).run(await context())).rejects.toThrow(/no scanner produced a result/);
  });

  it('candidates outside the task folders are not shown to the model', async () => {
    const backend = scripted([{ content: '{"summary":"s","confirmed":[],"rejected":[]}' }]);
    await new ScanRunner(sandboxWriting({ semgrep: semgrepOut, gitleaks: gitleaksOut }), () => backend, [fakeScanner('semgrep', semgrepOut, parseSemgrep), fakeScanner('gitleaks', gitleaksOut, parseGitleaks)])
      .run(await context({ paths: ['src'] }));
    const shown = backend.seen[0]![1]!.content!;
    expect(shown).toContain('src/app.js');
    expect(shown).not.toContain('.env');
  });
});
