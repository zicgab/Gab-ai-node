// Command sandbox: a Docker container per task with only the task's worktree
// mounted at /work. No tokens or node files inside, all capabilities dropped,
// memory/CPU/process limits. Commands the agent chooses run with no network;
// the repo's own setup command (AGENT.md, written by me) may use the network.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { exec, type ExecResult } from './exec.js';
import { log } from './log.js';

export interface Sandbox {
  /** Runs a shell command in /work. Non-zero exit is returned, not thrown. */
  run(command: string, opts: { timeoutMs: number; network?: boolean; signal?: AbortSignal }): Promise<ExecResult>;
  /** Starts a long-running program in the (offline) container with its stdin/stdout piped, e.g. the browser driver. */
  interactive?(argv: string[]): ChildProcessWithoutNullStreams;
  close(): Promise<void>;
}

export interface SandboxOptions {
  image: string;
  workdir: string;
  name: string;
  memoryMb: number;
  cpus: number;
}

const MAX_CMD_OUTPUT = 4 * 1024 * 1024;

export class DockerSandbox implements Sandbox {
  private constructor(private readonly name: string, private readonly o: SandboxOptions) {}

  static async start(o: SandboxOptions): Promise<DockerSandbox> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/.test(o.name)) throw new Error(`bad sandbox name ${o.name}`);
    if (!/^[a-z0-9][a-z0-9._\/:@-]{0,199}$/.test(o.image)) throw new Error(`bad sandbox image ${o.image}`);
    const s = new DockerSandbox(o.name, o);
    await exec('docker', ['rm', '-f', o.name], { timeoutMs: 30_000 }).catch(() => {});
    const user = process.platform === 'linux' && process.getuid ? ['--user', `${process.getuid()}:${process.getgid!()}`] : [];
    // Two containers share the mount: "offline" for agent commands, "online" started only for setup.
    await s.create('offline', ['--network', 'none'], user);
    return s;
  }

  private async create(suffix: string, net: string[], user: string[]): Promise<void> {
    const r = await exec('docker', [
      'run', '-d', '--rm', '--name', `${this.name}-${suffix}`, ...net, ...user,
      '--memory', `${this.o.memoryMb}m`, '--cpus', String(this.o.cpus), '--pids-limit', '1024',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--tmpfs', '/tmp:rw,exec,size=2g', '-e', 'HOME=/tmp', '-e', 'CI=1',
      '-v', `${this.o.workdir}:/work`, '-w', '/work', '--entrypoint', 'sleep', this.o.image, 'infinity',
    ], { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new Error(`sandbox start failed (${this.o.image}): ${r.stderr.trim().slice(0, 500)}`);
  }

  async run(command: string, opts: { timeoutMs: number; network?: boolean; signal?: AbortSignal }): Promise<ExecResult> {
    const suffix = opts.network ? 'online' : 'offline';
    if (opts.network) {
      const exists = await exec('docker', ['inspect', `${this.name}-online`], { timeoutMs: 30_000 });
      if (exists.code !== 0) await this.create('online', [], process.platform === 'linux' && process.getuid ? ['--user', `${process.getuid()}:${process.getgid!()}`] : []);
    }
    // timeout(1) inside the container kills the command itself, not just the docker client.
    const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    const r = await exec('docker', ['exec', `${this.name}-${suffix}`, 'timeout', '-s', 'KILL', String(secs), 'sh', '-c', command],
      { timeoutMs: opts.timeoutMs + 15_000, signal: opts.signal });
    if (r.code === 137) r.stderr += `\n[killed after ${secs} s]`;
    if (r.stdout.length >= MAX_CMD_OUTPUT) r.stdout += '\n[output capped]';
    if (opts.network) await exec('docker', ['rm', '-f', `${this.name}-online`], { timeoutMs: 30_000 }).catch(() => {});
    return r;
  }

  interactive(argv: string[]): ChildProcessWithoutNullStreams {
    return spawn('docker', ['exec', '-i', `${this.name}-offline`, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  async close(): Promise<void> {
    for (const suffix of ['offline', 'online']) {
      const r = await exec('docker', ['rm', '-f', `${this.name}-${suffix}`], { timeoutMs: 60_000 }).catch((err: Error) => ({ code: 1, stdout: '', stderr: err.message }));
      if (r.code !== 0 && !/No such container/i.test(r.stderr)) log.error('sandbox cleanup failed', { name: `${this.name}-${suffix}`, err: r.stderr.trim() });
    }
  }
}
