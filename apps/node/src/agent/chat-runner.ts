import type { TaskResult } from '@gab-ai-node/protocol';
import { OpenAICompatibleBackend } from '../backends/openai-compatible.js';
import type { ChatMessage, ModelBackend } from '../backends/types.js';
import type { TaskContext, TaskRunner } from '../runner.js';
import { defaultBackend } from './runner.js';

const DEFAULT_SYSTEM = 'You are a helpful assistant running on a private machine. Answer briefly and precisely. If you are not sure, say so; never invent facts.';

/**
 * Answers one message of a chat with the node's model: no repo, no tools, one
 * model call. The backend sends the earlier turns with every message, so the
 * node keeps no conversation state (a restart or another attempt loses nothing).
 * With a streaming model the answer so far is sent as "partial" progress events.
 */
export class ChatRunner implements TaskRunner {
  readonly kinds = ['chat' as const];

  constructor(
    private readonly makeBackend: (ctx: TaskContext) => ModelBackend | Promise<ModelBackend> = defaultBackend,
    private readonly partialMs = 3_000,
  ) {}

  async run(ctx: TaskContext): Promise<TaskResult> {
    const { task } = ctx;
    const chat = task.chat ?? { system: null, history: [] };
    const backend = await this.makeBackend(ctx);
    const messages: ChatMessage[] = [
      { role: 'system', content: chat.system ?? DEFAULT_SYSTEM },
      ...chat.history,
      { role: 'user', content: task.instructions },
    ];
    // Streaming model: the text so far goes to the backend now and then, so chat_send/chat_history can
    // show it before the answer is complete. Throttled: every PARTIAL_MS at most, the whole text each time.
    let lastSent = 0;
    const res = backend.chatStream
      ? await backend.chatStream(messages, ctx.signal, (text) => {
        const now = Date.now();
        if (now - lastSent < this.partialMs) return;
        lastSent = now;
        ctx.emit('progress', { stage: 'partial', text: text.slice(0, 20_000) });
      })
      : await backend.chat(messages, [], ctx.signal);
    const answer = (res.message.content ?? '').trim();
    ctx.emit('message', { chars: answer.length, turns: chat.history.length / 2 });
    return {
      summary: `answered (${chat.history.length / 2} earlier turn(s))`,
      answer: answer || '(the model returned an empty answer)',
      branch: null, commits: [], findings: [],
      usage: { steps: 1, tokens: res.tokens, model: backend.model },
    };
  }
}
