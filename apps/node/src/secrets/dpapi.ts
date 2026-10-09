import path from 'node:path';
import { dataDir } from '../paths.js';
import { exec } from '../exec.js';
import { FileStore } from './file.js';
import { checkSecret, type SecretName, type SecretStore } from './index.js';

// PowerShell reading the value from stdin: it never appears on a command line.
const PROTECT = '$v = [Console]::In.ReadToEnd().Trim(); ConvertFrom-SecureString (ConvertTo-SecureString $v -AsPlainText -Force)';
const UNPROTECT = '$b = [Console]::In.ReadToEnd().Trim(); [Net.NetworkCredential]::new("", (ConvertTo-SecureString $b)).Password';

/**
 * Windows: values encrypted with DPAPI for the node's Windows account, stored
 * in a file; a copy of the file is useless to another account or computer.
 */
export class DpapiStore implements SecretStore {
  private readonly file = new FileStore(path.join(dataDir(), 'secrets.dpapi.json'));

  private async ps(script: string, input: string): Promise<string> {
    const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, check: true });
    return r.stdout.trim();
  }

  async get(name: SecretName) {
    const blob = await this.file.get(name);
    return blob ? this.ps(UNPROTECT, blob) : null;
  }

  async set(name: SecretName, value: string) {
    checkSecret(name, value);
    const blob = await this.ps(PROTECT, value);
    if ((await this.ps(UNPROTECT, blob)) !== value) throw new Error(`${name} could not be encrypted (DPAPI gave another value back)`);
    await this.file.set(name, blob);
  }

  async delete(name: SecretName) { await this.file.delete(name); }
}
