// gab-node models detect: finds model servers you already run (Ollama, LM Studio, llama.cpp, vLLM)
// by asking localhost, which works the same on macOS, Windows and Linux, and lets you point the
// node at one ("external" mode: one endpoint serves every model of the node). It also reports
// model folders of tools that are installed but not running, so you know what to start.
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { loadConfig, saveConfig, type NodeConfig } from '../config.js';
import { addModel } from './commands.js';

export interface DetectedServer {
  kind: 'ollama' | 'lmstudio' | 'llama.cpp' | 'openai-compatible';
  /** OpenAI-compatible base URL, always on this machine. */
  endpoint: string;
  models: { id: string; sizeBytes: number | null }[];
}

const PROBES = [
  { kind: 'ollama' as const, base: 'http://127.0.0.1:11434' },
  { kind: 'lmstudio' as const, base: 'http://127.0.0.1:1234' },
  { kind: 'llama.cpp' as const, base: 'http://127.0.0.1:8080' },
  { kind: 'openai-compatible' as const, base: 'http://127.0.0.1:8000' },
];

const OllamaTags = z.object({ models: z.array(z.object({ name: z.string().min(1), size: z.number().nonnegative().optional() })) });
const OpenAIModels = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

async function getJson(fetchFn: typeof fetch, url: string): Promise<unknown | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(1_500) });
    return res.ok ? await res.json() : null;
  } catch { return null; } // nothing listening there: not an error
}

export async function probeServers(fetchFn: typeof fetch = fetch): Promise<DetectedServer[]> {
  const found = await Promise.all(PROBES.map(async (p): Promise<DetectedServer | null> => {
    if (p.kind === 'ollama') {
      const tags = OllamaTags.safeParse(await getJson(fetchFn, `${p.base}/api/tags`));
      if (tags.success) return { kind: p.kind, endpoint: `${p.base}/v1`, models: tags.data.models.map((m) => ({ id: m.name, sizeBytes: m.size ?? null })) };
    }
    const list = OpenAIModels.safeParse(await getJson(fetchFn, `${p.base}/v1/models`));
    return list.success && p.kind !== 'ollama' ? { kind: p.kind, endpoint: `${p.base}/v1`, models: list.data.data.map((m) => ({ id: m.id, sizeBytes: null })) } : null;
  }));
  return found.filter((s): s is DetectedServer => s !== null);
}

/** Model folders of well-known tools, per OS (the server may just not be running). */
export function modelFolders(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): { tool: string; dir: string }[] {
  return [
    { tool: 'Ollama', dir: env.OLLAMA_MODELS || path.join(home, '.ollama', 'models') },
    { tool: 'LM Studio', dir: path.join(home, '.lmstudio', 'models') },
    { tool: 'LM Studio (older)', dir: path.join(home, '.cache', 'lm-studio', 'models') },
    { tool: 'Hugging Face', dir: path.join(env.HF_HOME || path.join(home, '.cache', 'huggingface'), 'hub') },
  ];
}

async function exists(dir: string): Promise<boolean> { return access(dir).then(() => true, () => false); }

/** Memory a model needs loaded: its file size plus ~20% for the context, when the server tells us; else a cautious 8 GB. */
export function estimateMemoryMb(sizeBytes: number | null): number {
  return sizeBytes ? Math.max(512, Math.ceil((sizeBytes * 1.2) / 1024 ** 2)) : 8192;
}

/** Points the node at an external server and registers the chosen models. Replaces the node's model list. */
export function useServer(config: NodeConfig, server: DetectedServer, ids: string[]): void {
  const chosen = ids.map((id) => {
    const m = server.models.find((x) => x.id === id);
    if (!m) throw new Error(`${server.kind} at ${server.endpoint} has no model "${id}" (it has: ${server.models.map((x) => x.id).join(', ') || 'none'})`);
    return m;
  });
  if (chosen.length === 0) throw new Error('choose at least one model');
  config.modelServer.mode = 'external';
  config.modelEndpoint = server.endpoint;
  config.models = [];
  config.defaultModel = null;
  config.roleModels = {};
  for (const m of chosen) addModel(config, m.id, estimateMemoryMb(m.sizeBytes));
}

/** detect: list. detect --use <number> [model ids...]: apply without prompts. On a terminal with no flags: asks. */
export async function detectCommand(args: string[]): Promise<void> {
  const servers = await probeServers();
  const folders = (await Promise.all(modelFolders().map(async (f) => ((await exists(f.dir)) ? f : null)))).filter((f) => f !== null);
  if (servers.length === 0) {
    console.log('No running model server found (looked for Ollama :11434, LM Studio :1234, llama.cpp :8080, vLLM :8000).');
    for (const f of folders) console.log(`Found ${f.tool} files at ${f.dir}: start that tool (its server must be running), then run: gab-node models detect`);
    if (folders.length === 0) console.log('Nothing installed that I know of: use "gab-node models pull <id>" to download a model.');
    return;
  }
  servers.forEach((s, i) => console.log(`${i + 1}. ${s.kind} at ${s.endpoint}\n${s.models.map((m) => `     ${m.id}${m.sizeBytes ? ` (${(m.sizeBytes / 1024 ** 3).toFixed(1)} GB)` : ''}`).join('\n') || '     (no models loaded)'}`));
  if (servers.length > 1) console.log('A node uses ONE server: pick the one to use.');

  let pick: number; let ids: string[];
  const useAt = args.indexOf('--use');
  if (useAt >= 0) {
    pick = Number(args[useAt + 1]) - 1;
    ids = args.slice(useAt + 2);
  } else if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`Use which server? [1-${servers.length}, Enter to skip] `)).trim();
      if (!a) { console.log('Skipped. Run "gab-node models detect" any time.'); return; }
      pick = Number(a) - 1;
      const s = servers[pick];
      const all = (await rl.question(`Models to use (space separated) [${s?.models.map((m) => m.id).join(' ') ?? ''}] `)).trim();
      ids = all ? all.split(/\s+/) : (s?.models.map((m) => m.id) ?? []);
    } finally { rl.close(); }
  } else return; // not a terminal and no --use: listing is all we do
  const server = servers[pick];
  if (!server) throw new Error(`no server number ${pick + 1}`);
  if (ids.length === 0) ids = server.models.map((m) => m.id);
  const config = await loadConfig();
  useServer(config, server, ids);
  await saveConfig(config);
  console.log(`Using ${server.kind} at ${server.endpoint}: ${config.models.map((m) => m.id).join(', ')} (default ${config.defaultModel}).`);
  console.log('Memory per model is an estimate (file size + 20%); a wrong estimate only affects how many models load at once.');
}
