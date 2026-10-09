import { ChatRunner } from './agent/chat-runner.js';
import { ContractRunner } from './agent/contract-runner.js';
import { DocsRunner } from './agent/docs-runner.js';
import { MobileRunner } from './agent/mobile-runner.js';
import { AgentRunner } from './agent/runner.js';
import { ScanRunner } from './agent/scan-runner.js';
import { TranslateRunner } from './agent/translate-runner.js';
import { WebRunner } from './agent/web-runner.js';
import { WorkRunner } from './agent/work-runner.js';
import type { NodeConfig } from './config.js';
import { has } from './exec.js';
import { log } from './log.js';
import type { TaskRunner } from './runner.js';
import type { TaskKind } from '@gab-ai-node/protocol';

/** Kinds that run commands in Docker: held back while Docker is not running (see health.ts). */
export const DOCKER_KINDS: ReadonlySet<TaskKind> = new Set([...new WorkRunner().kinds, ...new WebRunner().kinds, ...new ScanRunner().kinds]);

/** Installed task runners. Kinds that run commands need Docker (never run on the host). */
export async function createRunners(config: Pick<NodeConfig, 'mobile'>): Promise<TaskRunner[]> {
  const runners: TaskRunner[] = [new AgentRunner(), new ChatRunner(), new ContractRunner(), new DocsRunner(), new TranslateRunner()];
  if (await has('docker')) runners.push(new WorkRunner(), new WebRunner(), new ScanRunner());
  else log.warn('docker not found: bug_hunt, fix_finding, custom, test_web and scan are disabled on this node');
  if (config.mobile.enabled) {
    // Runs on the host, so only when asked for in the config, and only when Maestro is there.
    if (await has('maestro')) runners.push(new MobileRunner());
    else log.warn('mobile.enabled is set but maestro is not on PATH: test_mobile is disabled (https://maestro.mobile.dev)');
  }
  return runners;
}
