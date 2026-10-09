// gab-node models manage: one menu to see every model on this machine (all running model servers)
// and what the node does with it, download recommended ones, add or remove models from the node,
// set the default / per-role model, and delete Ollama models from disk. Terminal only.
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Role, TaskKind } from '@gab-ai-node/protocol';
import { loadConfig, saveConfig, type NodeConfig } from '../config.js';
import { exec } from '../exec.js';
import { addServer, missingRecommended, ollamaPull, probeServers, pulledFile, rememberPulled, useServer, type DetectedServer } from './detect.js';

export interface ModelRow {
  id: string;
  server: DetectedServer;
  sizeBytes: number | null;
  /** The node uses it (and as what: default, roles). */
  inNode: boolean;
  uses: string[];
  /** Downloaded by the node (uninstall offers to remove it). */
  pulledByNode: boolean;
}

/** Every model of every running server, with what the node does with it. */
export function modelRows(config: Pick<NodeConfig, 'models' | 'defaultModel' | 'roleModels' | 'modelEndpoint' | 'modelEndpoints'>, servers: DetectedServer[], pulled: string[]): ModelRow[] {
  return servers.flatMap((server) => server.models.map((m) => {
    const inNode = config.models.some((x) => x.id === m.id) && (config.modelEndpoints[m.id] ?? config.modelEndpoint) === server.endpoint;
    const uses = inNode ? [...(config.defaultModel === m.id ? ['default'] : []), ...Object.entries(config.roleModels).filter(([, id]) => id === m.id).map(([k]) => k)] : [];
    return { id: m.id, server, sizeBytes: m.sizeBytes, inNode, uses, pulledByNode: server.kind === 'ollama' && pulled.includes(m.id) };
  }));
}

/** Takes a model out of the node (config only, the file stays): default and roles move away from it. */
export function removeFromNode(config: NodeConfig, id: string): void {
  config.models = config.models.filter((m) => m.id !== id);
  delete config.modelEndpoints[id];
  config.visionModels = config.visionModels.filter((m) => m !== id);
  if (config.defaultModel === id) config.defaultModel = config.models[0]?.id ?? null;
  config.roleModels = Object.fromEntries(Object.entries(config.roleModels).filter(([, m]) => m !== id));
}

/** Adds one model of a server to the node: the first model sets the server, later ones are added next to it. */
export function addToNode(config: NodeConfig, server: DetectedServer, id: string): void {
  if (config.models.length === 0 || config.modelServer.mode !== 'external') {
    useServer(config, server, [id]);
    config.defaultModel = id;
  } else addServer(config, server, [id]);
}

const SLOTS = ['default', ...Role.options, ...TaskKind.options];
const gb = (b: number | null) => (b ? `${(b / 1024 ** 3).toFixed(1)} GB` : '');

function print(rows: ModelRow[]): void {
  if (rows.length === 0) console.log('No models found on the running servers.');
  rows.forEach((r, i) => {
    const what = r.inNode ? `in node${r.uses.length ? `: ${r.uses.join(', ')}` : ''}` : '-';
    console.log(`${String(i + 1).padStart(3)}. ${r.id.padEnd(28)} ${gb(r.sizeBytes).padStart(8)}  ${r.server.kind.padEnd(9)} ${what}${r.pulledByNode ? '  (downloaded by node)' : ''}`);
  });
}

export async function manageCommand(): Promise<void> {
  if (process.stdin.isTTY !== true) throw new Error('models manage needs a terminal (scripts: use models detect --use / models use)');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const servers = await probeServers();
      if (servers.length === 0) { console.log('No running model server (start Ollama or LM Studio, or run "gab-node models detect").'); return; }
      const config = await loadConfig();
      const pulled = (await readFile(pulledFile(), 'utf8').catch(() => '')).split('\n').filter(Boolean);
      const rows = modelRows(config, servers, pulled);
      console.log('');
      print(rows);
      const a = (await rl.question('\n[d] download  [a <n>] add to node  [r <n>] remove from node  [u <n> <role|default>] use as  [x <n>] delete from disk  [q] quit\n> ')).trim();
      const [cmd, num, slot] = a.split(/\s+/);
      if (!cmd || /^q/i.test(cmd)) return;
      try {
        if (cmd === 'd') {
          const ollama = servers.find((s) => s.kind === 'ollama');
          if (!ollama) { console.log('Downloads go through Ollama, which is not running.'); continue; }
          const missing = missingRecommended(ollama.models.map((m) => m.id), config.memoryBudgetMb);
          for (const e of missing) console.log(`     ${e.ollama.padEnd(18)} ${(e.sizeBytes / 1024 ** 3).toFixed(0).padStart(3)} GB  ${e.role}`);
          const tag = (await rl.question(missing.length ? 'Which one? (a name above, or any Ollama tag; Enter = cancel) ' : 'Recommended ones are installed. Any Ollama tag? (Enter = cancel) ')).trim();
          if (!tag) continue;
          if (!/^[\w.\-/:]+$/.test(tag)) throw new Error(`"${tag}" is not an Ollama model name`);
          console.log(`Downloading ${tag} (ollama pull)...`);
          if (!(await ollamaPull(tag))) throw new Error(`${tag}: download failed (see above)`);
          await rememberPulled(tag);
          if (!/^n/i.test(await rl.question(`Add ${tag} to the node? [Y/n] `))) {
            const fresh = (await probeServers()).find((s) => s.kind === 'ollama');
            if (fresh) { addToNode(config, fresh, tag); await saveConfig(config); console.log(`${tag} added.`); }
          }
          continue;
        }
        const row = rows[Number(num) - 1];
        if (!row) throw new Error(`no model number ${num ?? ''}`);
        if (cmd === 'a') {
          if (row.inNode) { console.log(`${row.id} is already in the node.`); continue; }
          addToNode(config, row.server, row.id);
          await saveConfig(config);
          console.log(`${row.id} added${config.defaultModel === row.id ? ' (default model)' : ''}.`);
        } else if (cmd === 'r') {
          if (!row.inNode) { console.log(`${row.id} is not in the node.`); continue; }
          removeFromNode(config, row.id);
          await saveConfig(config);
          console.log(`${row.id} removed from the node (still on disk).`);
        } else if (cmd === 'u') {
          if (!slot || !SLOTS.includes(slot)) throw new Error(`use as: ${SLOTS.join(', ')}`);
          if (!row.inNode) addToNode(config, row.server, row.id);
          if (slot === 'default') config.defaultModel = row.id;
          else config.roleModels[slot as keyof NodeConfig['roleModels']] = row.id;
          await saveConfig(config);
          console.log(`${row.id} is now used for ${slot}.`);
        } else if (cmd === 'x') {
          if (row.server.kind !== 'ollama') throw new Error(`delete ${row.id} in ${row.server.kind} itself (only Ollama models are deleted from here)`);
          if (!/^y/i.test(await rl.question(`Delete ${row.id}${row.sizeBytes ? ` (${gb(row.sizeBytes)})` : ''} from disk? Other apps using it lose it too. [y/N] `))) continue;
          const r = await exec('ollama', ['rm', row.id], { timeoutMs: 60_000 });
          if (r.code !== 0) throw new Error(`ollama rm ${row.id} failed: ${(r.stderr || r.stdout).trim()}`);
          if (row.inNode) { removeFromNode(config, row.id); await saveConfig(config); }
          console.log(`${row.id} deleted.`);
        } else console.log(`unknown choice "${cmd}"`);
      } catch (err) {
        console.log(`Error: ${(err as Error).message}`);
      }
    }
  } finally { rl.close(); }
}
