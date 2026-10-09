import type { ModelInfo } from '@gab-ai-node/protocol';

/**
 * Models that can start now: a model already in use by a running task is
 * shared (no extra memory); another must fit in what the running ones leave.
 */
export function modelsThatFit(models: ModelInfo[], runningModels: string[], budgetMb: number): string[] {
  const inUse = new Set(runningModels);
  const used = models.filter((m) => inUse.has(m.id)).reduce((sum, m) => sum + m.memoryMb, 0);
  return models.filter((m) => m.backend !== 'local' || inUse.has(m.id) || used + m.memoryMb <= budgetMb).map((m) => m.id);
}
