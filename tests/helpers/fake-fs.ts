import type { FileSystemPort } from '../../src/platform/discovery';

export function fakeFs(
  paths: string[],
  files: Record<string, string> = {},
): FileSystemPort {
  const knownFiles = new Map(Object.entries(files));
  for (const filePath of paths) {
    knownFiles.set(filePath, '');
  }

  return {
    async exists(filePath) {
      return knownFiles.has(filePath) || [...knownFiles.keys()].some((path) => path.startsWith(`${filePath}/`) || path.startsWith(`${filePath}\\`));
    },
    async readFile(filePath) {
      const value = knownFiles.get(filePath);
      if (value === undefined) {
        throw new Error(`Missing fake file: ${filePath}`);
      }
      return value;
    },
    async readDir(directoryPath) {
      const separator = directoryPath.includes('\\') ? '\\' : '/';
      const prefix = directoryPath.endsWith(separator) ? directoryPath : `${directoryPath}${separator}`;
      const entries = new Set<string>();
      for (const filePath of knownFiles.keys()) {
        if (filePath.startsWith(prefix)) {
          const child = filePath.slice(prefix.length).split(separator)[0];
          if (child) {
            entries.add(child);
          }
        }
      }
      return [...entries];
    },
  };
}
