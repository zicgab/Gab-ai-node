// Shared by the runners that end with a JSON report: parsing the model's answer
// (with one repair attempt) and turning reported problems into findings.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Finding } from '@gab-ai-node/protocol';
import type { ModelBackend } from '../backends/types.js';

/** Stable across runs: repo, file and the title without numbers/punctuation. */
export function fingerprint(repo: string, file: string | null, title: string): string {
  const norm = title.toLowerCase().replace(/[0-9]+/g, '').replace(/[^a-z]+/g, ' ').trim();
  return createHash('sha256').update(`${repo}\n${file ?? ''}\n${norm}`).digest('hex').slice(0, 32);
}

/** Pulls the JSON object out of the model's answer (bare, or in a ```json block). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

/** A problem as the model reports it; loose on purpose, toFindings checks it. */
export const Problem = z.object({
  title: z.string(), severity: z.string(), file: z.string().nullable().optional(), line: z.number().nullable().optional(),
  evidence: z.string(), suggestedFix: z.string().nullable().optional(),
}).passthrough();
export type Problem = z.infer<typeof Problem>;

/**
 * Parses the final answer with the schema; if it is not valid, asks the model once to
 * rewrite it as the expected JSON. Returns null when that fails too (the caller says so).
 */
export async function parseReport<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>, answer: string, shape: string, backend: ModelBackend, signal: AbortSignal,
): Promise<{ report: T | null; tokens: number }> {
  try { return { report: schema.parse(extractJson(answer)), tokens: 0 }; } catch { /* try a repair below */ }
  const fix = await backend.chat([
    { role: 'system', content: 'Convert the report to the JSON object it was asked for. Output ONLY the JSON.' },
    { role: 'user', content: `Expected shape: ${shape}\n\nReport:\n${answer.slice(0, 30_000)}` },
  ], [], signal);
  try { return { report: schema.parse(extractJson(fix.message.content ?? '')), tokens: fix.tokens }; } catch { return { report: null, tokens: fix.tokens }; }
}

/** Reported problems as findings with a fingerprint; the invalid ones (no evidence, ...) are dropped and logged. */
export function toFindings(
  repo: string, problems: Problem[], emit: (type: 'log', data: Record<string, unknown>) => void,
): z.infer<typeof Finding>[] {
  const findings: z.infer<typeof Finding>[] = [];
  for (const p of problems) {
    const candidate = {
      title: p.title, severity: p.severity.toLowerCase(), file: p.file ?? null, line: p.line && p.line > 0 ? Math.floor(p.line) : null,
      evidence: p.evidence, suggestedFix: p.suggestedFix ?? null, fingerprint: fingerprint(repo, p.file ?? null, p.title),
    };
    const ok = Finding.safeParse(candidate);
    if (ok.success) findings.push(ok.data);
    else emit('log', { droppedProblem: p.title?.slice(0, 200), reason: ok.error.issues[0]?.message });
  }
  return findings;
}
