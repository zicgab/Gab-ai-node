import { z } from 'zod';

const Reply = z.object({ choices: z.array(z.object({ message: z.object({ tool_calls: z.array(z.object({ function: z.object({ name: z.string() }) })).nullish() }) })).min(1) });

/** One tiny request with a tool: does the model answer with a tool call? (Loading a big model can take a minute.) */
export async function toolSmokeTest(endpoint: string, model: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetchFn(`${endpoint}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 200,
        messages: [{ role: 'user', content: 'Call the tool get_time with zone "UTC". Do not answer in text.' }],
        tools: [{ type: 'function', function: { name: 'get_time', description: 'Current time in a zone', parameters: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] } } }],
      }),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const body = Reply.safeParse(await res.json());
    if (!body.success) return { ok: false, detail: 'unexpected response' };
    const called = body.data.choices[0]!.message.tool_calls?.some((c) => c.function.name === 'get_time') ?? false;
    return called ? { ok: true, detail: 'called the tool' } : { ok: false, detail: 'answered without calling the tool' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
