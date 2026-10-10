import type { Role, TaskKind } from '@gab-ai-node/protocol';
import { CATALOG } from './catalog.js';

/** Kinds that look at screenshots: they go to the vision model whatever their role is. */
const VISION_KINDS: ReadonlySet<string> = new Set<TaskKind>(['test_web', 'test_electron']);

/**
 * The model a task runs on. Which model serves what is fixed in the catalog (`useFor`); a node only
 * chooses among the catalog models it has installed, so a small node falls back to what it has.
 *   1. the model the task names (only a catalog model; anything else gives null)
 *   2. for a screenshot task (test_web, test_electron): the vision model
 *   3. the model for the task's role (security, frontend, ...), then for its kind (ask, custom, ...)
 *      (a role beats a kind: it says what the work is about)
 *   4. the first installed catalog model (the fast model on any node that has it)
 */
export function modelFor(
  task: { model: string | null; role: Role | null; kind: TaskKind },
  installed: readonly string[],
): string | null {
  if (task.model) return CATALOG.some((e) => e.id === task.model) ? task.model : null;
  const serving = (slot: string) => CATALOG.find((e) => installed.includes(e.id) && e.useFor.includes(slot))?.id;
  return (VISION_KINDS.has(task.kind) ? serving(task.kind) : undefined)
    ?? (task.role ? serving(task.role) : undefined)
    ?? serving(task.kind)
    ?? fallbackModel(installed);
}

/** The model for work that names none and has no specific model: the first installed catalog model. */
export function fallbackModel(installed: readonly string[]): string | null {
  return CATALOG.find((e) => installed.includes(e.id))?.id ?? null;
}

/**
 * Kinds this node would run on a stand-in: the catalog names a model for the kind, but this node has not
 * installed it (e.g. a bug hunt on a node without gpt-oss-120b). The backend gives these to a node that
 * has the right model first (ClaimRequest.deferKinds).
 */
export function deferredKinds(kinds: readonly TaskKind[], installed: readonly string[]): TaskKind[] {
  return kinds.filter((k) => {
    const designated = CATALOG.filter((e) => e.useFor.includes(k));
    return designated.length > 0 && !designated.some((e) => installed.includes(e.id));
  });
}

/** True when the model can read images. */
export const isVisionModel = (id: string): boolean => CATALOG.some((e) => e.id === id && e.vision === true);
