// The agent loop: the model reads the task, calls tools, gets their results,
// until it answers without a tool call or the step/token budget runs out.
// Two guards against a local model's usual failures: repeating the same read over and over (it
// burns the whole token budget and no report comes out), and concluding after a quick look.
import type { ChatMessage, ModelBackend, ToolSchema } from '../backends/types.js';
import type { ToolDef } from './tools.js';

export type StoppedBy = 'answer' | 'steps' | 'tokens' | 'repeating';
export interface AgentRun { answer: string; steps: number; tokens: number; stoppedBy: StoppedBy; filesRead: number }

/** " (stopped by ...)" for a result summary; empty when the model answered by itself. */
export function stopNote(run: Pick<AgentRun, 'stoppedBy'>): string {
  if (run.stoppedBy === 'answer') return '';
  return run.stoppedBy === 'repeating' ? ' (stopped: the model kept repeating the same calls)' : ` (stopped by ${run.stoppedBy} budget)`;
}

/** Read-only tools: the same call gives the same answer, so a repeat is answered without running it. */
const REPEATABLE = new Set(['read_file', 'list_dir', 'grep', 'search_code']);
/** Steps in a row in which every call was a repeat: a nudge at the first number, the final answer is forced at the second. */
const NUDGE_AFTER_REPEATS = 3;
const STOP_AFTER_REPEATS = 6;
/** How often a too-early answer is sent back (then it is accepted, a small repo may really have few files). */
const MAX_COVERAGE_NUDGES = 2;

/**
 * The model's window is 65,536 tokens and every tool output stays in the conversation, so a long
 * run overflows it (two hunts died with HTTP 400 at 65,550 and 68,045 tokens). Past this estimate the
 * oldest outputs are replaced by a one-line note; the model can make the call again.
 */
const CONTEXT_SOFT_LIMIT = 40_000;
const KEEP_RECENT_OUTPUTS = [6, 3, 1];
const TRIMMED = '[earlier output of';
const IMAGE_TOKENS = 1_500;
const roughTokens = (m: ChatMessage) => Math.ceil(((m.content ?? '').length + JSON.stringify(m.tool_calls ?? []).length) / 3) + (m.images?.length ?? 0) * IMAGE_TOKENS;

/** Drops the oldest tool outputs (keeping the newest few) until the conversation fits; returns the ids of the calls it dropped. */
function trimOutputs(messages: ChatMessage[], limit: number, describe: Map<string, string>): string[] {
  const total = () => messages.reduce((n, m) => n + roughTokens(m), 0);
  const dropped: string[] = [];
  if (total() <= limit) return dropped;
  for (const keep of KEEP_RECENT_OUTPUTS) {
    const outputs = messages.flatMap((m, i) => (m.role === 'tool' && !(m.content ?? '').startsWith(TRIMMED) ? [i] : []));
    for (const i of outputs.slice(0, Math.max(0, outputs.length - keep))) {
      const m = messages[i]!;
      const id = m.tool_call_id ?? '';
      messages[i] = { ...m, content: `${TRIMMED} ${describe.get(id) ?? 'a tool'}] removed to save space; call it again if you need it.` };
      dropped.push(id);
      if (total() <= limit) return dropped;
    }
  }
  return dropped;
}

const callKey = (name: string, args: Record<string, unknown>) => `${name} ${JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))}`;

export async function runAgent(opts: {
  backend: ModelBackend;
  tools: ToolDef[];
  system: string;
  user: string;
  maxSteps: number;
  maxTokens: number;
  signal: AbortSignal;
  emit: (type: 'tool_call' | 'tool_result' | 'message', data: Record<string, unknown>) => void;
  /** An answer before this many different files were opened with read_file is sent back (up to twice). */
  minFilesRead?: number;
  /** Added to the step number in the events, for a task that runs the loop several times. */
  stepBase?: number;
  /** Estimated conversation size (tokens) past which the oldest tool outputs are dropped. */
  contextTokens?: number;
}): Promise<AgentRun> {
  const schemas: ToolSchema[] = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }];
  const seenReads = new Map<string, number>();
  const filesRead = new Set<string>();
  const describe = new Map<string, string>();
  const keyOfCall = new Map<string, string>();
  const shown = (step: number) => step + (opts.stepBase ?? 0);
  /** Keeps the conversation inside the model's window; a dropped read may be repeated again. */
  const fit = () => {
    for (const id of trimOutputs(messages, opts.contextTokens ?? CONTEXT_SOFT_LIMIT, describe)) {
      const key = keyOfCall.get(id);
      if (key) seenReads.delete(key);
    }
  };
  let tokens = 0;
  let repeatSteps = 0;
  let coverageNudges = 0;

  for (let step = 1; step <= opts.maxSteps; step++) {
    opts.signal.throwIfAborted();
    const last = step === opts.maxSteps;
    if (last) messages.push({ role: 'user', content: 'Step budget reached: answer now with what you found, without calling tools.' });
    fit();
    const res = await opts.backend.chat(messages, last ? [] : schemas, opts.signal);
    tokens += res.tokens;
    messages.push(res.message);
    // On the last step tool calls are ignored: some models still call tools when told not to.
    const calls = last ? [] : res.message.tool_calls ?? [];
    if (calls.length === 0) {
      const answer = (res.message.content ?? '').trim();
      if (!last && filesRead.size < (opts.minFilesRead ?? 0) && coverageNudges < MAX_COVERAGE_NUDGES) {
        coverageNudges++;
        opts.emit('message', { step: shown(step), chars: answer.length, sentBack: `only ${filesRead.size} file(s) read` });
        messages.push({ role: 'user', content: `You have opened ${filesRead.size} file(s) with read_file, too few to conclude (at least ${opts.minFilesRead} expected). Do not answer yet: list the entry points of the task's area (list_dir, search_code, grep for routes, handlers, definitions), open each of those files with read_file, and follow what they call. Then give the final report, including the files you reviewed.` });
        continue;
      }
      opts.emit('message', { step: shown(step), chars: answer.length });
      return { answer: answer || '(the model returned an empty answer)', steps: step, tokens, stoppedBy: last ? 'steps' : 'answer', filesRead: filesRead.size };
    }
    let allRepeats = true;
    for (const call of calls) {
      const tool = byName.get(call.function.name);
      let output: string;
      let image: string | null = null;
      let args: Record<string, unknown> = {};
      let repeated = false;
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        if (!tool) throw new Error(`unknown tool ${call.function.name}`);
        const key = callKey(tool.name, args);
        describe.set(call.id, `${tool.name} ${JSON.stringify(args).slice(0, 100)}`);
        keyOfCall.set(call.id, key);
        const before = REPEATABLE.has(tool.name) ? seenReads.get(key) : undefined;
        if (before !== undefined) {
          repeated = true;
          opts.emit('tool_call', { step: shown(step), tool: tool.name, args, repeated: true });
          output = `You already made this exact call at step ${before}; its result is earlier in this conversation. Use it, or make a different call (another path, another pattern, or open one of the files it found).`;
        } else {
          // A write or a command can change what the reads return, so earlier reads may be repeated again.
          if (REPEATABLE.has(tool.name)) seenReads.set(key, step); else seenReads.clear();
          opts.emit('tool_call', { step: shown(step), tool: tool.name, args });
          const out = await tool.run(args);
          if (typeof out === 'string') output = out;
          else { output = out.text; image = out.image; }
          if (tool.name === 'read_file' && typeof args.path === 'string') filesRead.add(args.path.trim());
        }
      } catch (err) {
        // Tool errors go back to the model (it can correct itself); they don't end the task.
        output = `Error: ${(err as Error).message}`;
      }
      if (!repeated) allRepeats = false;
      opts.emit('tool_result', { step: shown(step), tool: call.function.name, chars: output.length, error: output.startsWith('Error: '), ...(repeated ? { repeated: true } : {}) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      if (image) {
        // Only the newest screenshot stays in the conversation: images are large and old ones are stale.
        for (const m of messages) if (m.images) { delete m.images; m.content = `${m.content ?? ''} (older screenshot removed)`; }
        messages.push({ role: 'user', content: `Screenshot from ${call.function.name} (the screen now):`, images: [image] });
      }
    }
    repeatSteps = allRepeats ? repeatSteps + 1 : 0;
    if (repeatSteps >= STOP_AFTER_REPEATS) {
      messages.push({ role: 'user', content: 'You keep repeating calls you already made. Stop and write the final report now with what you have, without calling tools.' });
      fit();
      const final = await opts.backend.chat(messages, [], opts.signal);
      tokens += final.tokens;
      return { answer: (final.message.content ?? '').trim() || '(no answer)', steps: step + 1, tokens, stoppedBy: 'repeating', filesRead: filesRead.size };
    }
    if (repeatSteps === NUDGE_AFTER_REPEATS) {
      messages.push({ role: 'user', content: 'You keep making calls you already made. Do something new (another file, another search), or, if you have enough, write the final report now.' });
    }
    if (tokens >= opts.maxTokens) {
      messages.push({ role: 'user', content: 'Token budget reached: answer now with what you found, without calling tools.' });
      fit();
      const final = await opts.backend.chat(messages, [], opts.signal);
      tokens += final.tokens;
      return { answer: (final.message.content ?? '').trim() || '(no answer)', steps: step + 1, tokens, stoppedBy: 'tokens', filesRead: filesRead.size };
    }
  }
  throw new Error('unreachable: step loop ended without an answer');
}
