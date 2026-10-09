import os from 'node:os';
import path from 'node:path';

/** Per-OS data folder of the node (config, repo mirrors, worktrees). GAB_NODE_HOME overrides it. */
export function dataDir(): string {
  if (process.env.GAB_NODE_HOME) return path.resolve(process.env.GAB_NODE_HOME);
  switch (process.platform) {
    case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support', 'gab-ai-node');
    case 'win32': return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'gab-ai-node');
    default: return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'gab-ai-node');
  }
}

export const configFile = () => path.join(dataDir(), 'config.json');
export const pauseFile = () => path.join(dataDir(), 'paused');
export const reposDir = () => path.join(dataDir(), 'repos');
export const workDir = () => path.join(dataDir(), 'work');
export const modelsDir = () => path.join(dataDir(), 'models');
