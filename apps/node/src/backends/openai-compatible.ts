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
 * The node's own llama.cpp llama-server, which speaks the OpenAI chat API
 * (see models/server.ts). Connection failures and 5xx are retryable: the task goes
 * back to the queue rather than failing for good.
 */
/** Messages as the API wants them: images become content parts of a user message. */
function wire(messages: ChatMessage[]): unknown[] {
  return messages.map(({ images, ...m }) => (images?.length
    ? { ...m, role: 'user', content: [{ type: 'text', text: m.content ?? '' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }
    : m));
}

const StreamChunk = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional() }).partial().optional(), finish_reason: z.string().nullable().optional() })).optional(),
  usage: z.object({ total_tokens: z.number() }).partial().nullable().optional(),
});

const UNPARSEABLE_OUTPUT = /does not match the expected|failed to parse/i;

export class OpenAICompatibleBackend implements ModelBackend {
  constructor(private readonly endpoint: string, readonly model: string, private readonly apiKey: string | null = null) {}

  async chat(messages: ChatMessage[], tools: ToolSchema[], signal: AbortSignal): Promise<ChatResponse> {
    const body = { model: this.model, messages: wire(messages), tools: tools.length ? tools : undefined, temperature: 0.2 };
    let res: globalThis.Response;
    let text: string;
    // llama-server answers 500 when the model's output does not parse as its chat format
    // (e.g. a malformed tool call from gpt-oss). At 0.2 the same prompt tends to repeat the same
    // output, so retries sample at 1.0 (OpenAI's recommended setting for gpt-oss) with a new seed.
    for (let attempt = 1; ; attempt++) {
      res = await this.post(attempt === 1 ? body : { ...body, temperature: 1, seed: Math.floor(Math.random() * 2 ** 31) }, signal);
      text = await res.text();
      if (res.status !== 500 || !UNPARSEABLE_OUTPUT.test(text) || attempt >= 3) break;
      process.stderr.write(`model ${this.model}: output did not parse, asking again (try ${attempt + 1} of 3)\n`);
    }
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

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<globalThis.Response> {
    try {
      return await fetch(`${this.endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new RetryableError(`model server ${this.endpoint} unreachable: ${(err as Error).message}`);
    }
  }

  /** Streams the answer (server-sent events); onText gets the whole text so far after each piece. */
  async chatStream(messages: ChatMessage[], signal: AbortSignal, onText: (textSoFar: string) => void): Promise<ChatResponse> {
    const res = await this.post({ model: this.model, messages: wire(messages), temperature: 0.2, stream: true, stream_options: { include_usage: true } }, signal);
    if (!res.ok || !res.body) {
      const text = await res.text();
      if (res.status >= 500 || res.status === 429) throw new RetryableError(`model server HTTP ${res.status}: ${text.slice(0, 300)}`);
      throw new Error(`model server HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    let answer = '';
    let tokens = 0;
    let finishReason: string | null = null;
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let parsed: z.infer<typeof StreamChunk>;
        try { parsed = StreamChunk.parse(JSON.parse(data)); } catch { continue; } // a malformed piece is skipped, not fatal
        const piece = parsed.choices?.[0]?.delta?.content ?? '';
        if (piece) { answer += piece; onText(answer); }
        finishReason = parsed.choices?.[0]?.finish_reason ?? finishReason;
        if (parsed.usage?.total_tokens) tokens = parsed.usage.total_tokens;
      }
    }
    // Servers that send no usage: a rough count (4 characters a token) so budgets still move.
    if (!tokens) tokens = Math.ceil((JSON.stringify(messages).length + answer.length) / 4);
    return { message: { role: 'assistant', content: answer }, tokens, finishReason };
  }
}
