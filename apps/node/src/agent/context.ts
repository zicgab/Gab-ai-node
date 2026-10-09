import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_CONTEXT = 12_000;

/** Repo instructions the agent reads first: AGENT.md (how to install/test, what not to touch), then CLAUDE.md. */
export async function repoInstructions(root: string): Promise<string> {
  const parts: string[] = [];
  for (const name of ['AGENT.md', 'CLAUDE.md']) {
    try {
      const text = await readFile(path.join(root, name), 'utf8');
      parts.push(`--- ${name} ---\n${text}`);
    } catch { /* not present */ }
  }
  const joined = parts.join('\n\n');
  return joined.length > MAX_CONTEXT ? `${joined.slice(0, MAX_CONTEXT)}\n… [truncated]` : joined;
}
