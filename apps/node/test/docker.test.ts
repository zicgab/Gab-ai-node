import { describe, expect, it } from 'vitest';
import { NodeConfig } from '../src/config.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDockerEnsurer, dockerStartCommand, quietDockerDesktop } from '../src/docker.js';
import { dockerRunning } from '../src/health.js';
import { applySetting, describeSettings } from '../src/settings.js';

describe('dockerRunning', () => {
  it('needs the server version: docker info --format exits 0 with an empty line when the daemon is down', async () => {
    const fake = (stdout: string, code = 0) => (async () => ({ code, stdout, stderr: '' })) as never;
    expect(await dockerRunning(fake('27.5.1\n'))).toBe(true);
    expect(await dockerRunning(fake('\n'))).toBe(false);
    expect(await dockerRunning(fake('', 1))).toBe(false);
  });
});

describe('quietDockerDesktop', () => {
  it('turns the Docker Desktop window off and keeps the other settings', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gab-docker-'));
    const file = path.join(dir, 'sub', 'settings-store.json');
    await quietDockerDesktop(file); // no file yet
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ OpenUIOnStartupDisabled: true, AutoStart: true });
    await writeFile(file, JSON.stringify({ MemoryMiB: 8192, OpenUIOnStartupDisabled: false }));
    await quietDockerDesktop(file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ MemoryMiB: 8192, OpenUIOnStartupDisabled: true, AutoStart: true });
    await writeFile(file, '{ broken');
    await expect(quietDockerDesktop(file)).rejects.toThrow(/cannot read/);
  });
});

describe('dockerStartCommand', () => {
  it('starts Docker Desktop in the background on macOS, without a window', () => {
    expect(dockerStartCommand('darwin')).toEqual({ command: 'open', args: ['-g', '-j', '-a', 'Docker'] });
  });
  it('starts Docker Desktop from its install folder on Windows', () => {
    expect(dockerStartCommand('win32', { ProgramFiles: 'D:\\Programs' })?.command).toMatch(/Docker Desktop\.exe$/);
    expect(dockerStartCommand('win32', {})?.command).toContain('Program Files');
  });
  it('uses only the user service on Linux (the system service needs sudo)', () => {
    expect(dockerStartCommand('linux')).toEqual({ command: 'systemctl', args: ['--user', 'start', 'docker'] });
  });
  it('has no way on other systems', () => {
    expect(dockerStartCommand('freebsd')).toBeNull();
  });
});

describe('createDockerEnsurer', () => {
  const make = (over: Partial<Parameters<typeof createDockerEnsurer>[0]> = {}) => {
    let up = false;
    let starts = 0;
    let t = 0;
    const ensure = createDockerEnsurer({
      enabled: () => true, isUp: async () => up, start: async () => { starts++; }, now: () => t, retryMs: 1000, ...over,
    });
    return { ensure, starts: () => starts, setUp: (v: boolean) => { up = v; }, tick: (ms: number) => { t += ms; } };
  };

  it('does nothing when Docker is already running', async () => {
    const d = make(); d.setUp(true);
    expect(await d.ensure()).toBe(true);
    expect(d.starts()).toBe(0);
  });

  it('starts Docker when it is down, and reports it down until it answers', async () => {
    const d = make();
    expect(await d.ensure()).toBe(false);
    expect(d.starts()).toBe(1);
    d.setUp(true);
    expect(await d.ensure()).toBe(true);
  });

  it('does not start it again while it is still coming up, only after the retry time', async () => {
    const d = make();
    await d.ensure(); d.tick(500); await d.ensure(); await d.ensure();
    expect(d.starts()).toBe(1);
    d.tick(600);
    await d.ensure();
    expect(d.starts()).toBe(2);
  });

  it('never starts it when autostart is off', async () => {
    const d = make({ enabled: () => false });
    expect(await d.ensure()).toBe(false);
    expect(d.starts()).toBe(0);
  });

  it('a failing start is logged, not thrown: the node keeps running and tries again later', async () => {
    let calls = 0; let t = 0;
    const ensure = createDockerEnsurer({ enabled: () => true, isUp: async () => false, start: async () => { calls++; throw new Error('Docker is not installed'); }, now: () => t, retryMs: 10 });
    expect(await ensure()).toBe(false);
    t += 20;
    expect(await ensure()).toBe(false);
    expect(calls).toBe(2);
  });
});

describe('docker-autostart setting', () => {
  const config = () => NodeConfig.parse({ coordinatorUrl: 'http://127.0.0.1:1', name: 'test-node' });
  it('is on by default and can be switched', () => {
    const c = config();
    expect(c.dockerAutoStart).toBe(true);
    applySetting(c, 'docker-autostart', 'off');
    expect(c.dockerAutoStart).toBe(false);
    expect(describeSettings(c)).toMatch(/docker-autostart\s+off/);
    applySetting(c, 'docker-autostart', 'on');
    expect(c.dockerAutoStart).toBe(true);
    expect(() => applySetting(c, 'docker-autostart', 'maybe')).toThrow(/on\|off/);
  });
});
