import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Backend, ModelInfo, NodeName, RepoName, Role, TaskKind } from '@gab-ai-node/protocol';
import { configFile } from './paths.js';

export const NodeConfig = z.object({
  coordinatorUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), 'http(s) URL'),
  name: NodeName,
  /** Models this node can serve, with the memory each needs loaded. */
  models: z.array(ModelInfo).default([]),
  /** Default model when a task does not ask for one. */
  defaultModel: z.string().nullable().default(null),
  /**
   * Model per role (frontend, backend, security, uxui) or per task kind (ask, custom, ...), for tasks that do not name
   * one. A role wins over a kind. Set with "gab-node models use <role|kind> <model-id>".
   */
  roleModels: z.record(z.enum([...Role.options, ...TaskKind.options]), z.string().min(1)).default({}),
  /** OpenAI-compatible endpoint of the local model server (llama-server), localhost only. */
  modelEndpoint: z.string().url().default('http://127.0.0.1:8080/v1'),
  /**
   * external: I run the model server myself at modelEndpoint.
   * managed: the node starts llama-server per model on demand (models from "gab-node models pull").
   */
  modelServer: z.object({
    mode: z.enum(['external', 'managed']).default('external'),
    binary: z.string().min(1).default('llama-server'),
    basePort: z.number().int().min(1024).max(65000).default(8180),
    idleMinutes: z.number().int().min(1).max(24 * 60).default(10),
  }).default({}),
  /** Docker sandbox for commands (bug_hunt, fix_finding, tests). AGENT.md "image:" overrides the image. */
  sandbox: z.object({
    image: z.string().min(1).default('node:20-bookworm'),
    /** Images of the scan task's scanners. Official images; pin them to a digest (name@sha256:...) for production. */
    scannerImages: z.object({
      semgrep: z.string().min(1).default('semgrep/semgrep:latest'),
      gitleaks: z.string().min(1).default('ghcr.io/gitleaks/gitleaks:latest'),
    }).default({}),
    /** Image of test_web tasks: Chromium and its system libraries (the Playwright version in agent/web-runner.ts must match its tag). */
    webImage: z.string().min(1).default('mcr.microsoft.com/playwright:v1.48.2-jammy'),
    memoryMb: z.number().int().min(512).default(8192),
    cpus: z.number().positive().max(64).default(4),
    cmdTimeoutMinutes: z.number().int().min(1).max(120).default(15),
    setupTimeoutMinutes: z.number().int().min(1).max(120).default(20),
  }).default({}),
  /**
   * test_mobile: Maestro on the simulator/emulator, run on THIS machine (not in Docker), so it is off by default
   * and only for the repos listed here. Build command and app path are set by the node's owner, never read from the repo.
   */
  mobile: z.object({
    enabled: z.boolean().default(false),
    platform: z.enum(['ios', 'android']).default('ios'),
    apps: z.record(RepoName, z.object({
      /** Optional host command that builds the app (runs in the task's checkout). */
      build: z.string().min(1).max(500).nullable().default(null),
      buildTimeoutMinutes: z.number().int().min(1).max(180).default(45),
      /** Built .app (iOS simulator) or .apk, relative to the checkout. */
      app: z.string().min(1).max(300),
      /** Bundle id (iOS) or package name (Android). */
      appId: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{1,150}$/),
    })).default({}),
  }).default({}),
  backends: z.array(Backend).min(1).default(['local']),
  maxConcurrent: z.number().int().min(1).max(32).default(1),
  /** Memory the models may use together; default 75% of RAM (unified memory on Apple Silicon). */
  memoryBudgetMb: z.number().int().positive().default(Math.floor((os.totalmem() / 1024 / 1024) * 0.75)),
});
export type NodeConfig = z.infer<typeof NodeConfig>;

export async function loadConfig(file = configFile()): Promise<NodeConfig> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch { throw new Error(`no config at ${file}: run "gab-node register" first`); }
  const parsed = NodeConfig.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`invalid ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

/** Writes through a temp file then renames, so a crash never leaves half a config. */
export async function saveConfig(config: NodeConfig, file = configFile()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.new`;
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
