import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface SnapshotFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  copyFile(source: string, destination: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

const systemTempFiles: SnapshotFileSystem = { copyFile, mkdtemp, rm };

export class SnapshotCleanupError extends Error {
  readonly cause: unknown;
  readonly cleanupError: unknown;
  readonly operationError?: unknown;

  constructor(
    readonly temporaryDirectory: string,
    cleanupError: unknown,
    operationFailed: boolean,
    operationError?: unknown,
  ) {
    const cleanupMessage = errorMessage(cleanupError);
    super(operationFailed
      ? `${errorMessage(operationError)}; cleanup also failed for sensitive temporary database snapshot ${temporaryDirectory}: ${cleanupMessage}. The snapshot may remain.`
      : `Cleanup failed for sensitive temporary database snapshot ${temporaryDirectory}: ${cleanupMessage}. The snapshot may remain.`);
    this.name = 'SnapshotCleanupError';
    this.cause = operationFailed ? operationError : cleanupError;
    this.cleanupError = cleanupError;
    if (operationFailed) {
      this.operationError = operationError;
    }
  }
}

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
  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    const snapshotPath = path.join(temporaryDirectory, path.basename(databasePath));
    await files.copyFile(databasePath, snapshotPath);
    result = await operation(snapshotPath);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await files.rm(temporaryDirectory, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new SnapshotCleanupError(
      temporaryDirectory,
      cleanupError,
      operationFailed,
      operationError,
    );
  }

  if (operationFailed) {
    throw operationError;
  }
  return result as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
