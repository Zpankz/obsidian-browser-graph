import type { NormalizedVisit, VaultPort } from '../../src/domain';
import { newNote, renderVisit } from '../../src/output/markdown';
import { destinationPath, periodFor } from '../../src/output/periods';
import { DEFAULT_SETTINGS } from '../../src/settings';

export interface FakeVaultOptions {
  failAppend?: string;
  files?: Record<string, string>;
}

export interface FakeVault extends VaultPort {
  readText(path: string): string;
}

export function fakeVault(options: FakeVaultOptions = {}): FakeVault {
  const files = new Map(Object.entries(options.files ?? {}));

  return {
    async exists(path) {
      return files.has(path);
    },
    async read(path) {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`Missing vault file: ${path}`);
      }
      return content;
    },
    async create(path, content) {
      if (files.has(path)) {
        throw new Error(`Vault file already exists: ${path}`);
      }
      files.set(path, content);
    },
    async append(path, content) {
      if (path === options.failAppend) {
        throw new Error(`Could not append: ${path}`);
      }
      const current = files.get(path);
      if (current === undefined) {
        throw new Error(`Missing vault file: ${path}`);
      }
      files.set(path, current + content);
    },
    async ensureFolder() {},
    async scanMarkdownFiles(visit) {
      const contents = [...files.entries()]
        .filter(([path]) => path.toLowerCase().endsWith('.md'))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, content]) => content);
      for (const content of contents) {
        visit(content);
      }
    },
    readText(path) {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`Missing vault file: ${path}`);
      }
      return content;
    },
  };
}

export function fakeVaultWithRenderedVisit(
  input: NormalizedVisit,
  options: Omit<FakeVaultOptions, 'files'> = {},
): FakeVault {
  const path = destinationPath(DEFAULT_SETTINGS, input.visitedAt);
  const label = periodFor(input.visitedAt, DEFAULT_SETTINGS.period).label;
  return fakeVault({
    ...options,
    files: {
      [path]: newNote(label, [renderVisit(input).trimEnd()]),
    },
  });
}
