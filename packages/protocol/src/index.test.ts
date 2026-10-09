import { describe, expect, it } from 'vitest';
import { isAgentBranch, RepoName, NodeName } from './index.js';

describe('isAgentBranch', () => {
  it('accepts agent branches', () => {
    expect(isAgentBranch('agent/macbook-m3/3f2a-fix-login')).toBe(true);
  });
  it.each(['main', 'agent/main', 'agent//x', 'agent/Mac/x', 'agent/mac/../main', 'feature/agent/mac/x', 'agent/mac/a/b'])('rejects %s', (b) => {
    expect(isAgentBranch(b)).toBe(false);
  });
});

describe('names', () => {
  it('validates repos', () => {
    expect(RepoName.safeParse('zicgab/gasysteme').success).toBe(true);
    expect(RepoName.safeParse('zicgab').success).toBe(false);
    expect(RepoName.safeParse('a/b c').success).toBe(false);
  });
  it('validates node names', () => {
    expect(NodeName.safeParse('macbook-m3').success).toBe(true);
    expect(NodeName.safeParse('MacBook').success).toBe(false);
  });
});
