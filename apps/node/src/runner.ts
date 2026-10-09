import type { TaskKind, TaskResult, TaskSpec } from '@gab-ai-node/protocol';
import type { NodeConfig } from './config.js';

export interface TaskContext {
  task: TaskSpec;
  config: NodeConfig;
  /** Primary repo worktree (the agent works here). */
  workdir: string;
  /** Extra repos, read-only by convention (tools refuse writes there). */
  extraDirs: Record<string, string>;
  /** Aborted when the task is cancelled, its lease is lost, its time budget ends, or the node stops. */
  signal: AbortSignal;
  /** Records a progress event (sent to the coordinator in batches). */
  emit(type: 'log' | 'progress' | 'tool_call' | 'tool_result' | 'message', data: Record<string, unknown>): void;
  /** OpenAI-compatible endpoint serving `model` (starts it if the node manages the model server). */
  modelEndpoint(model: string): Promise<string>;
  secrets: { github: string | null; anthropic: string | null };
  /**
   * Commits all changes in workdir and pushes them to the task's agent branch.
   * Throws when the task may not push. Returns the commit, or null if nothing changed.
   */
  commitAndPush(message: string): Promise<string | null>;
}

/** Does the work of some task kinds. Step 3 adds the agent runner. */
export interface TaskRunner {
  kinds: TaskKind[];
  run(ctx: TaskContext): Promise<TaskResult>;
}

/** Thrown by a runner for failures worth retrying elsewhere or later (model server down, network). */
export class RetryableError extends Error {}
