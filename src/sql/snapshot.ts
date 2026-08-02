import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface SnapshotFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  copyFile(source: string, destination: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

const systemTempFiles: SnapshotFileSystem = { copyFile, mkdtemp, rm };

export function withDatabaseSnapshot<T>(
  databasePath: string,
  operation: (snapshotPath: string) => Promise<T>,
): Promise<T>;
export function withDatabaseSnapshot<T>(
  databasePath: string,
  files: SnapshotFileSystem,
  operation: (snapshotPath: string) => Promise<T>,
): Promise<T>;
export async function withDatabaseSnapshot<T>(
  databasePath: string,
  filesOrOperation: SnapshotFileSystem | ((snapshotPath: string) => Promise<T>),
  suppliedOperation?: (snapshotPath: string) => Promise<T>,
): Promise<T> {
  const files = typeof filesOrOperation === 'function' ? systemTempFiles : filesOrOperation;
  const operation = typeof filesOrOperation === 'function' ? filesOrOperation : suppliedOperation;
  if (!operation) {
    throw new TypeError('A database snapshot operation is required');
  }

  const temporaryDirectory = await files.mkdtemp(
    path.join(tmpdir(), 'obsidian-browser-sync-'),
  );
  try {
    const snapshotPath = path.join(temporaryDirectory, path.basename(databasePath));
    await files.copyFile(databasePath, snapshotPath);
    return await operation(snapshotPath);
  } finally {
    await files.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
