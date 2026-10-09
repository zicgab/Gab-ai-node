import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatResponse, ModelBackend } from '../src/backends/types.js';
import { runEval, scoreReport } from '../src/eval.js';

const expected = [
  { id: 'offset', type: 'bug', file: 'backend/orders.js', keywords: ['offset', 'page'] },
  { id: 'sqli', type: 'bug', file: 'backend/orders.js', keywords: ['injection'] },
  { id: 'csv', type: 'docs', file: 'docs/how-to.md', keywords: ['csv'] },
];
const p = (title: string, file: string, evidence = '') => ({ title, severity: 'high', file, evidence });

describe('scoreReport', () => {
  it('matches by file and keyword, counts duplicates once and unrelated reports as false alarms', () => {
    const s = scoreReport(expected, [
      p('Pagination skips the first page', './backend/orders.js', 'offset = page * 10'),
      p('Pagination offset wrong', 'backend/orders.js', 'page 1 starts at 10'),
      p('SQL injection in search', 'backend/orders.js'),
      p('Typo in comment', 'backend/db.js'),
    ]);
    expect(s.found.sort()).toEqual(['offset', 'sqli']);
    expect(s.missed).toEqual(['csv']);
    expect(s.falseAlarms).toEqual(['Typo in comment']);
  });
});

describe('runEval', () => {
  it('reviews a copy of the canary without the answers and scores the report', async () => {
    const seen: ChatMessage[][] = [];
    const call = (name: string, args: unknown): Partial<ChatMessage> => ({ tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const report = { summary: 'reviewed', problems: [p('SQL injection via customer', 'backend/orders.js', 'string interpolation in SQL'), p('CSV export is not built', 'docs/how-to.md', 'docs promise CSV export')] };
    const answers = [call('list_dir', { path: '.' }), { content: JSON.stringify(report) }];
    let i = 0;
    const backend: ModelBackend = { model: 'fake', async chat(m): Promise<ChatResponse> { seen.push([...m]); return { message: { role: 'assistant', content: null, ...answers[Math.min(i++, answers.length - 1)]! }, tokens: 3, finishReason: 'stop' }; } };
    const r = await runEval(backend);
    expect(r.found.sort()).toEqual(['docs-csv-export-missing', 'sql-injection']);
    expect(r.missed).toHaveLength(4);
    expect(r.valid).toBe(true);
    const listing = String(seen[1]!.at(-1)!.content);
    expect(listing).toContain('backend');
    expect(listing).not.toContain('expected.json');
  });
});
