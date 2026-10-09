// Maestro flows for test_mobile. The model never writes YAML: it gives a list of steps
// (JSON, checked by this schema) and this file writes the YAML. So a flow can only contain
// the commands listed here: no scripts (runScript/evalScript), no links, no sub-flows.
import { z } from 'zod';

const text = z.string().min(1).max(200);
const target = (action: string) => z.object({ action: z.literal(action), text: text.optional(), id: text.optional() }).strict()
  .refine((t) => (t.text === undefined) !== (t.id === undefined), { message: 'give exactly one of text or id' });

/** One schema per allowed action; strict, so an extra key (a smuggled option) is an error. */
const SCHEMAS = {
  launchApp: z.object({ action: z.literal('launchApp'), clearState: z.boolean().optional() }).strict(),
  tapOn: target('tapOn'),
  inputText: z.object({ action: z.literal('inputText'), text }).strict(),
  assertVisible: target('assertVisible'),
  assertNotVisible: target('assertNotVisible'),
  scroll: z.object({ action: z.literal('scroll') }).strict(),
  swipe: z.object({ action: z.literal('swipe'), direction: z.enum(['UP', 'DOWN', 'LEFT', 'RIGHT']) }).strict(),
  back: z.object({ action: z.literal('back') }).strict(),
  pressKey: z.object({ action: z.literal('pressKey'), key: z.enum(['Enter', 'Backspace', 'Home', 'Back']) }).strict(),
  waitForAnimationToEnd: z.object({ action: z.literal('waitForAnimationToEnd') }).strict(),
  takeScreenshot: z.object({ action: z.literal('takeScreenshot'), name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict(),
} as const;
export const ACTIONS = Object.keys(SCHEMAS);
export type FlowStep =
  | { action: 'launchApp'; clearState?: boolean | undefined }
  | { action: 'tapOn' | 'assertVisible' | 'assertNotVisible'; text?: string | undefined; id?: string | undefined }
  | { action: 'inputText'; text: string }
  | { action: 'swipe'; direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' }
  | { action: 'pressKey'; key: 'Enter' | 'Backspace' | 'Home' | 'Back' }
  | { action: 'takeScreenshot'; name: string }
  | { action: 'scroll' | 'back' | 'waitForAnimationToEnd' };

export const MAX_STEPS = 60;
export const FlowName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes');
export const AppId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{1,150}$/, 'a bundle id or package name like com.example.app');

/** A JSON string is a valid YAML double-quoted scalar. */
const q = (value: string): string => JSON.stringify(value);

function line(step: FlowStep): string {
  switch (step.action) {
    case 'launchApp': return step.clearState ? '- launchApp:\n    clearState: true' : '- launchApp';
    case 'tapOn': case 'assertVisible': case 'assertNotVisible':
      return step.id !== undefined ? `- ${step.action}:\n    id: ${q(step.id)}` : `- ${step.action}: ${q(step.text!)}`;
    case 'inputText': return `- inputText: ${q(step.text)}`;
    case 'swipe': return `- swipe:\n    direction: ${step.direction}`;
    case 'pressKey': return `- pressKey: ${step.key}`;
    case 'takeScreenshot': return `- takeScreenshot: ${q(step.name)}`;
    case 'scroll': case 'back': case 'waitForAnimationToEnd': return `- ${step.action}`;
  }
}

/** The flow file for these steps; throws a one-line error naming the step that the schema refuses. */
export function buildFlow(appId: string, steps: unknown): string {
  const app = AppId.parse(appId);
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) throw new Error(`steps must be a list of 1-${MAX_STEPS} steps`);
  const checked = steps.map((raw, i): FlowStep => {
    const action = (raw as { action?: unknown } | null)?.action;
    const schema = typeof action === 'string' && Object.hasOwn(SCHEMAS, action) ? SCHEMAS[action as keyof typeof SCHEMAS] : null;
    if (!schema) throw new Error(`step ${i + 1}: unknown action ${JSON.stringify(action)}; allowed: ${ACTIONS.join(', ')}`);
    const res = schema.safeParse(raw);
    if (!res.success) throw new Error(`step ${i + 1} (${String(action)}): ${res.error.issues[0]!.path.join('.') || 'step'}: ${res.error.issues[0]!.message}`);
    return res.data as FlowStep;
  });
  return `appId: ${q(app)}\n---\n${checked.map(line).join('\n')}\n`;
}
