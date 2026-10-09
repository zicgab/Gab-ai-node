// Wire protocol between the coordinator and the nodes, shared by both sides.
// Every request body is parsed with these schemas at the boundary; nothing
// past the parse trusts the raw JSON.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** A claim lease lasts this long; every heartbeat extends it this far again. */
export const LEASE_SECONDS = 120;
/** How often a node heartbeats (well under the lease). */
export const HEARTBEAT_SECONDS = 30;
/** Longest a claim request waits for work before answering "nothing". */
export const CLAIM_WAIT_SECONDS = 25;
/** A task is retried after a lost lease or retryable failure at most this many times. */
export const MAX_ATTEMPTS = 3;

export const TaskKind = z.enum(['ask', 'bug_hunt', 'fix_finding', 'test_web', 'test_mobile', 'translate', 'custom', 'eval', 'chat', 'scan', 'contract_check', 'test_electron']);
export type TaskKind = z.infer<typeof TaskKind>;
/** Kinds that run commands (tests, builds) in the node's sandbox: the repo must allow running. */
export const RUN_KINDS: readonly TaskKind[] = ['bug_hunt', 'fix_finding', 'test_web', 'test_electron', 'test_mobile', 'scan', 'custom', 'eval'];

export const TaskState = z.enum(['queued', 'claimed', 'running', 'completed', 'failed', 'cancelled']);
export type TaskState = z.infer<typeof TaskState>;
export const FINAL_STATES: readonly TaskState[] = ['completed', 'failed', 'cancelled'];

/** What kind of reviewer the node plays; the checklist of each is in apps/node/src/agent/roles.ts. */
export const Role = z.enum(['frontend', 'backend', 'security', 'uxui']);
export type Role = z.infer<typeof Role>;

export const Backend = z.enum(['local', 'anthropic-api', 'claude-code']);
export type Backend = z.infer<typeof Backend>;

const id = z.string().uuid();
const shortText = (max: number) => z.string().trim().min(1).max(max);

/** owner/name of a GitHub repo. */
export const RepoName = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, 'expected owner/name');
/** Node names: lowercase, digits, dashes (used in branch names). */
export const NodeName = z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'lowercase letters, digits and dashes, 2-49 chars');

export const ModelInfo = z.object({
  id: shortText(120),
  /** Memory the model needs when loaded, used for the memory-fit check. */
  memoryMb: z.number().int().positive(),
  backend: Backend.default('local'),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const Capabilities = z.object({
  agentVersion: shortText(64),
  os: z.enum(['darwin', 'linux', 'win32']),
  arch: shortText(32),
  cpu: shortText(200),
  memoryMb: z.number().int().nonnegative(),
  freeDiskMb: z.number().int().nonnegative(),
  gpu: z.string().max(200).nullable().default(null),
  models: z.array(ModelInfo).max(100),
  /** Tools found on the node (git, docker, node, playwright, xcode, android, ...). */
  tools: z.array(shortText(40)).max(100),
  maxConcurrent: z.number().int().min(1).max(32).default(1),
});
export type Capabilities = z.infer<typeof Capabilities>;

/** Answer of POST /node/agent/register (gasysteme ai-worker/nodes.js): the node's own token, shown once. */
export const RegisterResponse = z.object({ name: NodeName, project: z.literal('agent'), created: z.boolean(), token: z.string().min(32) });
export type RegisterResponse = z.infer<typeof RegisterResponse>;

export const ClaimRequest = z.object({
  /** Models whose memory fits right now (the node does the fit check); tasks needing another model are not handed out. */
  acceptModels: z.array(shortText(120)).max(100),
  /** Task kinds this node can run (depends on its tools). */
  acceptKinds: z.array(TaskKind).min(1),
  /** Backends configured on this node (anthropic-api needs a key, claude-code the CLI). */
  acceptBackends: z.array(Backend).min(1),
  wait: z.boolean().default(true),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

export const TaskSpec = z.object({
  id,
  kind: TaskKind,
  /** Null for a chat message (a chat has no repo). */
  repo: RepoName.nullable(),
  extraRepos: z.array(RepoName).max(10),
  ref: z.string().max(200).nullable(),
  instructions: z.string().max(20_000),
  backend: Backend,
  model: z.string().max(120).nullable(),
  budget: z.object({
    maxSteps: z.number().int().positive(),
    maxMinutes: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
  }),
  /** Branch the node may push to (only agent/**), null when the task may not push. */
  branch: z.string().max(250).nullable(),
  findingId: id.nullable(),
  attempt: z.number().int().min(1),
  role: Role.nullable().default(null),
  /** Folders of the repo the task may read and change; empty = the whole repo. */
  paths: z.array(z.string().max(200)).max(10).default([]),
  /** Chat messages only: the chat's system message and its earlier turns (the node keeps no state). */
  chat: z.object({
    system: z.string().nullable(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
  }).nullable().default(null),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

/** Short-lived GitHub App token scoped to the task's repos (write only when the task has a branch). */
export const GithubToken = z.object({ token: z.string().min(10), expiresAt: z.string(), canPush: z.boolean() });
export type GithubToken = z.infer<typeof GithubToken>;

export const ClaimResponse = z.object({
  task: TaskSpec.nullable(),
  /** Null when the coordinator has no GitHub App configured (the node then uses its own read token). */
  github: GithubToken.nullable().default(null),
  leaseId: id.nullable(),
  leaseSeconds: z.number().int(),
  heartbeatSeconds: z.number().int(),
  /** False when the node is paused (by itself, by me, or pause_all): it should not claim until available again. */
  available: z.boolean(),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const HeartbeatRequest = z.object({
  capabilities: Capabilities.optional(),
  running: z.array(z.object({ taskId: id, leaseId: id })).max(32),
});
export const HeartbeatResponse = z.object({
  /** Running tasks still held; the node must stop any task listed in cancel (cancelled or lease lost). */
  held: z.array(id),
  cancel: z.array(id),
  available: z.boolean(),
  leaseSeconds: z.number().int(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const TaskEventType = z.enum(['log', 'progress', 'tool_call', 'tool_result', 'message']);
export const TaskEventsRequest = z.object({
  leaseId: id,
  events: z.array(z.object({ type: TaskEventType, data: z.record(z.unknown()) })).min(1).max(100),
});

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export const Finding = z.object({
  title: shortText(300),
  severity: Severity,
  file: z.string().max(500).nullable(),
  line: z.number().int().positive().nullable(),
  /** Proof: failing test, command and its output, or reproduction steps. Required. */
  evidence: shortText(20_000),
  suggestedFix: z.string().max(20_000).nullable(),
  /** Stable key for dedup across runs (node computes from repo, file, rule, normalized title). */
  fingerprint: z.string().regex(/^[a-f0-9]{16,64}$/),
});
export type Finding = z.infer<typeof Finding>;

export const TaskResult = z.object({
  summary: shortText(5_000),
  answer: z.string().max(50_000).nullable().default(null),
  branch: z.string().max(250).nullable().default(null),
  commits: z.array(z.string().regex(/^[a-f0-9]{7,40}$/)).max(200).default([]),
  findings: z.array(Finding).max(200).default([]),
  usage: z.object({ steps: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(), model: z.string().max(120).nullable() }),
});
export type TaskResult = z.infer<typeof TaskResult>;

export const CompleteRequest = z.object({ leaseId: id, result: TaskResult });
export const FailRequest = z.object({ leaseId: id, error: shortText(4_000), retryable: z.boolean() });

/** True when branch is a branch agents may push: agent/<node>/<rest>. */
export function isAgentBranch(branch: string): boolean {
  return /^agent\/[a-z0-9][a-z0-9-]{1,48}\/[A-Za-z0-9._-]{1,150}$/.test(branch) && !branch.includes('..');
}
