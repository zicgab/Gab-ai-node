// The agent loop: the model reads the task, calls tools, gets their results,
// until it answers without a tool call or the step/token budget runs out.
import type { ChatMessage, ModelBackend, ToolSchema } from '../backends/types.js';
import type { ToolDef } from './tools.js';

export interface AgentRun { answer: string; steps: number; tokens: number; stoppedBy: 'answer' | 'steps' | 'tokens' }

export async function runAgent(opts: {
  backend: ModelBackend;
  tools: ToolDef[];
  system: string;
  user: string;
  maxSteps: number;
  maxTokens: number;
  signal: AbortSignal;
  emit: (type: 'tool_call' | 'tool_result' | 'message', data: Record<string, unknown>) => void;
}): Promise<AgentRun> {
  const schemas: ToolSchema[] = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }];
  let tokens = 0;

  for (let step = 1; step <= opts.maxSteps; step++) {
    opts.signal.throwIfAborted();
    const last = step === opts.maxSteps;
    if (last) messages.push({ role: 'user', content: 'Step budget reached: answer now with what you found, without calling tools.' });
    const res = await opts.backend.chat(messages, last ? [] : schemas, opts.signal);
    tokens += res.tokens;
    messages.push(res.message);
    // On the last step tool calls are ignored: some models still call tools when told not to.
    const calls = last ? [] : res.message.tool_calls ?? [];
    if (calls.length === 0) {
      const answer = (res.message.content ?? '').trim();
      opts.emit('message', { step, chars: answer.length });
      return { answer: answer || '(the model returned an empty answer)', steps: step, tokens, stoppedBy: last ? 'steps' : 'answer' };
    }
    for (const call of calls) {
      const tool = byName.get(call.function.name);
      let output: string;
      let image: string | null = null;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        if (!tool) throw new Error(`unknown tool ${call.function.name}`);
        opts.emit('tool_call', { step, tool: tool.name, args });
        const out = await tool.run(args);
        if (typeof out === 'string') output = out;
        else { output = out.text; image = out.image; }
      } catch (err) {
        // Tool errors go back to the model (it can correct itself); they don't end the task.
        output = `Error: ${(err as Error).message}`;
      }
      opts.emit('tool_result', { step, tool: call.function.name, chars: output.length, error: output.startsWith('Error: ') });
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      if (image) {
        // Only the newest screenshot stays in the conversation: images are large and old ones are stale.
        for (const m of messages) if (m.images) { delete m.images; m.content = `${m.content ?? ''} (older screenshot removed)`; }
        messages.push({ role: 'user', content: `Screenshot from ${call.function.name} (the screen now):`, images: [image] });
      }
    }
    if (tokens >= opts.maxTokens) {
      messages.push({ role: 'user', content: 'Token budget reached: answer now with what you found, without calling tools.' });
      const final = await opts.backend.chat(messages, [], opts.signal);
      tokens += final.tokens;
      return { answer: (final.message.content ?? '').trim() || '(no answer)', steps: step + 1, tokens, stoppedBy: 'tokens' };
    }
  }
  throw new Error('unreachable: step loop ended without an answer');
}
