// gab-node models list | pull <id...> | verify <id> | remove <id> | use <role|kind> <id|--clear> | detect
import { rm } from 'node:fs/promises';
import { loadConfig, saveConfig, type NodeConfig } from '../config.js';
import { Role, TaskKind } from '@gab-ai-node/protocol';
import { has } from '../exec.js';
import { modelsDir } from '../paths.js';
import { CATALOG, catalogEntry } from './catalog.js';
import { downloadModel, isInstalled, modelPath, verifyModel } from './download.js';
import { detectCommand } from './detect.js';
import { LlamaServerHost, type HostedModel } from './server.js';

export async function modelsCommand(args: string[]): Promise<void> {
  const [sub, ...ids] = args;
  if (sub === 'detect') return detectCommand(ids);
  const config = await loadConfig();
  const dir = modelsDir();
  switch (sub) {
    case 'list': {
      for (const e of CATALOG) {
        const installed = await isInstalled(dir, e);
        const fits = e.memoryMb <= config.memoryBudgetMb;
        console.log(`${installed ? '*' : ' '} ${e.id.padEnd(18)} ${(e.sizeBytes / 1024 ** 3).toFixed(1).padStart(5)} GB download  ${(e.memoryMb / 1024).toFixed(0).padStart(3)} GB memory  ${fits ? '' : '(too big for this machine) '}${e.role}`);
      }
      console.log(`\n* installed. Memory budget here: ${(config.memoryBudgetMb / 1024).toFixed(0)} GB.`);
      const used = Object.entries(config.roleModels);
      console.log(`Default model: ${config.defaultModel ?? 'none'}${used.length ? `; per role/kind: ${used.map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
      return;
    }
    case 'pull': {
      if (ids.length === 0) throw new Error('usage: gab-node models pull <id...>');
      const entries = ids.map((id) => catalogEntry(id));
      for (const e of entries) {
        if (e.memoryMb > config.memoryBudgetMb) throw new Error(`${e.id} needs ${e.memoryMb} MB, more than this machine's budget of ${config.memoryBudgetMb} MB`);
      }
      for (const e of entries) {
        process.stderr.write(`${e.id}: downloading ${e.file}\n`);
        const outcome = await downloadModel(dir, e, {
          onProgress: (done, total) => process.stderr.write(`\r${e.id}: ${((done / total) * 100).toFixed(1)}% of ${(total / 1024 ** 3).toFixed(1)} GB`),
        });
        process.stderr.write(`\n${e.id}: ${outcome === 'downloaded' ? 'downloaded and verified' : 'already installed'}\n`);
        addModel(config, e.id, e.memoryMb);
      }
      config.modelServer.mode = 'managed';
      await saveConfig(config);
      if (!(await has(config.modelServer.binary))) console.log(`Note: ${config.modelServer.binary} not found on PATH; the installer sets it up (or set modelServer.binary in the config).`);
      console.log(`Models: ${config.models.map((m) => m.id).join(', ')}; default: ${config.defaultModel}`);
      return;
    }
    case 'verify': {
      const e = catalogEntry(ids[0] ?? '');
      console.log((await verifyModel(dir, e)) ? `${e.id}: OK` : `${e.id}: hash mismatch, file removed (pull it again)`);
      return;
    }
    case 'remove': {
      const e = catalogEntry(ids[0] ?? '');
      await rm(modelPath(dir, e), { force: true });
      await rm(`${modelPath(dir, e)}.verified`, { force: true });
      config.models = config.models.filter((m) => m.id !== e.id);
      if (config.defaultModel === e.id) config.defaultModel = config.models[0]?.id ?? null;
      config.roleModels = Object.fromEntries(Object.entries(config.roleModels).filter(([, id]) => id !== e.id));
      await saveConfig(config);
      console.log(`${e.id} removed`);
      return;
    }
    case 'use': {
      const [key, model] = ids;
      const valid = [...Role.options, ...TaskKind.options] as string[];
      if (!key || !model || !valid.includes(key)) throw new Error(`usage: gab-node models use <${valid.join('|')}> <model-id | --clear>`);
      const slot = key as keyof NodeConfig['roleModels'];
      if (model === '--clear') delete config.roleModels[slot];
      else {
        if (!config.models.some((m) => m.id === model)) throw new Error(`${model} is not installed on this node (installed: ${config.models.map((m) => m.id).join(', ') || 'none'}); gab-node models pull ${model}`);
        config.roleModels[slot] = model;
      }
      await saveConfig(config);
      console.log(model === '--clear' ? `${key}: back to the default model (${config.defaultModel ?? 'none'})` : `${key} tasks now use ${model} (unless a task names its own model)`);
      return;
    }
    default:
      throw new Error('usage: gab-node models list | pull <id...> | verify <id> | remove <id> | use <role|kind> <id|--clear> | detect');
  }
}

export function addModel(config: NodeConfig, id: string, memoryMb: number): void {
  config.models = [...config.models.filter((m) => m.id !== id), { id, memoryMb, backend: 'local' }];
  config.defaultModel ??= id;
}

/** Host for "managed" mode: the configured models that are installed and verified. */
export async function managedHost(config: NodeConfig, dir = modelsDir()): Promise<LlamaServerHost> {
  const models: HostedModel[] = [];
  for (const m of config.models.filter((x) => x.backend === 'local')) {
    const e = CATALOG.find((c) => c.id === m.id);
    if (!e) throw new Error(`model ${m.id} in the config is not in the catalog`);
    if (!(await isInstalled(dir, e))) throw new Error(`model ${m.id} is not installed or not verified: gab-node models pull ${m.id}`);
    models.push({ id: e.id, file: modelPath(dir, e), memoryMb: e.memoryMb, contextSize: e.contextSize, serverArgs: e.serverArgs });
  }
  return new LlamaServerHost({
    command: [config.modelServer.binary], models, budgetMb: config.memoryBudgetMb,
    basePort: config.modelServer.basePort, idleMs: config.modelServer.idleMinutes * 60_000,
  });
}
