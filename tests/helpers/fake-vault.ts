import type { NormalizedVisit, VaultPort } from '../../src/domain';
import { newNote, renderVisit } from '../../src/output/markdown';
import { destinationPath, periodFor } from '../../src/output/periods';
import { DEFAULT_SETTINGS } from '../../src/settings';

export interface FakeVaultOptions {
  conditionalWriteInterference?: {
    path: string;
    contents: string[];
  };
  failAppend?: string;
  failTrash?: string;
  failWrite?: string;
  files?: Record<string, string>;
}

export interface FakeVault extends VaultPort {
  readText(path: string): string;
  hasFile(path: string): boolean;
  trashedPaths(): string[];
}

export function fakeVault(options: FakeVaultOptions = {}): FakeVault {
  const files = new Map(Object.entries(options.files ?? {}));
  const trashed: string[] = [];
  const conditionalWriteInterference = options.conditionalWriteInterference
    ? {
      path: options.conditionalWriteInterference.path,
      contents: [...options.conditionalWriteInterference.contents],
    }
    : undefined;

  return {
    async exists(path) {
      return files.has(path)
        || [...files.keys()].some((candidate) => candidate.startsWith(`${path}/`));
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
    async write(path, content) {
      if (path === options.failWrite) {
        throw new Error(`Could not write: ${path}`);
      }
      files.set(path, content);
    },
    async writeIfUnchanged(path, expected, content) {
      if (path === options.failWrite) {
        throw new Error(`Could not write: ${path}`);
      }
      if (conditionalWriteInterference?.path === path
        && conditionalWriteInterference.contents.length > 0) {
        files.set(path, conditionalWriteInterference.contents.shift() as string);
      }
      if (files.get(path) !== expected) {
        return false;
      }
      files.set(path, content);
      return true;
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
    async trash(path) {
      if (path === options.failTrash) {
        throw new Error(`Could not trash: ${path}`);
      }
      if (!files.delete(path)) {
        throw new Error(`Missing vault file: ${path}`);
      }
      trashed.push(path);
    },
    async ensureFolder() {},
    async scanFiles(extensions, visit, root) {
      const supportedExtensions = extensions.map((extension) => extension.toLowerCase());
      const snapshots = [...files.entries()]
        .filter(([path]) => supportedExtensions
          .some((extension) => path.toLowerCase().endsWith(extension))
          && (root === undefined || path.startsWith(`${root}/`)))
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([path, content]) => ({ path, content }));
      for (const snapshot of snapshots) {
        await visit(snapshot);
      }
    },
    readText(path) {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`Missing vault file: ${path}`);
      }
      return content;
    },
    hasFile(path) {
      return files.has(path);
    },
    trashedPaths() {
      return [...trashed];
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
