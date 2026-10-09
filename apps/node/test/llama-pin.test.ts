import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { llamaServerBin } from '../src/paths.js';

const pin = readFileSync(path.resolve(import.meta.dirname, '../../../llama-server.pin'), 'utf8')
  .split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/));

describe('llama-server.pin', () => {
  const tag = pin.find((l) => l[0] === 'tag')?.[1];
  const assets = pin.filter((l) => l[0] === 'asset');

  it('names a tag and a build for every variant the install scripts ask for', () => {
    expect(tag).toMatch(/^b\d+$/);
    const variants = assets.map((a) => a[1]);
    for (const v of ['macos-arm64', 'macos-x64', 'linux-x64', 'linux-x64-vulkan', 'linux-arm64', 'linux-arm64-vulkan', 'win-x64', 'win-x64-vulkan', 'win-arm64']) {
      expect(variants).toContain(v);
    }
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('pins every file of the tag by a SHA-256', () => {
    for (const [, variant, file, sha] of assets) {
      expect(file, variant).toContain(tag);
      expect(file, variant).toMatch(/\.(tar\.gz|zip)$/);
      expect(sha, variant).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('llamaServerBin', () => {
  it('is inside the data folder, where the install scripts put it', () => {
    const prev = process.env.GAB_NODE_HOME;
    process.env.GAB_NODE_HOME = '/tmp/gab-home';
    try {
      expect(llamaServerBin()).toBe(path.join('/tmp/gab-home', 'llama.cpp', 'bin', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'));
    } finally {
      if (prev === undefined) delete process.env.GAB_NODE_HOME; else process.env.GAB_NODE_HOME = prev;
    }
  });
});
