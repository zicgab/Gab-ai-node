// Deterministic scanners for the scan task: they find candidates reliably, the model
// only judges them. Each scanner runs in its own throwaway container with network (rule
// and advisory databases), writes JSON into <worktree>/.gab-ai-scan/, and a pure parser
// turns that JSON into candidates.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export interface Candidate {
  scanner: 'npm-audit' | 'semgrep' | 'gitleaks';
  rule: string;
  file: string | null;
  line: number | null;
  message: string;
  severity: Severity;
}

export const SCAN_DIR = '.gab-ai-scan';
const OUT = `/work/${SCAN_DIR}`;
/** Most candidates one task hands the model (highest severity first). */
export const MAX_CANDIDATES = 200;

export interface Scanner {
  name: Candidate['scanner'];
  /** Image to run in: the repo's own (npm needs its node and lockfile) or the scanner's official one. */
  image(images: { repo: string; semgrep: string; gitleaks: string }): string;
  /** False when the repo has nothing for this scanner (e.g. npm audit without a lockfile). */
  applies(workdir: string): Promise<boolean>;
  command: string;
  outputFile: string;
  parse(json: unknown): Candidate[];
}

const exists = (file: string) => stat(file).then(() => true, () => false);

const NpmAudit = z.object({
  error: z.object({ summary: z.string().optional(), code: z.string().optional() }).passthrough().optional(),
  vulnerabilities: z.record(z.object({
    name: z.string(), severity: z.string(), range: z.string().optional(),
    via: z.array(z.union([z.string(), z.object({ title: z.string().optional(), url: z.string().optional() }).passthrough()])).default([]),
  }).passthrough()).default({}),
}).passthrough();

const SEVERITY_NPM: Record<string, Severity> = { critical: 'critical', high: 'high', moderate: 'medium', low: 'low', info: 'low' };

export function parseNpmAudit(json: unknown): Candidate[] {
  const audit = NpmAudit.parse(json);
  if (audit.error) throw new Error(`npm audit failed: ${audit.error.summary ?? audit.error.code ?? 'unknown error'}`);
  return Object.values(audit.vulnerabilities).map((v) => {
    const advisories = v.via.filter((x): x is { title?: string; url?: string } => typeof x !== 'string');
    const title = advisories.map((a) => a.title).filter(Boolean).slice(0, 3).join('; ') || `vulnerable through ${v.via.filter((x) => typeof x === 'string').join(', ') || 'a dependency'}`;
    return {
      scanner: 'npm-audit', rule: `npm:${v.name}`, file: 'package-lock.json', line: null,
      message: `${v.name}${v.range ? ` ${v.range}` : ''}: ${title}`, severity: SEVERITY_NPM[v.severity] ?? 'medium',
    } satisfies Candidate;
  });
}

const Semgrep = z.object({
  results: z.array(z.object({
    check_id: z.string(), path: z.string(), start: z.object({ line: z.number() }).passthrough(),
    extra: z.object({ message: z.string().default(''), severity: z.string().default('WARNING') }).passthrough(),
  }).passthrough()).default([]),
}).passthrough();

const SEVERITY_SEMGREP: Record<string, Severity> = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };

export function parseSemgrep(json: unknown): Candidate[] {
  return Semgrep.parse(json).results.map((r) => ({
    scanner: 'semgrep', rule: r.check_id, file: r.path.replace(/^\/work\//, ''), line: r.start.line,
    message: r.extra.message.slice(0, 400), severity: SEVERITY_SEMGREP[r.extra.severity.toUpperCase()] ?? 'medium',
  } satisfies Candidate));
}

const Gitleaks = z.array(z.object({
  RuleID: z.string(), Description: z.string().default(''), File: z.string(), StartLine: z.number().default(0), Secret: z.string().default(''),
}).passthrough());

/** The matched secret is never copied out of the scanner's file: only its rule, place and length. */
export function parseGitleaks(json: unknown): Candidate[] {
  return Gitleaks.parse(json ?? []).map((r) => ({
    scanner: 'gitleaks', rule: r.RuleID, file: r.File.replace(/^\/work\//, ''), line: r.StartLine > 0 ? r.StartLine : null,
    message: `${r.Description || r.RuleID} (a ${r.Secret.length}-character value; the value is not shown)`, severity: 'high',
  } satisfies Candidate));
}

export const SCANNERS: Scanner[] = [
  {
    name: 'npm-audit',
    image: (i) => i.repo,
    applies: (dir) => exists(path.join(dir, 'package-lock.json')),
    // Exit code is non-zero when vulnerabilities exist: the JSON is what counts.
    command: `mkdir -p ${OUT} && (npm audit --json > ${OUT}/npm-audit.json || true)`,
    outputFile: 'npm-audit.json',
    parse: parseNpmAudit,
  },
  {
    name: 'semgrep',
    image: (i) => i.semgrep,
    applies: async () => true,
    command: `mkdir -p ${OUT} && semgrep scan --config p/default --metrics off --quiet --json --output ${OUT}/semgrep.json /work`,
    outputFile: 'semgrep.json',
    parse: parseSemgrep,
  },
  {
    name: 'gitleaks',
    image: (i) => i.gitleaks,
    applies: async () => true,
    command: `mkdir -p ${OUT} && gitleaks detect --no-git --source /work --report-format json --report-path ${OUT}/gitleaks.json --exit-code 0`,
    outputFile: 'gitleaks.json',
    parse: parseGitleaks,
  },
];

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

/** Highest severity first, then by file; capped. Candidates outside the task's folders are dropped. */
export function rankCandidates(all: Candidate[], paths: string[]): { kept: Candidate[]; dropped: number } {
  const inside = (c: Candidate) => paths.length === 0 || (c.file !== null && paths.some((p) => c.file === p || c.file!.startsWith(`${p}/`)));
  const scoped = all.filter(inside);
  const sorted = [...scoped].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
  return { kept: sorted.slice(0, MAX_CANDIDATES), dropped: all.length - Math.min(sorted.length, MAX_CANDIDATES) };
}
