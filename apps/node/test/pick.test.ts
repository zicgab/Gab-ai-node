import { describe, expect, it } from 'vitest';
import { NodeConfig } from '../src/config.js';
import { modelFor } from '../src/models/pick.js';

const base = { coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' };

describe('modelFor', () => {
  const config = NodeConfig.parse({ ...base, defaultModel: 'small', roleModels: { security: 'reasoner', custom: 'coder', ask: 'fast' } });

  it('the model a task names wins over everything', () => {
    expect(modelFor({ model: 'named', role: 'security', kind: 'custom' }, config)).toBe('named');
  });

  it('a role beats a kind, a kind beats the default', () => {
    expect(modelFor({ model: null, role: 'security', kind: 'custom' }, config)).toBe('reasoner');
    expect(modelFor({ model: null, role: 'frontend', kind: 'custom' }, config)).toBe('coder');
    expect(modelFor({ model: null, role: null, kind: 'ask' }, config)).toBe('fast');
    expect(modelFor({ model: null, role: 'uxui', kind: 'bug_hunt' }, config)).toBe('small');
  });

  it('is null when nothing is set', () => {
    expect(modelFor({ model: null, role: null, kind: 'ask' }, NodeConfig.parse(base))).toBeNull();
  });
});

describe('config roleModels', () => {
  it('defaults to empty and accepts only roles and kinds as keys', () => {
    expect(NodeConfig.parse(base).roleModels).toEqual({});
    expect(NodeConfig.safeParse({ ...base, roleModels: { security: 'x' } }).success).toBe(true);
    expect(NodeConfig.safeParse({ ...base, roleModels: { wizard: 'x' } }).success).toBe(false);
    expect(NodeConfig.safeParse({ ...base, roleModels: { security: '' } }).success).toBe(false);
  });
});
