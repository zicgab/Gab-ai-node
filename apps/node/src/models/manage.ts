// gab-node models manage: the catalog models on this machine, and download / verify / remove them. Terminal only.
import { createInterface } from 'node:readline/promises';
import { loadConfig, saveConfig } from '../config.js';
import { modelsDir } from '../paths.js';
import { CATALOG, catalogEntry, catalogFiles, totalBytes } from './catalog.js';
import { addModel, installedIds, removeModel } from './commands.js';
import { downloadModel, isInstalled, verifyModel } from './download.js';

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

export async function manageCommand(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('models manage needs a terminal (use: gab-node models list | pull | verify | remove)');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const config = await loadConfig();
      const dir = modelsDir();
      console.log(`\nMemory budget: ${(config.memoryBudgetMb / 1024).toFixed(0)} GB\n`);
      for (const [i, e] of CATALOG.entries()) {
        const state = (await isInstalled(dir, e)) ? 'installed' : e.memoryMb > config.memoryBudgetMb ? 'too big for this machine' : 'not installed';
        console.log(`${i + 1}. ${e.id.padEnd(16)} ${gb(totalBytes(e)).padStart(5)} GB  ${state.padEnd(24)} ${e.role}`);
      }
      const answer = (await rl.question('\n[p]ull / [v]erify / [r]emove <number>, or q to quit: ')).trim().toLowerCase();
      if (answer === 'q' || answer === '') return;
      const [action, n] = answer.split(/\s+/);
      const entry = CATALOG[Number(n) - 1];
      if (!entry || !['p', 'v', 'r'].includes(action ?? '')) { console.log('Type p, v or r and a model number, e.g. "p 1".'); continue; }
      try {
        if (action === 'p') {
          if (entry.memoryMb > config.memoryBudgetMb) { console.log(`${entry.id} needs ${entry.memoryMb} MB, more than this machine's budget.`); continue; }
          await downloadModel(dir, catalogEntry(entry.id), {
            onProgress: (done, total, file) => process.stdout.write(`\r${file} ${((done / total) * 100).toFixed(1)}% of ${gb(total)} GB`),
          });
          addModel(config, entry.id, entry.memoryMb);
          await saveConfig(config);
          console.log(`\n${entry.id} installed (${catalogFiles(entry).length} file${catalogFiles(entry).length > 1 ? 's' : ''}).`);
        } else if (action === 'v') {
          console.log((await verifyModel(dir, entry)) ? `${entry.id}: OK` : `${entry.id}: hash mismatch or missing file, removed`);
        } else {
          if (!installedIds(config).includes(entry.id)) { console.log(`${entry.id} is not installed.`); continue; }
          if (/^y/i.test(await rl.question(`Delete ${entry.id} from disk? [y/N] `))) {
            await removeModel(config, dir, entry);
            await saveConfig(config);
            console.log(`${entry.id} removed.`);
          }
        }
      } catch (err) { console.log(`Failed: ${(err as Error).message}`); }
    }
  } finally { rl.close(); }
}
