// gab-node models detect: finds model servers you already run (Ollama, LM Studio, llama.cpp, vLLM)
// by asking localhost, which works the same on macOS, Windows and Linux, and lets you point the
// node at one ("external" mode: one endpoint serves every model of the node). It also reports
// model folders of tools that are installed but not running, so you know what to start.
import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { loadConfig, saveConfig, type NodeConfig } from '../config.js';
import { exec, has } from '../exec.js';
import { dataDir } from '../paths.js';
import { Role, TaskKind } from '@gab-ai-node/protocol';
import { CATALOG, type CatalogEntry } from './catalog.js';
import { addModel } from './commands.js';

export interface DetectedServer {
  kind: 'ollama' | 'lmstudio' | 'llama.cpp' | 'openai-compatible';
  /** OpenAI-compatible base URL, always on this machine. */
  endpoint: string;
  /** tools: the model can call tools (agent tasks need it); null when the server does not say. */
  models: { id: string; sizeBytes: number | null; tools: boolean | null; vision?: boolean | null }[];
}

const PROBES = [
  { kind: 'ollama' as const, base: 'http://127.0.0.1:11434' },
  { kind: 'lmstudio' as const, base: 'http://127.0.0.1:1234' },
  { kind: 'llama.cpp' as const, base: 'http://127.0.0.1:8080' },
  { kind: 'openai-compatible' as const, base: 'http://127.0.0.1:8000' },
];

const OllamaTags = z.object({ models: z.array(z.object({ name: z.string().min(1), size: z.number().nonnegative().optional() })) });
const OllamaShow = z.object({ capabilities: z.array(z.string()).optional() });
const OpenAIModels = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

async function getJson(fetchFn: typeof fetch, url: string, body?: unknown): Promise<unknown | null> {
  try {
    const res = await fetchFn(url, body === undefined ? { signal: AbortSignal.timeout(1_500) }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    return res.ok ? await res.json() : null;
  } catch { return null; } // nothing listening there: not an error
}

export async function probeServers(fetchFn: typeof fetch = fetch): Promise<DetectedServer[]> {
  const found = await Promise.all(PROBES.map(async (p): Promise<DetectedServer | null> => {
    if (p.kind === 'ollama') {
      const tags = OllamaTags.safeParse(await getJson(fetchFn, `${p.base}/api/tags`));
      if (tags.success) {
        // Ollama says per model whether it can call tools (older versions do not: null).
        const models = await Promise.all(tags.data.models.map(async (m) => {
          const show = OllamaShow.safeParse(await getJson(fetchFn, `${p.base}/api/show`, { model: m.name }));
          const caps = show.success ? show.data.capabilities : undefined;
          return { id: m.name, sizeBytes: m.size ?? null, tools: caps ? caps.includes('tools') : null, vision: caps ? caps.includes('vision') : null };
        }));
        return { kind: p.kind, endpoint: `${p.base}/v1`, models };
      }
    }
    const list = OpenAIModels.safeParse(await getJson(fetchFn, `${p.base}/v1/models`));
    return list.success && p.kind !== 'ollama' ? { kind: p.kind, endpoint: `${p.base}/v1`, models: list.data.data.map((m) => ({ id: m.id, sizeBytes: null, tools: null })) } : null;
  }));
  return found.filter((s): s is DetectedServer => s !== null);
}

/** Model folders of well-known tools, per OS (the server may just not be running). */
export function modelFolders(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): { tool: string; dir: string; hint: string }[] {
  return [
    { tool: 'Ollama', dir: env.OLLAMA_MODELS || path.join(home, '.ollama', 'models'), hint: 'start Ollama (the app, or "ollama serve"), then run: gab-node models detect' },
    { tool: 'LM Studio', dir: path.join(home, '.lmstudio', 'models'), hint: 'open LM Studio and start its local server (Developer tab), then run: gab-node models detect' },
    { tool: 'LM Studio (older)', dir: path.join(home, '.cache', 'lm-studio', 'models'), hint: 'open LM Studio and start its local server, then run: gab-node models detect' },
    { tool: 'Hugging Face', dir: path.join(env.HF_HOME || path.join(home, '.cache', 'huggingface'), 'hub'), hint: 'these files need a server (llama.cpp llama-server, MLX or vLLM) that you run yourself; not used automatically' },
  ];
}

/**
 * Starts Ollama when it is installed but not running: the app on macOS (it keeps itself running),
 * else "ollama serve" in the background. Waits until it answers. Returns whether it is up.
 */
export async function startOllama(fetchFn: typeof fetch = fetch, waitMs = 30_000, platform = process.platform): Promise<boolean> {
  const up = async () => (await getJson(fetchFn, 'http://127.0.0.1:11434/api/tags')) !== null;
  if (await up()) return true;
  // The background server only: opening the Ollama app would pop up its window, which the node does not need.
  let started = false;
  if (await has('ollama')) {
    const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); // reported below as "did not answer"
    child.unref();
    started = true;
  }
  // No command on PATH: the macOS app, opened hidden and in the background.
  if (!started && platform === 'darwin') started = (await exec('open', ['-g', '-j', '-a', 'Ollama'])).code === 0;
  if (!started) return false;
  for (const end = Date.now() + waitMs; Date.now() < end; await new Promise((r) => setTimeout(r, 1_000))) {
    if (await up()) return true;
  }
  return false;
}

/** True when Ollama is installed (the program, or the macOS app), running or not. */
export async function ollamaInstalled(): Promise<boolean> {
  return (await has('ollama')) || (process.platform === 'darwin' && (await exists('/Applications/Ollama.app')));
}

/** How Ollama is installed here: only through the system's own package manager or Ollama's own installer. null: do it by hand. */
export async function ollamaInstallPlan(platform = process.platform, tools: (name: string) => Promise<boolean> = has): Promise<{ command: string; args: string[]; note: string } | null> {
  if (platform === 'darwin' && (await tools('brew'))) return { command: 'brew', args: ['install', '--cask', 'ollama'], note: 'Homebrew cask "ollama"' };
  if (platform === 'win32' && (await tools('winget'))) return { command: 'winget', args: ['install', '--id', 'Ollama.Ollama', '-e', '--accept-package-agreements', '--accept-source-agreements'], note: 'winget package Ollama.Ollama' };
  if (platform === 'linux' && (await tools('curl'))) return { command: 'sh', args: ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], note: "Ollama's official install script (asks for sudo)" };
  return null;
}

/** Installs Ollama with the plan above, showing its output. False when it cannot or failed. */
export async function installOllama(): Promise<boolean> {
  const plan = await ollamaInstallPlan();
  if (!plan) {
    console.log('Install Ollama by hand: https://ollama.com/download , then run "gab-node models detect".');
    return false;
  }
  console.log(`Installing Ollama: ${plan.note}...`);
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(plan.command, plan.args, { stdio: 'inherit', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!ok) console.log('The Ollama install failed (see above). Install it by hand: https://ollama.com/download');
  return ok;
}

/** One tiny request with a tool: does the model answer with a tool call? (Loading a big model can take a minute.) */
export async function toolSmokeTest(endpoint: string, model: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetchFn(`${endpoint}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 200,
        messages: [{ role: 'user', content: 'Call the tool get_time with zone "UTC". Do not answer in text.' }],
        tools: [{ type: 'function', function: { name: 'get_time', description: 'Current time in a zone', parameters: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] } } }],
      }),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const body = z.object({ choices: z.array(z.object({ message: z.object({ tool_calls: z.array(z.object({ function: z.object({ name: z.string() }) })).nullish() }) })).min(1) }).safeParse(await res.json());
    if (!body.success) return { ok: false, detail: 'unexpected response' };
    const called = body.data.choices[0]!.message.tool_calls?.some((c) => c.function.name === 'get_time') ?? false;
    return called ? { ok: true, detail: 'called the tool' } : { ok: false, detail: 'answered without calling the tool' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/** Models to propose: the ones known to call tools; if the server does not say, all of them. */
export function suggestedModels(server: DetectedServer): string[] {
  const capable = server.models.filter((m) => m.tools === true).map((m) => m.id);
  return capable.length ? capable : server.models.filter((m) => m.tools !== false).map((m) => m.id);
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
  config.modelEndpoints = {};
  config.models = [];
  config.defaultModel = null;
  config.roleModels = {};
  config.visionModels = chosen.filter((m) => m.vision === true).map((m) => m.id);
  for (const m of chosen) addModel(config, m.id, estimateMemoryMb(m.sizeBytes));
}

/**
 * Adds models of a second server next to the node's current ones (e.g. LM Studio next to Ollama):
 * they get their own endpoint in modelEndpoints. The default server and models are kept.
 */
export function addServer(config: NodeConfig, server: DetectedServer, ids: string[]): void {
  if (config.modelServer.mode !== 'external') throw new Error('adding a server needs external mode (the node runs no model server itself): use replace');
  const chosen = ids.map((id) => {
    const m = server.models.find((x) => x.id === id);
    if (!m) throw new Error(`${server.kind} at ${server.endpoint} has no model "${id}"`);
    return m;
  });
  if (chosen.length === 0) throw new Error('choose at least one model');
  for (const m of chosen) {
    const clash = config.models.some((x) => x.id === m.id) && (config.modelEndpoints[m.id] ?? config.modelEndpoint) !== server.endpoint;
    if (clash) throw new Error(`a model named ${m.id} is already served by another server of this node`);
    addModel(config, m.id, estimateMemoryMb(m.sizeBytes));
    if (server.endpoint === config.modelEndpoint) delete config.modelEndpoints[m.id];
    else config.modelEndpoints[m.id] = server.endpoint;
    if (m.vision === true && !config.visionModels.includes(m.id)) config.visionModels.push(m.id);
  }
}


/** Catalog models that Ollama can pull, fit this machine, and are not installed yet. */
export function missingRecommended(installed: string[], budgetMb: number, catalog: readonly CatalogEntry[] = CATALOG): CatalogEntry[] {
  return catalog.filter((e) => e.memoryMb <= budgetMb && !installed.includes(e.ollama));
}

/** Models this node downloaded through Ollama, one per line: uninstall offers to remove only these. */
export const pulledFile = (dir = dataDir()) => path.join(dir, 'ollama-pulled.txt');

export async function rememberPulled(tag: string, file = pulledFile()): Promise<void> {
  const known = (await readFile(file, 'utf8').catch(() => '')).split('\n');
  if (known.includes(tag)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${tag}\n`);
}

/** "ollama pull <tag>", showing Ollama's own progress. */
export function ollamaPull(tag: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ollama', ['pull', tag], { stdio: 'inherit', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

type Slot = keyof NodeConfig['roleModels'];
const SLOTS = new Set<string>([...Role.options, ...TaskKind.options]);
const CODE: Slot[] = ['frontend', 'backend', 'custom', 'fix_finding', 'contract_check', 'test_web', 'test_electron', 'test_mobile', 'ask'];
const DEEP: Slot[] = ['security', 'uxui', 'bug_hunt', 'scan', 'docs_check'];
const QUICK: Slot[] = ['chat'];

/**
 * Proposes a default model and a model per role from the chosen models: catalog models get the roles the
 * catalog gives them; the rest is filled by rules of thumb (a "coder" model for code, the biggest model for
 * reviews, the smallest for chat). Only models that fit the memory budget are used.
 */
export function suggestRoles(models: { id: string; memoryMb: number }[], budgetMb: number, catalog: readonly CatalogEntry[] = CATALOG): { defaultModel: string | null; roles: Partial<Record<Slot, string>> } {
  const fit = models.filter((m) => m.memoryMb <= budgetMb).sort((a, b) => b.memoryMb - a.memoryMb);
  if (fit.length === 0) return { defaultModel: null, roles: {} };
  const roles: Partial<Record<Slot, string>> = {};
  for (const m of fit) {
    const e = catalog.find((c) => c.ollama === m.id || c.id === m.id);
    for (const slot of e?.useFor ?? []) if (SLOTS.has(slot) && !roles[slot as Slot]) roles[slot as Slot] = m.id;
  }
  const coder = fit.find((m) => /coder|code/i.test(m.id))?.id;
  const biggest = fit[0]!.id;
  const smallest = fit[fit.length - 1]!.id;
  const fill = (slots: Slot[], id: string) => { for (const s of slots) roles[s] ??= id; };
  fill(CODE, coder ?? biggest);
  fill(DEEP, biggest);
  fill(QUICK, smallest);
  return { defaultModel: roles.backend ?? coder ?? biggest, roles };
}

/**
 * detect: list; installs Ollama when missing (asks once on a terminal; --install: without asking) and starts it when stopped.
 * detect --use <number> [model ids...] [--add]: apply without prompts (--add keeps the models of the current server). On a terminal with no --use: asks.
 */
export async function detectCommand(args: string[]): Promise<void> {
  const tty = process.stdin.isTTY === true;
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const ask = async (q: string): Promise<string> => (rl ? (await rl.question(q)).trim() : '');
    let servers = await probeServers();
    const folders = (await Promise.all(modelFolders().map(async (f) => ((await exists(f.dir)) ? f : null)))).filter((f) => f !== null);

    if (!servers.some((s) => s.kind === 'ollama')) {
      // Ollama is the node's model engine: install it when missing (asks once), start it when stopped (no question).
      let installed = await ollamaInstalled() || folders.some((f) => f.tool === 'Ollama');
      if (!installed && (args.includes('--install') || (tty && !/^n/i.test(await ask('Ollama (runs the AI models) is not installed. Install it now? [Y/n] '))))) {
        installed = (await installOllama()) && (await ollamaInstalled());
      }
      if (installed) {
        console.log('Starting Ollama...');
        if (await startOllama()) servers = await probeServers();
        else console.log('Ollama did not start (try the Ollama app, or "ollama serve" yourself).');
      }
    }

    if (servers.length === 0) {
      console.log('No running model server found (looked for Ollama :11434, LM Studio :1234, llama.cpp :8080, vLLM :8000).');
      for (const f of folders) console.log(`Found ${f.tool} files at ${f.dir}: ${f.hint}`);
      if (!folders.some((f) => f.tool === 'Ollama')) {
        console.log('Easiest: install Ollama (https://ollama.com/download), then run "gab-node models detect": it offers the recommended models.');
        console.log('Or without Ollama: "gab-node models list" then "gab-node models pull <id>" (pinned, hash-checked files run by llama-server).');
      }
      return;
    }
    const config = await loadConfig();
    const ollama = servers.find((x) => x.kind === 'ollama');
    if (ollama && (tty || args.includes('--pull'))) {
      const missing = missingRecommended(ollama.models.map((m) => m.id), config.memoryBudgetMb);
      if (missing.length) {
        console.log(`Recommended models that fit this machine (${(config.memoryBudgetMb / 1024).toFixed(0)} GB budget) and are not installed:`);
        for (const e of missing) console.log(`     ${e.ollama.padEnd(18)} ${(e.sizeBytes / 1024 ** 3).toFixed(0).padStart(3)} GB  ${e.role}`);
        const a = args.includes('--pull') ? 'all' : await ask('Download them? [all / names separated by spaces / Enter = no] ');
        const tags = /^all$/i.test(a) ? missing.map((e) => e.ollama) : a.split(/\s+/).filter((t) => missing.some((e) => e.ollama === t));
        for (const tag of tags) {
          console.log(`Downloading ${tag} (ollama pull)...`);
          if (await ollamaPull(tag)) await rememberPulled(tag);
          else console.log(`${tag}: download failed (see above); continuing without it.`);
        }
        if (tags.length) servers = await probeServers();
      }
    }

    const mark = (t: boolean | null, v?: boolean | null) => `${t === true ? ' [tools]' : t === false ? ' [no tools: not for agent tasks]' : ''}${v ? ' [vision]' : ''}`;
    servers.forEach((s, i) => console.log(`${i + 1}. ${s.kind} at ${s.endpoint}\n${s.models.map((m) => `     ${m.id}${m.sizeBytes ? ` (${(m.sizeBytes / 1024 ** 3).toFixed(1)} GB)` : ''}${mark(m.tools, m.vision)}`).join('\n') || '     (no models)'}`));
    if (servers.length > 1) console.log('A node uses ONE server: pick the one to use.');

    let pick: number; let ids: string[];
    const useAt = args.indexOf('--use');
    if (useAt >= 0) {
      pick = Number(args[useAt + 1]) - 1;
      ids = args.slice(useAt + 2).filter((a) => !a.startsWith('--'));
      if (ids.length === 0 && servers[pick]) ids = suggestedModels(servers[pick]!);
    } else if (tty) {
      const a = await ask(`Use which server? [${servers.length === 1 ? '1' : `1-${servers.length}`}, Enter = 1, "skip" to skip] `);
      if (/^s/i.test(a)) { console.log('Skipped. Run "gab-node models detect" any time.'); return; }
      pick = a ? Number(a) - 1 : 0;
      const proposed = servers[pick] ? suggestedModels(servers[pick]!) : [];
      const typed = await ask(`Models to use (space separated) [${proposed.join(' ')}] `);
      ids = typed ? typed.split(/\s+/) : proposed;
    } else return; // not a terminal and no --use: listing is all we do
    const server = servers[pick];
    if (!server) throw new Error(`no server number ${pick + 1}`);
    if (ids.length === 0) throw new Error(`no model to use on ${server.kind}: pull one first (e.g. "ollama pull qwen2.5-coder:14b")`);
    // A node that already has models from another server: replace them, or add these next to them.
    const other = config.models.length > 0 && config.modelServer.mode === 'external' && config.modelEndpoint !== server.endpoint;
    const add = other && (args.includes('--add') || (tty && /^a/i.test(await ask(`This node already uses ${config.modelEndpoint}. Replace its models (r) or add these next to them (a)? [r/a] `))));
    if (add) addServer(config, server, ids);
    else useServer(config, server, ids);
    const plan = suggestRoles(config.models, config.memoryBudgetMb);
    if (plan.defaultModel) {
      const byModel = new Map<string, string[]>();
      for (const [slot, id] of Object.entries(plan.roles)) byModel.set(id!, [...(byModel.get(id!) ?? []), slot]);
      console.log(`Suggested models (from names and sizes; change later with "gab-node models use"):\n     default: ${plan.defaultModel}`);
      for (const [id, slots] of byModel) console.log(`     ${id}: ${slots.join(', ')}`);
      const go = args.includes('--roles') || (tty && !/^n/i.test(await ask('Use these? [Y/n] ')));
      if (go) { config.defaultModel = plan.defaultModel; config.roleModels = plan.roles as NodeConfig['roleModels']; }
    }
    await saveConfig(config);
    console.log(`Using ${server.kind} at ${server.endpoint}: ${config.models.map((m) => m.id).join(', ')} (default ${config.defaultModel}).`);
    console.log('Memory per model is an estimate (file size + 20%); a wrong estimate only affects how many models load at once.');

    const model = config.defaultModel!;
    console.log(`Checking that ${model} can call tools (loading it can take a minute)...`);
    const smoke = await toolSmokeTest(config.modelEndpoints[model] ?? config.modelEndpoint, model);
    console.log(smoke.ok ? `${model}: OK, ${smoke.detail}.` : `${model}: WARNING, ${smoke.detail}. Agent tasks need tool calls: pick another model (gab-node models detect) or set a per-role model (gab-node models use).`);
  } finally { rl?.close(); }
}
