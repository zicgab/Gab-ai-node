// gab-node settings                       show the machine-protection settings
// gab-node settings battery on|off        take tasks while on battery or not
// gab-node settings max-cpu <10-100>      no new task above this whole-machine CPU use (%)
// gab-node settings max-memory <10-100>   no new task above this whole-machine memory use (%)
import { loadConfig, saveConfig, type NodeConfig } from './config.js';

type Settable = Pick<NodeConfig, 'runOnBattery' | 'maxCpuPercent' | 'maxMemoryPercent'>;

function percent(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 10 || n > 100) throw new Error(`${name} must be a whole number from 10 to 100`);
  return n;
}

/** Changes one setting; throws on a bad key or value (nothing changed then). */
export function applySetting(config: Settable, key: string, value: string | undefined): void {
  switch (key) {
    case 'battery':
      if (value !== 'on' && value !== 'off') throw new Error('usage: gab-node settings battery on|off');
      config.runOnBattery = value === 'on';
      return;
    case 'max-cpu': config.maxCpuPercent = percent(value, 'max-cpu'); return;
    case 'max-memory': config.maxMemoryPercent = percent(value, 'max-memory'); return;
    default: throw new Error('settings: battery on|off, max-cpu <10-100>, max-memory <10-100>');
  }
}

export function describeSettings(config: Settable): string {
  return [
    `battery     ${config.runOnBattery ? 'on  (takes tasks on battery)' : 'off (no new task while on battery)'}`,
    `max-cpu     ${config.maxCpuPercent}%  (no new task while the machine uses more)`,
    `max-memory  ${config.maxMemoryPercent}%`,
  ].join('\n');
}

export async function settingsCommand(args: string[]): Promise<void> {
  const config = await loadConfig();
  const [key, value] = args;
  if (key) {
    applySetting(config, key, value);
    await saveConfig(config);
  }
  console.log(describeSettings(config));
  if (key) console.log('The node service uses the new value after its next restart (update.sh restarts it, or log out and in).');
}
