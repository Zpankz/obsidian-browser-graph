import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
  class TAbstractFile {
    constructor(public path: string) {}
  }

  class TFile extends TAbstractFile {}
  class TFolder extends TAbstractFile {}

  return {
    TFile,
    TFolder,
    normalizePath: (value: string) => value
      .replace(/\\/g, '/')
      .split('/')
      .filter((part) => part.length > 0 && part !== '.')
      .join('/'),
  };
});

import { TFile, TFolder, type Vault } from 'obsidian';
import { ObsidianVaultPort } from '../src/obsidian-vault';

interface FakeObsidianVault extends Pick<
  Vault,
  | 'configDir'
  | 'getAbstractFileByPath'
  | 'createFolder'
  | 'create'
  | 'read'
  | 'append'
  | 'modify'
  | 'trash'
  | 'getFiles'
> {
  createdFolders: string[];
  createdFiles: Array<{ path: string; content: string }>;
  appendedFiles: Array<{ path: string; content: string }>;
  files: Map<string, TFile | TFolder>;
  contents: Map<string, string>;
  raceFolder?: string;
}

function fakeObsidianVault(): FakeObsidianVault {
  const files = new Map<string, TFile | TFolder>();
  const contents = new Map<string, string>();
  const api: FakeObsidianVault = {
    configDir: '.obsidian',
    createdFolders: [],
    createdFiles: [],
    appendedFiles: [],
    files,
    contents,
    getAbstractFileByPath(path) {
      return files.get(path) ?? null;
    },
    getFiles() {
      return [...files.values()].filter((file): file is TFile => file instanceof TFile);
    },
    async createFolder(path) {
      if (api.raceFolder === path) {
        files.set(path, new TFolder(path));
        throw new Error('Folder already exists');
      }
      api.createdFolders.push(path);
      const folder = new TFolder(path);
      files.set(path, folder);
      return folder;
    },
    async create(path, content) {
      api.createdFiles.push({ path, content });
      contents.set(path, content);
      const file = new TFile(path);
      files.set(path, file);
      return file;
    },
    async read(file) {
      return contents.get(file.path) ?? '';
    },
    async append(file, content) {
      api.appendedFiles.push({ path: file.path, content });
      contents.set(file.path, (contents.get(file.path) ?? '') + content);
    },
    modify: vi.fn(async (file: TFile, content: string) => {
      contents.set(file.path, content);
    }),
    trash: vi.fn(async (file: TFile) => {
      files.delete(file.path);
      contents.delete(file.path);
    }),
  };
  return api;
}

describe('ObsidianVaultPort', () => {
  let api: FakeObsidianVault;
  let vault: ObsidianVaultPort;

  beforeEach(() => {
    api = fakeObsidianVault();
    vault = new ObsidianVaultPort(api as Vault);
  });

  it('creates missing parent folders before a note', async () => {
    await vault.ensureFolder('Browser History/2026');

    expect(api.createdFolders).toEqual([
      'Browser History',
      'Browser History/2026',
    ]);
  });

  it('normalizes vault-relative paths before every operation', async () => {
    await vault.ensureFolder('Browser History\\2026//./August');
    await vault.create('Browser History\\2026//August/history.md', 'first');
    await vault.append('Browser History/2026/./August/history.md', '\nsecond');

    expect(await vault.exists('Browser History//2026/August/history.md')).toBe(true);
    expect(await vault.read('Browser History\\2026/August/history.md'))
      .toBe('first\nsecond');
    expect(api.createdFiles).toEqual([{
      path: 'Browser History/2026/August/history.md',
      content: 'first',
    }]);
    expect(api.appendedFiles).toEqual([{
      path: 'Browser History/2026/August/history.md',
      content: '\nsecond',
    }]);
  });

  it('scans supported extensions in deterministic path order under an optional root', async () => {
    for (const path of [
      'History/2026-08.md',
      'History/2026-08.csv',
      'History/2026-08.json',
      'History/export.txt',
      'Archive/2026-08.md',
    ]) {
      api.files.set(path, new TFile(path));
      api.contents.set(path, path);
    }

    const seen: string[] = [];
    await vault.scanFiles(['.md', '.csv', '.json'], ({ path }) => seen.push(path), 'History');

    expect(seen).toEqual([
      'History/2026-08.csv',
      'History/2026-08.json',
      'History/2026-08.md',
    ]);
  });

  it('scans trusted unsafe legacy file names without applying path validation', async () => {
    api.files.set('CON.md', new TFile('CON.md'));
    api.contents.set('CON.md', 'legacy marker note');
    const seen: string[] = [];

    await vault.scanFiles(['.md'], ({ content }) => seen.push(content));

    expect(seen).toEqual(['legacy marker note']);
  });

  it('writes existing files and trashes through the recoverable vault API', async () => {
    api.files.set('History/2026-08.json', new TFile('History/2026-08.json'));
    api.files.set('History/old.md', new TFile('History/old.md'));
    api.contents.set('History/2026-08.json', '{"ok":false}\n');
    api.contents.set('History/old.md', 'old');

    await vault.write('History/2026-08.json', '{"ok":true}\n');
    await vault.write('History/new.csv', 'new');
    await vault.trash('History/old.md');

    expect(api.modify).toHaveBeenCalled();
    expect(api.trash).toHaveBeenCalledWith(expect.any(TFile), true);
    expect(api.contents.get('History/2026-08.json')).toBe('{"ok":true}\n');
    expect(api.createdFiles).toContainEqual({ path: 'History/new.csv', content: 'new' });
  });

  it('rechecks after a concurrent folder creator wins the race', async () => {
    api.raceFolder = 'Browser History/2026';

    await expect(vault.ensureFolder('Browser History/2026')).resolves.toBeUndefined();
    expect(api.createdFolders).toEqual(['Browser History']);
  });

  it('propagates folder creation errors when no folder appeared', async () => {
    api.createFolder = vi.fn(async () => {
      throw new Error('Vault is read-only');
    });

    await expect(vault.ensureFolder('Browser History'))
      .rejects.toThrow('Vault is read-only');
  });

  it.each([
    '.obsidian',
    '.obsidian/plugins',
    '.Obsidian\\plugins\\history.md',
    '../outside.md',
    'Browser History/../../outside.md',
    '/absolute/history.md',
    'C:\\absolute\\history.md',
    'C:relative\\history.md',
    'Browser History.',
    'Browser History ',
    'History/<private>.md',
    'History/bad\u0001name.md',
    'History/bad\u007fname.md',
    'CON',
    'con.md',
    'AUX.log',
    'PRN',
    'NUL.md',
    'COM1.history',
    'LPT9.txt',
    'COM¹',
    'com².log',
    'LPT³.txt',
    '.obsidian.',
    '.obsidian ',
    '.obsidian./plugins/history.md',
  ])('refuses unsafe vault path %s', async (path) => {
    await expect(vault.exists(path)).rejects.toThrow('Unsafe vault path');
    await expect(vault.ensureFolder(path)).rejects.toThrow('Unsafe vault path');
    await expect(vault.create(path, '')).rejects.toThrow('Unsafe vault path');
    await expect(vault.write(path, '')).rejects.toThrow('Unsafe vault path');
    await expect(vault.append(path, '')).rejects.toThrow('Unsafe vault path');
    await expect(vault.trash(path)).rejects.toThrow('Unsafe vault path');
    await expect(vault.read(path)).rejects.toThrow('Unsafe vault path');
  });

  it('rejects a file where a requested folder already exists', async () => {
    api.files.set('Browser History', new TFile('Browser History'));

    await expect(vault.ensureFolder('Browser History/2026'))
      .rejects.toThrow('not a folder');
  });

  it('rejects reading or appending a missing note', async () => {
    await expect(vault.read('Browser History/missing.md'))
      .rejects.toThrow('Vault file not found');
    await expect(vault.append('Browser History/missing.md', 'entry'))
      .rejects.toThrow('Vault file not found');
    await expect(vault.trash('Browser History/missing.md'))
      .rejects.toThrow('Vault file not found');
  });
});
