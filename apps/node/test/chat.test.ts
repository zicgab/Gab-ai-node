import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '@gab-ai-node/protocol';
import { ChatRunner } from '../src/agent/chat-runner.js';
import type { ChatMessage, ModelBackend } from '../src/backends/types.js';
import { NodeConfig } from '../src/config.js';
import type { TaskContext } from '../src/runner.js';

function context(chat: TaskSpec['chat'], instructions: string): TaskContext {
  const task: TaskSpec = {
    id: randomUUID(), kind: 'chat', repo: null, extraRepos: [], ref: null, instructions, backend: 'local', model: 'fake',
    budget: { maxSteps: 1, maxMinutes: 10, maxTokens: 100_000 }, branch: null, findingId: null, attempt: 1, role: null, paths: [], chat,
  };
  return {
    task, config: NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' }), workdir: '', extraDirs: {},
    signal: new AbortController().signal, emit: () => {}, secrets: { github: null, anthropic: null },
    modelEndpoint: async () => 'http://unused', commitAndPush: async () => { throw new Error('no repo'); },
  };
}

function backendReplying(content: string | null, seen: ChatMessage[][]): ModelBackend {
  return {
    model: 'fake',
    async chat(messages, tools) {
      seen.push(messages);
      expect(tools).toEqual([]); // a chat gives the model no tools
      return { message: { role: 'assistant', content }, tokens: 42, finishReason: 'stop' };
    },
  };
}

describe('ChatRunner', () => {
  it('sends system + earlier turns + the new message, and returns the answer without touching a repo', async () => {
    const seen: ChatMessage[][] = [];
    const ctx = context({ system: 'Be terse.', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }, 'and now?');
    const res = await new ChatRunner(() => backendReplying('  fine  ', seen)).run(ctx);
    expect(seen[0]).toEqual([
      { role: 'system', content: 'Be terse.' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'and now?' },
    ]);
    expect(res).toMatchObject({ answer: 'fine', branch: null, commits: [], findings: [], usage: { steps: 1, tokens: 42, model: 'fake' } });
  });

  it('first message: default system message, no history; an empty model answer is reported, not dropped', async () => {
    const seen: ChatMessage[][] = [];
    const res = await new ChatRunner(() => backendReplying(null, seen)).run(context(null, 'hello'));
    expect(seen[0]?.map((m) => m.role)).toEqual(['system', 'user']);
    expect(res.answer).toContain('empty answer');
  });

  it('only runs chat kinds', () => {
    expect(new ChatRunner().kinds).toEqual(['chat']);
  });
});
