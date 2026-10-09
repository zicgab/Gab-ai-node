import { z } from 'zod';
import { RetryableError } from '../runner.js';
import type { ChatMessage, ChatResponse, ModelBackend, ToolSchema } from './types.js';

const Response = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string(), type: z.literal('function').default('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).optional().nullable(),
    }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
  usage: z.object({ total_tokens: z.number() }).partial().optional(),
});

/**
 * Local model server speaking the OpenAI chat API (llama.cpp llama-server,
 * MLX, Ollama, vLLM). Connection failures and 5xx are retryable: the task goes
 * back to the queue rather than failing for good.
 */
export class OpenAICompatibleBackend implements ModelBackend {
  constructor(private readonly endpoint: string, readonly model: string, private readonly apiKey: string | null = null) {}

  async chat(messages: ChatMessage[], tools: ToolSchema[], signal: AbortSignal): Promise<ChatResponse> {
    let res: globalThis.Response;
    try {
      res = await fetch(`${this.endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, messages, tools: tools.length ? tools : undefined, temperature: 0.2 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new RetryableError(`model server ${this.endpoint} unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (res.status >= 500 || res.status === 429) throw new RetryableError(`model server HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (!res.ok) throw new Error(`model server HTTP ${res.status}: ${text.slice(0, 300)}`);
    const parsed = Response.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`model server sent an unexpected response: ${parsed.error.issues[0]?.message}`);
    const choice = parsed.data.choices[0]!;
    return {
      message: { role: 'assistant', content: choice.message.content ?? null, tool_calls: choice.message.tool_calls ?? undefined },
      tokens: parsed.data.usage?.total_tokens ?? 0,
      finishReason: choice.finish_reason ?? null,
    };
  }
}
