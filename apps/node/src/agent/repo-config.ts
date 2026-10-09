// Settings read from the repo's AGENT.md, lines like:
//   image: node:20-bookworm
//   setup: npm ci
//   test: npm test
//   start: npm run dev -- --port 3000   (test_web: starts the app inside the sandbox)
//   url: http://localhost:3000            (test_web: where the app answers)
//   electron: dist/main.js                (test_electron: the app's main entry, built by setup)
// Only these keys are read; everything else in AGENT.md is context for the model.
export interface RepoConfig { image: string | null; setup: string | null; test: string | null; start: string | null; url: string | null; electron: string | null }

export function parseRepoConfig(agentMd: string | null): RepoConfig {
  const cfg: RepoConfig = { image: null, setup: null, test: null, start: null, url: null, electron: null };
  for (const line of (agentMd ?? '').split('\n')) {
    const m = /^\s*[-*]?\s*`?(image|setup|test|start|url|electron)`?\s*:\s*`?(.+?)`?\s*$/.exec(line);
    if (m && cfg[m[1] as keyof RepoConfig] === null) cfg[m[1] as keyof RepoConfig] = m[2]!.slice(0, 500);
  }
  return cfg;
}
