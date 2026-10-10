import { describe, expect, it } from 'vitest';
import { NodeConfig } from '../src/config.js';
import { allowedKinds, linuxOnBattery, parseOwnModelRss, parsePmset, parseVmStat } from '../src/health.js';
import { applySetting } from '../src/settings.js';

const config = () => NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' });
const ok = { docker: true, model: true, freeDiskMb: null };
const limits = { runOnBattery: false, maxCpuPercent: 80, maxMemoryPercent: 80 };

describe('machine protection', () => {
  it('holds back every task on battery unless allowed, and above the CPU / memory limits', () => {
    expect(allowedKinds(['ask'], { ...ok, onBattery: true }, new Set(), 0, limits)).toMatchObject({ kinds: [], reason: expect.stringMatching(/battery/) });
    expect(allowedKinds(['ask'], { ...ok, onBattery: true }, new Set(), 0, { ...limits, runOnBattery: true }).kinds).toEqual(['ask']);
    expect(allowedKinds(['ask'], { ...ok, cpuPercent: 91 }, new Set(), 0, limits).reason).toMatch(/CPU at 91%/);
    expect(allowedKinds(['ask'], { ...ok, memoryPercent: 85 }, new Set(), 0, limits).reason).toMatch(/memory at 85%/);
    expect(allowedKinds(['ask'], { ...ok, cpuPercent: 80, memoryPercent: 80, onBattery: null }, new Set(), 0, limits).kinds).toEqual(['ask']);
  });

  it('reads the power source on macOS and Linux', () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 80%; discharging")).toBe(true);
    expect(parsePmset("Now drawing from 'AC Power'")).toBe(false);
    expect(parsePmset('')).toBeNull();
    expect(linuxOnBattery([{ type: 'Battery', online: null, status: 'Discharging' }, { type: 'Mains', online: '0', status: null }])).toBe(true);
    expect(linuxOnBattery([{ type: 'Battery', online: null, status: 'Charging' }, { type: 'Mains', online: '1', status: null }])).toBe(false);
    expect(linuxOnBattery([{ type: 'Mains', online: '1', status: null }])).toBeNull(); // desktop: no battery
  });

  it('counts reclaimable macOS memory as available', () => {
    const out = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100000.\nPages inactive: 50000.\nPages speculative: 10000.\nPages purgeable: 40000.\n';
    // available = 200000 pages * 16 KB = 3.05 GiB of 16 GiB -> 81% used
    expect(parseVmStat(out, 16 * 1024 ** 3)).toBe(81);
    expect(parseVmStat('garbage', 1)).toBeNull();
  });

  it('measures the memory of its own llama-server processes (paths with spaces), nothing else', () => {
    const out = ' 63536704 /Users/z/Library/Application Support/gab-ai-node/llama.cpp/bin/llama-server\n  2048 /usr/bin/llama-server-helper\n 512000 /Applications/Safari.app/Contents/MacOS/Safari\n  1024 llama-server\n';
    expect(parseOwnModelRss(out)).toBe((63536704 + 1024) * 1024);
    expect(parseOwnModelRss('')).toBe(0);
  });

  it('settings validate their values', () => {
    const c = config();
    expect(c).toMatchObject({ runOnBattery: false, maxCpuPercent: 80, maxMemoryPercent: 80 });
    applySetting(c, 'battery', 'on');
    applySetting(c, 'max-cpu', '70');
    expect(c).toMatchObject({ runOnBattery: true, maxCpuPercent: 70 });
    expect(() => applySetting(c, 'max-memory', '5')).toThrow(/10 to 100/);
    expect(() => applySetting(c, 'battery', 'yes')).toThrow(/on\|off/);
    expect(() => applySetting(c, 'nope', '1')).toThrow();
  });
});
