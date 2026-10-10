#!/usr/bin/env node
// gab-node: the worker node.
//   gab-node register --server http://<backend tailscale ip>:3083 --name macbook-m3
//       (install key = backend NODE_API_KEY: GAB_NODE_KEY or typed when asked; used once, never saved,
//        never on the command line. The installer (install.sh / install.ps1) runs this for you.)
//   gab-node fetch <version|code> <file> [sha]  the node's own code from the backend (update.sh)
//   gab-node retire                            uninstall: gives the tasks back and turns this node off
//   gab-node set-secret <github|anthropic>     value read from stdin
//   gab-node run                               the service (launchd / systemd / Task Scheduler)
//   gab-node pause | resume                    stop/start taking new tasks on this machine
//   gab-node status
//   gab-node settings [battery on|off | max-cpu <n> | max-memory <n>]   machine protection
//   gab-node models list | pull <id...|--all> | verify <id> | remove <id> | test [id] | manage
//   gab-node eval [--model <id>] [--runs <n>]  review the bundled canary repo and score the model
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { NodeName } from '@gab-ai-node/protocol';
import { detectCapabilities } from './capabilities.js';
import { CoordinatorClient } from './client.js';
import { loadConfig, NodeConfig, saveConfig } from './config.js';
import { log } from './log.js';
import { managedHost, modelsCommand } from './models/commands.js';
import { createHealthCheck } from './health.js';
import { evalCommand } from './eval.js';
import { settingsCommand } from './settings.js';
import { NodeAgent } from './loop.js';
import { dataDir, configFile, pauseFile } from './paths.js';
import { createRunners, DOCKER_KINDS } from './runners.js';
import { defaultStore, type SecretName } from './secrets/index.js';

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').trim();
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, terminal: true });
  // Don't echo what is typed.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

async function register(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { server: { type: 'string' }, name: { type: 'string' } } });
  if (!values.server || !values.name) throw new Error('usage: gab-node register --server <url> --name <node-name>');
  const name = NodeName.parse(values.name);
  const nodeKey = process.env.GAB_NODE_KEY?.trim() || (await readHidden('Node key (backend NODE_API_KEY; used once, not saved): '));
  if (!nodeKey) throw new Error('no node key given');

  // Keep model settings of an earlier install.
  let previous: Partial<NodeConfig> = {};
  if (existsSync(configFile())) previous = await loadConfig().catch(() => ({}));
  const config = NodeConfig.parse({ ...previous, coordinatorUrl: values.server.replace(/\/$/, ''), name });
  const res = await CoordinatorClient.register(config.coordinatorUrl, nodeKey, name);
  await defaultStore().set('NODE_TOKEN', res.token);
  await saveConfig(config);
  console.log(res.created
    ? `Registered as ${res.name}. The node starts paused: make it available from MCP (set_node_availability).`
    : `${res.name} existed: it has a new token now (the old one stopped working). Availability is unchanged.`);
}

async function retire(): Promise<void> {
  const config = await loadConfig();
  const store = defaultStore();
  const token = await store.get('NODE_TOKEN');
  if (!token) throw new Error('no node token: this node is not registered');
  const { released } = await new CoordinatorClient(config.coordinatorUrl, token).retire();
  await store.delete('NODE_TOKEN');
  console.log(`${config.name} turned off on the backend; ${released} task(s) given back to the queue.`);
}

async function fetchOwn(args: string[]): Promise<void> {
  const [what, file, sha] = args;
  if ((what !== 'version' && what !== 'code') || !file || (what === 'code' && !/^[0-9a-f]{40}$/.test(sha ?? ''))) {
    throw new Error('usage: gab-node fetch version <file>  |  gab-node fetch code <file> <40-char sha>');
  }
  const config = await loadConfig();
  const token = await defaultStore().get('NODE_TOKEN');
  if (!token) throw new Error('no node token: run "gab-node register" first');
  await new CoordinatorClient(config.coordinatorUrl, token).download(what === 'version' ? '/node/agent/version' : `/node/agent/code?ref=${sha}`, file);
}

async function setSecret(args: string[]): Promise<void> {
  const names: Record<string, SecretName> = { github: 'GITHUB_TOKEN', anthropic: 'ANTHROPIC_API_KEY' };
  const name = names[args[0] ?? ''];
  if (!name) throw new Error('usage: gab-node set-secret <github|anthropic>  (value on stdin)');
  const value = await readHidden(`${name}: `);
  await defaultStore().set(name, value);
  console.log(`${name} saved`);
}

async function run(): Promise<void> {
  const config = await loadConfig();
  const store = defaultStore();
  const nodeToken = await store.get('NODE_TOKEN');
  if (!nodeToken) throw new Error('no node token: run "gab-node register" first');
  const modelHost = await managedHost(config);
  const agent = new NodeAgent({
    config,
    modelHost,
    client: new CoordinatorClient(config.coordinatorUrl, nodeToken),
    runners: await createRunners(config),
    capabilities: () => detectCapabilities(config),
    health: createHealthCheck(config, dataDir()),
    dockerKinds: DOCKER_KINDS,
    logsDir: path.join(dataDir(), 'logs'),
    secrets: { github: await store.get('GITHUB_TOKEN'), anthropic: await store.get('ANTHROPIC_API_KEY') },
  });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    agent.stop().then(() => process.exit(0), (err) => { log.error('stop failed', { err }); process.exit(1); });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await agent.start();
  await agent.heartbeat();
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'register': return register(rest);
    case 'retire': return retire();
    case 'fetch': return fetchOwn(rest);
    case 'set-secret': return setSecret(rest);
    case 'run': return run();
    case 'models': return modelsCommand(rest);
    case 'eval': return evalCommand(rest);
    case 'settings': return settingsCommand(rest);
    case 'pause':
      await mkdir(dataDir(), { recursive: true });
      await writeFile(pauseFile(), new Date().toISOString());
      console.log('paused: no new tasks on this machine (running ones finish). "gab-node resume" to undo.');
      return;
    case 'resume':
      await rm(pauseFile(), { force: true });
      console.log('resumed: takes tasks again when the coordinator marks this node available');
      return;
    case 'status': {
      const config = await loadConfig();
      // Registered = a config AND the node's token (retire deletes the token but keeps the config). setup.sh / setup.ps1 rely on the exit code.
      const registered = Boolean(await defaultStore().get('NODE_TOKEN'));
      console.log(JSON.stringify({ name: config.name, backend: config.coordinatorUrl, registered, locallyPaused: existsSync(pauseFile()), dataDir: dataDir(), models: config.models.map((m) => m.id) }, null, 2));
      if (!registered) {
        console.error('This node has a config but no token (it was retired or the key store was cleared): run "gab-node register" again, or: bash setup.sh --register');
        process.exitCode = 1;
      }
      return;
    }
    default:
      throw new Error('commands: register, retire, fetch, set-secret, run, pause, resume, status, settings, models, eval');
  }
}

main().catch((err: Error) => { console.error(`Error: ${err.message}`); process.exitCode = 1; });
