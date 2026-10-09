// gab-node models list | pull <id...|--all> | verify <id> | remove <id> | test [id] | manage
// The node knows only the models of catalog.ts. Which one serves which task is fixed (pick.ts).
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, saveConfig, type NodeConfig } from '../config.js';
import { llamaServerBin, modelsDir } from '../paths.js';
import { CATALOG, catalogEntry, catalogFiles, totalBytes, type CatalogEntry } from './catalog.js';
import { downloadModel, isInstalled, mmprojPath, modelPath, verifyModel } from './download.js';
import { manageCommand } from './manage.js';
import { fallbackModel } from './pick.js';
import { LlamaServerHost, type HostedModel } from './server.js';
import { toolSmokeTest } from './smoke.js';

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/** Catalog models this machine can run at all (they fit its memory budget). */
export const fittingModels = (budgetMb: number): CatalogEntry[] => CATALOG.filter((e) => e.memoryMb <= budgetMb);

/** Ids of the models this node has installed. */
export const installedIds = (config: Pick<NodeConfig, 'models'>): string[] => config.models.filter((m) => m.backend === 'local').map((m) => m.id);

async function binaryThere(): Promise<boolean> {
  try { await access(llamaServerBin()); return true; } catch { return false; }
}

export async function modelsCommand(args: string[]): Promise<void> {
  const [sub, ...ids] = args;
  if (sub === 'manage') return manageCommand();
  const config = await loadConfig();
  const dir = modelsDir();
  switch (sub) {
    case 'list': {
      for (const e of CATALOG) {
        const installed = await isInstalled(dir, e);
        const fits = e.memoryMb <= config.memoryBudgetMb;
        console.log(`${installed ? '*' : ' '} ${e.id.padEnd(16)} ${gb(totalBytes(e)).padStart(5)} GB download  ${(e.memoryMb / 1024).toFixed(0).padStart(3)} GB memory  ${fits ? '' : '(too big for this machine) '}${e.role}`);
      }
      console.log(`\n* installed. Memory budget here: ${(config.memoryBudgetMb / 1024).toFixed(0)} GB.`);
      const inUse = installedIds(config);
      console.log(inUse.length ? `Tasks without an installed model of their own use ${fallbackModel(inUse)}.` : 'No model installed: gab-node models pull --all');
      return;
    }
    case 'pull': {
      const entries = ids.includes('--all') ? fittingModels(config.memoryBudgetMb) : ids.map((id) => catalogEntry(id));
      if (entries.length === 0) throw new Error('usage: gab-node models pull <id...> | --all   (ids: gab-node models list)');
      for (const e of entries) {
        if (e.memoryMb > config.memoryBudgetMb) throw new Error(`${e.id} needs ${e.memoryMb} MB, more than this machine's budget of ${config.memoryBudgetMb} MB`);
      }
      for (const e of entries) {
        process.stderr.write(`${e.id}: downloading ${catalogFiles(e).map((f) => f.file).join(' + ')}\n`);
        const outcome = await downloadModel(dir, e, {
          onProgress: (done, total, file) => process.stderr.write(`\r${e.id}: ${file} ${((done / total) * 100).toFixed(1)}% of ${gb(total)} GB`),
        });
        process.stderr.write(`\n${e.id}: ${outcome === 'downloaded' ? 'downloaded and verified' : 'already installed'}\n`);
        addModel(config, e.id, e.memoryMb);
        await saveConfig(config);
      }
      if (!(await binaryThere())) console.log(`Note: llama-server is not at ${llamaServerBin()}: run setup.sh (setup.ps1) or update.sh (update.ps1), which install it.`);
      console.log(`Models: ${installedIds(config).join(', ')}`);
      return;
    }
    case 'verify': {
      const e = catalogEntry(ids[0] ?? '');
      console.log((await verifyModel(dir, e)) ? `${e.id}: OK` : `${e.id}: hash mismatch or missing file, removed (pull it again)`);
      return;
    }
    case 'remove': {
      const e = catalogEntry(ids[0] ?? '');
      await removeModel(config, dir, e);
      await saveConfig(config);
      console.log(`${e.id} removed`);
      return;
    }
    case 'test': {
      const id = ids[0] ?? fallbackModel(installedIds(config));
      if (!id) throw new Error('no model installed: gab-node models pull --all');
      const host = await managedHost(config);
      try {
        console.log(`Checking that ${id} can call tools (loading it can take a minute)...`);
        const { endpoint, release } = await host.acquire(id, new AbortController().signal);
        try {
          const smoke = await toolSmokeTest(endpoint, id);
          console.log(smoke.ok ? `${id}: OK, ${smoke.detail}.` : `${id}: WARNING, ${smoke.detail}. Agent tasks need tool calls.`);
          if (!smoke.ok) process.exitCode = 1;
        } finally { release(); }
      } finally { await host.stop(); }
      return;
    }
    default:
      throw new Error('usage: gab-node models list | pull <id...|--all> | verify <id> | remove <id> | test [id] | manage');
  }
}

/** Deletes the files of a model and forgets it. */
export async function removeModel(config: NodeConfig, dir: string, e: CatalogEntry): Promise<void> {
  for (const f of catalogFiles(e)) {
    const file = path.join(dir, f.file);
    await Promise.all([file, `${file}.verified`, `${file}.part`].map((p) => rm(p, { force: true })));
  }
  config.models = config.models.filter((m) => m.id !== e.id);
}

export function addModel(config: NodeConfig, id: string, memoryMb: number): void {
  config.models = [...config.models.filter((m) => m.id !== id), { id, memoryMb, backend: 'local' }];
}

/** The model servers of the installed catalog models (every file installed and verified). */
export async function managedHost(config: NodeConfig, dir = modelsDir()): Promise<LlamaServerHost> {
  const models: HostedModel[] = [];
  for (const m of config.models.filter((x) => x.backend === 'local')) {
    const e = CATALOG.find((c) => c.id === m.id);
    if (!e) throw new Error(`model ${m.id} in the config is not in the catalog (known: ${CATALOG.map((c) => c.id).join(', ')}): gab-node models remove <id>, or edit config.json`);
    if (!(await isInstalled(dir, e))) throw new Error(`model ${m.id} is not installed or not verified: gab-node models pull ${m.id}`);
    models.push({ id: e.id, file: modelPath(dir, e), mmprojFile: mmprojPath(dir, e), memoryMb: e.memoryMb, contextSize: e.contextSize, serverArgs: e.serverArgs });
  }
  return new LlamaServerHost({
    command: [llamaServerBin()], models, budgetMb: config.memoryBudgetMb,
    basePort: config.modelServer.basePort, idleMs: config.modelServer.idleMinutes * 60_000,
  });
}
