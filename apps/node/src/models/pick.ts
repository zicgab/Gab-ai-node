import type { Role, TaskKind } from '@gab-ai-node/protocol';
import type { NodeConfig } from '../config.js';

/**
 * The model a task runs on: the one the task names, else the node's model for its
 * role (security, frontend, ...), else for its kind (custom, ask, ...), else the
 * node's default. A role beats a kind: it says what the work is about.
 */
export function modelFor(
  task: { model: string | null; role: Role | null; kind: TaskKind },
  config: Pick<NodeConfig, 'roleModels' | 'defaultModel'>,
): string | null {
  return task.model
    ?? (task.role ? config.roleModels[task.role] : undefined)
    ?? config.roleModels[task.kind]
    ?? config.defaultModel;
}
