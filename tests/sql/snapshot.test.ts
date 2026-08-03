import { describe, expect, it } from 'vitest';
import {
  type SnapshotFileSystem,
  withDatabaseSnapshot,
} from '../../src/sql/snapshot';

function fakeTempFiles(directory = '/tmp/browser-sync-run'): SnapshotFileSystem & {
  copied: Array<[string, string]>;
  removed: string[];
} {
  return {
    copied: [],
    removed: [],
    async mkdtemp() {
      return directory;
    },
    async copyFile(source, destination) {
      this.copied.push([source, destination]);
    },
    async rm(path) {
      this.removed.push(path);
    },
  };
}

describe('withDatabaseSnapshot', () => {
  it('copies the database into an isolated directory and removes it after success', async () => {
    const temp = fakeTempFiles();

    const result = await withDatabaseSnapshot('/browser/History', temp, async (snapshot) => {
      expect(snapshot).toBe('/tmp/browser-sync-run/History');
      return 'read';
    });

    expect(result).toBe('read');
    expect(temp.copied).toEqual([['/browser/History', '/tmp/browser-sync-run/History']]);
    expect(temp.removed).toEqual(['/tmp/browser-sync-run']);
  });

  it('always removes its isolated snapshot after the callback fails', async () => {
    const temp = fakeTempFiles('/tmp/browser-sync-run');

    await expect(withDatabaseSnapshot('/browser/History', temp, async (snapshot) => {
      expect(snapshot).toBe('/tmp/browser-sync-run/History');
      throw new Error('reader failed');
    })).rejects.toThrow('reader failed');

    expect(temp.removed).toEqual(['/tmp/browser-sync-run']);
  });

  it('removes the isolated directory when copying the database fails', async () => {
    const temp = fakeTempFiles();
    temp.copyFile = async () => {
      throw new Error('copy failed');
    };

    await expect(withDatabaseSnapshot('/browser/History', temp, async () => undefined))
      .rejects.toThrow('copy failed');

    expect(temp.removed).toEqual(['/tmp/browser-sync-run']);
  });

  it('preserves both the primary operation error and a cleanup failure', async () => {
    const temp = fakeTempFiles();
    const operationError = new Error('reader failed first');
    const cleanupError = new Error('permission denied during cleanup');
    temp.rm = async () => {
      throw cleanupError;
    };

    let failure: unknown;
    try {
      await withDatabaseSnapshot('/browser/History', temp, async () => {
        throw operationError;
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('reader failed first');
    expect(failure).toMatchObject({
      cause: operationError,
      cleanupError,
    });
  });

  it('reports cleanup-only failure as a sensitive snapshot that may remain', async () => {
    const temp = fakeTempFiles();
    const cleanupError = new Error('cleanup denied');
    temp.rm = async () => {
      throw cleanupError;
    };

    let failure: unknown;
    try {
      await withDatabaseSnapshot('/browser/History', temp, async () => 'read');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/sensitive.*may remain/i);
    expect((failure as Error).message).toContain('/tmp/browser-sync-run');
    expect(failure).toMatchObject({
      cause: cleanupError,
      cleanupError,
    });
  });
});
