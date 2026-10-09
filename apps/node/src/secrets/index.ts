// Secrets of the node (its coordinator token, GitHub read token, API keys),
// kept in the OS secret store, never in the config file.
import { FileStore } from './file.js';
import { KeychainStore } from './keychain.js';
import { DpapiStore } from './dpapi.js';

export type SecretName = 'NODE_TOKEN' | 'GITHUB_TOKEN' | 'ANTHROPIC_API_KEY';

export interface SecretStore {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
}

/** What tokens and keys are made of; anything else is refused (no newlines, no shell characters). */
export const SECRET_VALUE = /^[A-Za-z0-9._~+/=-]{8,4096}$/;

export function checkSecret(name: string, value: string): void {
  if (!SECRET_VALUE.test(value)) throw new Error(`${name} has characters a key or token never has: not saved`);
}

export function defaultStore(): SecretStore {
  if (process.env.GAB_NODE_SECRETS === 'file') return new FileStore();
  switch (process.platform) {
    case 'darwin': return new KeychainStore();
    case 'win32': return new DpapiStore();
    default: return new FileStore();
  }
}
