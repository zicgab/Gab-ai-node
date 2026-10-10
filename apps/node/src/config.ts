import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Backend, ModelInfo, NodeName, RepoName, Role, TaskKind } from '@gab-ai-node/protocol';
import { log } from './log.js';
import { CATALOG } from './models/catalog.js';
import { configFile } from './paths.js';

/**
 * Images pinned to a digest (tag kept for reading): a re-pushed tag cannot change what runs.
 * Bump them together with a test run (gab-node eval, and one scan / test_web task).
 */
export const IMAGES = {
  sandbox: 'node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5',
  semgrep: 'semgrep/semgrep:1.180.0@sha256:529ee8a277ec8adc5b534d7c74eea0a47e9de21d62852b6ba7ac6ba9566845c3',
  gitleaks: 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f',
  web: 'mcr.microsoft.com/playwright:v1.48.2-jammy@sha256:96dc479be9a603227fafc7126bd7d5e8152ae3e63749f377b2c49a4314b28ae1',
} as const;

/** Old unpinned defaults saved in existing config files: replaced by the pinned ones when loading. */
const LEGACY_IMAGES: Record<string, string> = {
  'node:20-bookworm': IMAGES.sandbox,
  'semgrep/semgrep:latest': IMAGES.semgrep,
  'ghcr.io/gitleaks/gitleaks:latest': IMAGES.gitleaks,
  'mcr.microsoft.com/playwright:v1.48.2-jammy': IMAGES.web,
};

export const NodeConfig = z.object({
  coordinatorUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), 'http(s) URL'),
  name: NodeName,
  /** Models this node can serve, with the memory each needs loaded. */
  models: z.array(ModelInfo).default([]),
  /**
   * The node starts llama-server itself, one process per model, on demand (see models/server.ts); the binary is the one
   * the installer puts in the data folder (llamaServerBin). Which model serves which task is fixed in models/catalog.ts.
   */
  modelServer: z.object({
    basePort: z.number().int().min(1024).max(65000).default(8180),
    idleMinutes: z.number().int().min(1).max(24 * 60).default(10),
  }).default({}),
  /** Docker sandbox for commands (bug_hunt, fix_finding, tests). AGENT.md "image:" overrides the image. */
  sandbox: z.object({
    image: z.string().min(1).default(IMAGES.sandbox),
    /** Images of the scan task's scanners (pinned by default; see IMAGES). */
    scannerImages: z.object({
      semgrep: z.string().min(1).default(IMAGES.semgrep),
      gitleaks: z.string().min(1).default(IMAGES.gitleaks),
    }).default({}),
    /** Image of test_web tasks: Chromium and its system libraries (the Playwright version in agent/web-runner.ts must match its tag). */
    webImage: z.string().min(1).default(IMAGES.web),
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
  /** No task is claimed while the disk holding repos and worktrees has less free space than this. */
  minFreeDiskMb: z.number().int().min(0).default(10_240),
  /** Repo mirrors not fetched for this many days are deleted at start (fetched again if needed). */
  mirrorMaxAgeDays: z.number().int().min(1).max(3650).default(30),
  /** Take tasks while the computer runs on battery (asked at install; "gab-node settings battery on|off"). */
  runOnBattery: z.boolean().default(false),
  /** No new task while the whole machine uses more CPU / memory than this (percent). */
  maxCpuPercent: z.number().int().min(10).max(100).default(80),
  maxMemoryPercent: z.number().int().min(10).max(100).default(80),
  maxConcurrent: z.number().int().min(1).max(32).default(1),
  /** Start Docker when it is not running (macOS, Windows; Linux rootless only). Set with: gab-node settings docker-autostart on|off. */
  dockerAutoStart: z.boolean().default(true),
  /** Memory the models may use together; default 75% of RAM (unified memory on Apple Silicon). */
  memoryBudgetMb: z.number().int().positive().default(Math.floor((os.totalmem() / 1024 / 1024) * 0.75)),
});
export type NodeConfig = z.infer<typeof NodeConfig>;

/** Settings of earlier versions (external model servers, per-node model choice); ignored when found in an old config. */
const REMOVED_KEYS = ['defaultModel', 'roleModels', 'visionModels', 'modelEndpoint', 'modelEndpoints'];

export async function loadConfig(file = configFile()): Promise<NodeConfig> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch { throw new Error(`no config at ${file}: run "gab-node register" first`); }
  const json = JSON.parse(raw) as Record<string, unknown>;
  const ms = (json.modelServer ?? {}) as Record<string, unknown>;
  const removed = [...REMOVED_KEYS.filter((k) => k in json), ...['mode', 'binary'].filter((k) => k in ms).map((k) => `modelServer.${k}`)];
  // Gone from the file at the next save of the config.
  if (removed.length) log.warn('config.json has settings the node no longer uses (llama-server is the only model engine and the model for each task is fixed): ignored', { settings: removed });
  const parsed = NodeConfig.safeParse(upgradeImages(json));
  if (!parsed.success) {
    throw new Error(`invalid ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return dropUnknownModels(parsed.data);
}

/** Models of earlier versions (Ollama / LM Studio names) are not in the catalog: the node does not know them, so they are dropped with a warning. */
export function dropUnknownModels(config: NodeConfig): NodeConfig {
  const unknown = config.models.filter((m) => m.backend === 'local' && !CATALOG.some((e) => e.id === m.id));
  if (unknown.length === 0) return config;
  log.warn('config.json lists models this node does not know: ignored (the models of this node are fixed, install them with: gab-node models pull --all)', { models: unknown.map((m) => m.id), known: CATALOG.map((e) => e.id) });
  return { ...config, models: config.models.filter((m) => !unknown.includes(m)) };
}

/** Swaps old unpinned default images in a saved config for the pinned ones (images you chose yourself are kept). */
export function upgradeImages(raw: unknown): unknown {
  const sb = (raw as { sandbox?: Record<string, unknown> } | null)?.sandbox;
  if (!sb || typeof sb !== 'object') return raw;
  const swap = (v: unknown) => (typeof v === 'string' && LEGACY_IMAGES[v]) || v;
  sb.image = swap(sb.image);
  sb.webImage = swap(sb.webImage);
  const sc = sb.scannerImages as Record<string, unknown> | undefined;
  if (sc && typeof sc === 'object') { sc.semgrep = swap(sc.semgrep); sc.gitleaks = swap(sc.gitleaks); }
  return raw;
}

/** Writes through a temp file then renames, so a crash never leaves half a config. */
export async function saveConfig(config: NodeConfig, file = configFile()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.new`;
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
