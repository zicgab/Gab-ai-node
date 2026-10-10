import { describe, expect, it } from 'vitest';
import { NodeConfig, dropUnknownModels } from '../src/config.js';
import { CATALOG } from '../src/models/catalog.js';
import { deferredKinds, fallbackModel, isVisionModel, modelFor } from '../src/models/pick.js';

const ALL = ['qwen3-coder-30b', 'gpt-oss-120b', 'qwen3-vl-30b'];
const SMALL = ['qwen3-coder-30b', 'qwen3-vl-30b'];

describe('catalog', () => {
  it('holds exactly the three models of the node', () => {
    expect(CATALOG.map((e) => e.id)).toEqual(ALL);
  });
  it('gives every task kind and role a model', () => {
    const slots = ['frontend', 'backend', 'security', 'uxui', 'ask', 'bug_hunt', 'fix_finding', 'test_web', 'test_mobile', 'translate', 'custom', 'eval', 'chat', 'scan', 'contract_check', 'test_electron', 'docs_check'];
    for (const slot of slots) expect(CATALOG.some((e) => e.useFor.includes(slot)), slot).toBe(true);
  });
  it('a vision model has its projector', () => {
    for (const e of CATALOG.filter((x) => x.vision)) expect(e.mmproj?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deferredKinds', () => {
  const kinds = ['ask', 'bug_hunt', 'fix_finding', 'test_web'] as const;
  it('defers nothing on a node with all three models', () => {
    expect(deferredKinds(kinds, ['qwen3-coder-30b', 'gpt-oss-120b', 'qwen3-vl-30b'])).toEqual([]);
  });
  it('defers the deep kinds on a node without the deep model, and vision kinds without the vision model', () => {
    expect(deferredKinds(kinds, ['qwen3-coder-30b', 'qwen3-vl-30b'])).toEqual(['bug_hunt', 'fix_finding']);
    expect(deferredKinds(kinds, ['qwen3-coder-30b'])).toEqual(['bug_hunt', 'fix_finding', 'test_web']);
  });
});

describe('modelFor', () => {
  it('sends each purpose to its model on a node that has all three', () => {
    expect(modelFor({ model: null, role: null, kind: 'ask' }, ALL)).toBe('qwen3-coder-30b');
    expect(modelFor({ model: null, role: 'frontend', kind: 'custom' }, ALL)).toBe('qwen3-coder-30b');
    expect(modelFor({ model: null, role: null, kind: 'bug_hunt' }, ALL)).toBe('gpt-oss-120b');
    expect(modelFor({ model: null, role: 'security', kind: 'custom' }, ALL)).toBe('gpt-oss-120b');
    expect(modelFor({ model: null, role: null, kind: 'scan' }, ALL)).toBe('gpt-oss-120b');
  });

  it('screenshot tasks use the vision model whatever their role', () => {
    expect(modelFor({ model: null, role: null, kind: 'test_web' }, ALL)).toBe('qwen3-vl-30b');
    expect(modelFor({ model: null, role: 'frontend', kind: 'test_electron' }, ALL)).toBe('qwen3-vl-30b');
  });

  it('a node without the deep model sends deep tasks to the fast one', () => {
    expect(modelFor({ model: null, role: null, kind: 'bug_hunt' }, SMALL)).toBe('qwen3-coder-30b');
    expect(modelFor({ model: null, role: 'security', kind: 'fix_finding' }, SMALL)).toBe('qwen3-coder-30b');
  });

  it('screenshot tasks fall back to the fast model when there is no vision model', () => {
    expect(modelFor({ model: null, role: null, kind: 'test_web' }, ['qwen3-coder-30b'])).toBe('qwen3-coder-30b');
  });

  it('a task may name a catalog model, and nothing else', () => {
    expect(modelFor({ model: 'gpt-oss-120b', role: null, kind: 'ask' }, SMALL)).toBe('gpt-oss-120b');
    expect(modelFor({ model: 'llama3:8b', role: null, kind: 'ask' }, ALL)).toBeNull();
  });

  it('is null when nothing is installed', () => {
    expect(modelFor({ model: null, role: null, kind: 'ask' }, [])).toBeNull();
    expect(fallbackModel([])).toBeNull();
  });

  it('only the vision model is a vision model', () => {
    expect(ALL.filter(isVisionModel)).toEqual(['qwen3-vl-30b']);
    expect(isVisionModel('not-a-model')).toBe(false);
  });
});

describe('config of earlier versions', () => {
  const base = { coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' };
  it('still loads when it holds the removed model settings (they are dropped)', () => {
    const parsed = NodeConfig.parse({
      ...base, defaultModel: 'x', roleModels: { security: 'y' }, visionModels: ['z'], modelEndpoint: 'http://127.0.0.1:11434/v1', modelEndpoints: {},
      modelServer: { mode: 'external', binary: 'llama-server', basePort: 8200 },
    });
    expect(parsed.modelServer).toEqual({ basePort: 8200, idleMinutes: 10 });
    for (const key of ['defaultModel', 'roleModels', 'visionModels', 'modelEndpoint', 'modelEndpoints']) expect(parsed).not.toHaveProperty(key);
  });

  it('drops local models the node does not know, keeps the catalog ones', () => {
    const parsed = NodeConfig.parse({ ...base, models: [{ id: 'qwen3-coder:30b', memoryMb: 24_000 }, { id: 'qwen3-coder-30b', memoryMb: 24_576 }] });
    expect(dropUnknownModels(parsed).models.map((m) => m.id)).toEqual(['qwen3-coder-30b']);
  });
});
