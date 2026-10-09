import { statfs } from 'node:fs/promises';
import os from 'node:os';
import type { Capabilities } from '@gab-ai-node/protocol';
import type { NodeConfig } from './config.js';
import { dataDir } from './paths.js';
import { exec, has } from './exec.js';
import { log } from './log.js';

export const AGENT_VERSION = '0.1.0';

/** Tools a task kind may need; reported so the coordinator and I can see what a node can do. */
const TOOLS = ['git', 'rg', 'docker', 'node', 'npm', 'python3', 'claude', 'xcodebuild', 'adb', 'ffmpeg'];

async function gpu(): Promise<string | null> {
  if (process.platform === 'darwin' && os.arch() === 'arm64') return os.cpus()[0]?.model ?? 'Apple Silicon';
  try {
    const r = await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeoutMs: 5000 });
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().split('\n').join('; ');
  } catch { /* no NVIDIA driver */ }
  return null;
}

async function freeDiskMb(): Promise<number> {
  try {
    const s = await statfs(dataDir());
    return Math.floor((s.bavail * s.bsize) / 1024 / 1024);
  } catch (err) {
    log.warn('could not read free disk space', { err });
    return 0;
  }
}

export async function detectCapabilities(config: NodeConfig): Promise<Capabilities> {
  const tools: string[] = [];
  for (const t of TOOLS) if (await has(t)) tools.push(t);
  return {
    agentVersion: AGENT_VERSION,
    os: process.platform as Capabilities['os'],
    arch: os.arch(),
    cpu: (os.cpus()[0]?.model ?? 'unknown').slice(0, 200),
    memoryMb: Math.floor(os.totalmem() / 1024 / 1024),
    freeDiskMb: await freeDiskMb(),
    gpu: await gpu(),
    models: config.models,
    tools,
    maxConcurrent: config.maxConcurrent,
  };
}
