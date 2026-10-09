import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../paths.js';
import { checkSecret, type SecretName, type SecretStore } from './index.js';

/**
 * Linux (and tests): a JSON file readable only by the node's own user (0600 in
 * a 0700 folder). The node runs as a dedicated user, so this is that user's secret.
 */
export class FileStore implements SecretStore {
  constructor(private readonly file = path.join(dataDir(), 'secrets.json')) {}

  private async read(): Promise<Record<string, string>> {
    try { return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw err; }
  }

  private async write(values: Record<string, string>): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.new`;
    await writeFile(temp, JSON.stringify(values), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }

  async get(name: SecretName) { return (await this.read())[name] ?? null; }
  async set(name: SecretName, value: string) { checkSecret(name, value); await this.write({ ...(await this.read()), [name]: value }); }
  async delete(name: SecretName) { const v = await this.read(); delete v[name]; await this.write(v); }
}
