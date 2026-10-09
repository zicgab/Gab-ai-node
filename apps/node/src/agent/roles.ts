import { stat } from 'node:fs/promises';
import { exec } from '../exec.js';
import { inScope } from './tools.js';
import path from 'node:path';
import type { Role } from '@gab-ai-node/protocol';

/** What each role looks for. Added to the task's system prompt; the report format stays the task kind's. */
export const ROLE_BRIEFS: Record<Role, string> = {
  frontend: `You review as a FRONTEND developer. Look for: broken or missing event handlers, state that goes stale or is mutated in place, effects with missing or wrong dependencies and cleanup, async races (late responses overwriting newer state), null/undefined access on data that may not be loaded, forms without validation or error handling, missing loading/empty/error states, accessibility problems (labels, focus, keyboard), wrong or missing translations. Run the linter, type check and tests when the repo has them.`,
  backend: `You review as a BACKEND developer. Look for: endpoints without input validation or without authorization checks, SQL built from strings, queries inside loops, missing transactions or wrong isolation, swallowed errors, retries that are not idempotent, race conditions, unbounded results, resource leaks (connections, files, timers), wrong status codes, secrets or personal data in logs. Run the tests when the repo has them.`,
  security: `You review as a SECURITY engineer. Look for: injection (SQL, command, template), missing authentication or authorization (including object-level access: can user A read user B's data), XSS, CSRF, SSRF, path traversal, unsafe deserialization, hard-coded secrets and keys, weak crypto or token handling, open redirects, overly broad CORS, unsafe file uploads, vulnerable dependency versions that the code really uses. Report a problem only when you can name the exact code path an attacker would use (file:line, and the input that triggers it). Theoretical or best-practice remarks are not findings.`,
  uxui: `You review as a UX/UI designer who reads code. Look for: flows that dead-end or lose the user's work, error messages that do not say what to do, missing loading, empty and error states, inconsistent labels or wording for the same thing, controls that look enabled but do nothing, text that cannot be translated or overflows, poor contrast or tiny touch targets, confusing defaults. Evidence is the file:line and what the user sees there; do not invent screens.`,
};

/** The system prompt of a task with its role's checklist and its folders added. */
export function withRole(system: string, role: Role | null, paths: string[]): string {
  const parts = [system];
  if (role) parts.push(ROLE_BRIEFS[role]);
  if (paths.length) {
    parts.push(`Scope: work ONLY in these folders of the repo: ${paths.join(', ')}. The file tools refuse other paths; report nothing that lives outside them.`);
  }
  return parts.join('\n\n');
}

/** Fails (not retryable) when a folder of the task is not in the checked-out repo: a typo, or a wrong ref. */
export async function checkScope(workdir: string, paths: string[]): Promise<void> {
  for (const folder of paths) {
    const full = path.join(workdir, folder);
    const s = await stat(full).catch(() => null);
    if (!s?.isDirectory()) throw new Error(`folder "${folder}" does not exist in the repo at this ref (check the spelling, or the ref)`);
  }
}

/** Files git sees as changed (new, edited, deleted, renamed) that are not inside the task's folders. */
export async function changedOutsideScope(workdir: string, paths: string[]): Promise<string[]> {
  const out = (await exec('git', ['-C', workdir, 'status', '--porcelain', '-z', '--untracked-files=all'], { check: true })).stdout;
  const entries = out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    files.push(entry.slice(3));
    // A rename or copy is followed by the old path as its own entry.
    if (entry[0] === 'R' || entry[0] === 'C') files.push(entries[++i] ?? '');
  }
  return files.filter((f) => f && !inScope(paths, f));
}
