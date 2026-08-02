import { TFile, TFolder, normalizePath, type Vault } from 'obsidian';
import type { VaultPort } from './domain';

export class ObsidianVaultPort implements VaultPort {
  constructor(private readonly vault: Vault) {}

  async exists(path: string): Promise<boolean> {
    return this.vault.getAbstractFileByPath(safeVaultPath(path)) !== null;
  }

  async read(path: string): Promise<string> {
    return this.vault.read(this.fileAt(path));
  }

  async create(path: string, content: string): Promise<void> {
    await this.vault.create(safeVaultPath(path), content);
  }

  async append(path: string, content: string): Promise<void> {
    await this.vault.append(this.fileAt(path), content);
  }

  async ensureFolder(path: string): Promise<void> {
    const normalized = safeVaultPath(path);
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

  private fileAt(path: string): TFile {
    const normalized = safeVaultPath(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      throw new Error(`Vault file not found: ${normalized}`);
    }
    return file;
  }
}

function safeVaultPath(value: string): string {
  const candidate = value.trim().replace(/\\/g, '/');
  if (
    candidate.length === 0
    || /^(?:\/|[A-Za-z]:\/)/.test(candidate)
    || candidate.split('/').some((part) => part === '..')
  ) {
    throw new Error(`Unsafe vault path: ${value}`);
  }

  const normalized = normalizePath(candidate);
  const firstSegment = normalized.split('/')[0];
  if (!normalized || firstSegment.toLowerCase() === '.obsidian') {
    throw new Error(`Unsafe vault path: ${value}`);
  }
  return normalized;
}
