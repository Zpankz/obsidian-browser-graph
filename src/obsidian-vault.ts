import { TFile, TFolder, type Vault } from 'obsidian';
import type { VaultFileSnapshot, VaultPort } from './domain';
import { normalizeSafeVaultPath } from './vault-path';

export class ObsidianVaultPort implements VaultPort {
  constructor(private readonly vault: Vault) {}

  exists(path: string): Promise<boolean> {
    try {
      return Promise.resolve(
        this.vault.getAbstractFileByPath(this.safeVaultPath(path)) !== null,
      );
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async read(path: string): Promise<string> {
    return this.vault.read(this.fileAt(path));
  }

  async create(path: string, content: string): Promise<void> {
    await this.vault.create(this.safeVaultPath(path), content);
  }

  async write(path: string, content: string): Promise<void> {
    const normalized = this.safeVaultPath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing === null) {
      await this.vault.create(normalized, content);
      return;
    }
    if (!(existing instanceof TFile)) {
      throw new Error(`Vault path is not a file: ${normalized}`);
    }
    await this.vault.modify(existing, content);
  }

  async writeIfUnchanged(
    path: string,
    expected: string | undefined,
    content: string,
  ): Promise<boolean> {
    const normalized = this.safeVaultPath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (expected === undefined) {
      if (existing !== null) {
        return false;
      }
      try {
        await this.vault.create(normalized, content);
        return true;
      } catch (error) {
        if (this.vault.getAbstractFileByPath(normalized) !== null) {
          return false;
        }
        throw error;
      }
    }
    if (!(existing instanceof TFile)) {
      return false;
    }

    let replaced = false;
    await this.vault.process(existing, (current) => {
      if (current !== expected) {
        return current;
      }
      replaced = true;
      return content;
    });
    return replaced;
  }

  async append(path: string, content: string): Promise<void> {
    await this.vault.append(this.fileAt(path), content);
  }

  async trash(path: string): Promise<void> {
    await this.vault.trash(this.fileAt(path), true);
  }

  async ensureFolder(path: string): Promise<void> {
    const normalized = this.safeVaultPath(path);
    const parts = normalized.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      const candidate = parts.slice(0, index).join('/');
      const existing = this.vault.getAbstractFileByPath(candidate);
      if (existing instanceof TFolder) {
        continue;
      }
      if (existing) {
        throw new Error(`Vault path is not a folder: ${candidate}`);
      }

      try {
        await this.vault.createFolder(candidate);
      } catch (error) {
        if (!(this.vault.getAbstractFileByPath(candidate) instanceof TFolder)) {
          throw error;
        }
      }
    }
  }

  async scanFiles(
    extensions: readonly string[],
    visit: (file: VaultFileSnapshot) => void | Promise<void>,
    root?: string,
  ): Promise<void> {
    const normalizedRoot = root === undefined ? undefined : this.safeVaultPath(root);
    const supportedExtensions = extensions.map((extension) => extension.toLowerCase());
    const files = this.vault.getFiles()
      .filter((file) => supportedExtensions
        .some((extension) => file.path.toLowerCase().endsWith(extension)))
      .filter((file) => normalizedRoot === undefined
        || file.path.startsWith(`${normalizedRoot}/`))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    for (const file of files) {
      await visit({ path: file.path, content: await this.vault.read(file) });
    }
  }

  private fileAt(path: string): TFile {
    const normalized = this.safeVaultPath(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      throw new Error(`Vault file not found: ${normalized}`);
    }
    return file;
  }

  private safeVaultPath(value: string): string {
    const normalized = normalizeSafeVaultPath(value, this.vault.configDir);
    if (normalized === null) {
      throw new Error(`Unsafe vault path: ${value}`);
    }
    return normalized;
  }
}
