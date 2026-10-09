import { exec } from '../exec.js';
import { checkSecret, type SecretName, type SecretStore } from './index.js';

const SERVICE = 'gab-ai-node';

/**
 * macOS login Keychain of the node's user. Values go to `security` through its
 * interactive prompt on stdin (-i), never on a command line other users can list.
 */
export class KeychainStore implements SecretStore {
  async get(name: SecretName) {
    const r = await exec('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
    if (r.code === 44) return null; // not in the Keychain
    if (r.code !== 0) throw new Error(`could not read ${name} from the login Keychain (security exit ${r.code}): locked? Over SSH run "security unlock-keychain" first`);
    return r.stdout.trim() || null;
  }

  async set(name: SecretName, value: string) {
    checkSecret(name, value);
    await exec('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${name} -w ${value}\n` });
    if ((await this.get(name)) !== value) throw new Error(`could not save ${name} in the login Keychain (locked?)`);
  }

  async delete(name: SecretName) {
    await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', name]);
  }
}
