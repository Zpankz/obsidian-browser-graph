import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { ChromiumReader } from '../../src/browsers/chromium';
import type {
  BrowserProfile,
  ImportSummary,
  NormalizedVisit,
  PersistedData,
} from '../../src/domain';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { createSqliteFactory } from '../../src/sql/sqlite';
import { withDatabaseSnapshot } from '../../src/sql/snapshot';
import {
  runImport,
  type ImportDependencies,
} from '../../src/sync/importer';
import { BrowserSyncOperationAlreadyRunningError } from '../../src/sync/operation-guard';
import { fakeVault } from '../helpers/fake-vault';
import { visit } from '../helpers/visits';

vi.mock('obsidian', () => {
  class Plugin {
    constructor(
      public app: unknown,
      public manifest: unknown,
    ) {}
  }
  class PluginSettingTab {
    constructor(
      public app: unknown,
      public plugin: unknown,
    ) {}
  }
  class Notice {}
  return {
    Notice,
    Plugin,
    PluginSettingTab,
    normalizePath: (value: string) => value,
  };
});

import type { Command } from 'obsidian';
import BrowserSyncPlugin, {
  type BrowserSyncRuntime,
} from '../../src/main';

const CHROMIUM_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000;
const chromiumTime = (iso: string): number =>
  Date.parse(iso) * 1_000 + CHROMIUM_EPOCH_OFFSET_MICROS;

const chromeProfile: BrowserProfile = {
  sourceKey: 'chrome:profile',
  browserId: 'chrome',
  browserName: 'Google Chrome',
  profileId: 'profile',
  profileName: 'Profile',
  databasePath: '/synthetic/History',
  readerKind: 'chromium',
};

function persisted(overrides: Partial<PersistedData> = {}): PersistedData {
  return {
    version: 3,
    deviceIdentityHash: 'a'.repeat(64),
    settings: {
      ...DEFAULT_SETTINGS,
      enabledBrowsers: { ...DEFAULT_SETTINGS.enabledBrowsers },
    },
    cursors: {},
    ...overrides,
  };
}

function visitFor(
  sourceVisitId: string,
  visitedAt: Date,
): NormalizedVisit {
  return visit({
    sourceKey: chromeProfile.sourceKey,
    browserId: chromeProfile.browserId,
    browserName: chromeProfile.browserName,
    profileId: chromeProfile.profileId,
    profileName: chromeProfile.profileName,
    sourceVisitId,
    visitedAt,
  });
}

async function snapshotDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((entry) =>
    entry.startsWith('obsidian-browser-sync-'),
  );
}

describe('redteam importer hardening', () => {
  it('serializes a concurrent double-import: one wins, the other is rejected', async () => {
    let release!: (profiles: BrowserProfile[]) => void;
    const gate = new Promise<BrowserProfile[]>((resolve) => {
      release = resolve;
    });
    let discoveries = 0;
    const dependencies: ImportDependencies = {
      discover: () => {
        discoveries += 1;
        return discoveries === 1 ? gate : Promise.resolve([]);
      },
      readVisits: async () => [],
      vault: fakeVault(),
      saveData: async () => {},
    };

    const first = runImport({ data: persisted() }, dependencies);
    const second = runImport({ data: persisted() }, dependencies);
    release([chromeProfile]);

    await expect(second).rejects.toBeInstanceOf(
      BrowserSyncOperationAlreadyRunningError,
    );
    const summary = await first;
    expect(summary.failedProfiles).toEqual([]);
    // Guard released: a follow-up import proceeds normally.
    const followUp = await runImport(
      { data: persisted() },
      {
        discover: async () => [],
        readVisits: async () => [],
        vault: fakeVault(),
        saveData: async () => {},
      },
    );
    expect(followUp.failedProfiles).toEqual([]);
  });

  it('treats a missing History file as an empty per-profile failure, not a crash', async () => {
    const state = persisted();
    const missing = Object.assign(
      new Error(
        `ENOENT: no such file or directory, open '/synthetic/History'`,
      ),
      { code: 'ENOENT' },
    );

    const summary = await runImport(
      { data: state },
      {
        discover: async () => [chromeProfile],
        readVisits: async () => {
          throw missing;
        },
        vault: fakeVault(),
        saveData: async () => {},
      },
    );

    expect(summary.imported).toBe(0);
    expect(summary.failedProfiles).toEqual([
      expect.objectContaining({ sourceKey: chromeProfile.sourceKey }),
    ]);
    expect(state.cursors[chromeProfile.sourceKey]).toBeUndefined();
  });

  it('maps a WAL-locked database (SQLITE_BUSY) to a per-profile failure without throwing', async () => {
    const state = persisted();

    const summary = await runImport(
      { data: state },
      {
        discover: async () => [chromeProfile],
        readVisits: async () => {
          throw new Error('database is locked');
        },
        vault: fakeVault(),
        saveData: async () => {},
      },
    );

    expect(summary.imported).toBe(0);
    expect(summary.failedProfiles).toEqual([
      { sourceKey: chromeProfile.sourceKey, message: 'database is locked' },
    ]);
    expect(summary.failedProfiles[0]?.message).toMatch(/locked|busy/i);
    expect(state.cursors[chromeProfile.sourceKey]).toBeUndefined();
  });

  it('skips a disabled browser without calling its reader', async () => {
    const state = persisted();
    state.settings.enabledBrowsers.chrome = false;
    const readVisits = vi.fn(async (): Promise<NormalizedVisit[]> => {
      throw new Error('unreachable');
    });

    const summary = await runImport(
      { data: state },
      {
        discover: async () => [chromeProfile],
        readVisits,
        vault: fakeVault(),
        saveData: async () => {},
      },
    );

    expect(summary.skippedProfiles).toBe(1);
    expect(summary.failedProfiles).toEqual([]);
    expect(readVisits).not.toHaveBeenCalled();
  });

  it('persists a cursor so the second import reads only new rows', async () => {
    const firstVisits = [
      visitFor('1', new Date('2026-08-03T12:34:56Z')),
      visitFor('2', new Date('2026-08-03T12:35:56Z')),
    ];
    const secondVisits = [visitFor('3', new Date('2026-08-03T12:36:56Z'))];
    const seenCursors: unknown[] = [];
    const state = persisted();
    const vault = fakeVault();
    const dependencies: ImportDependencies = {
      discover: async () => [chromeProfile],
      readVisits: async (_profile, cursor) => {
        seenCursors.push(cursor);
        return cursor === undefined ? firstVisits : secondVisits;
      },
      vault,
      saveData: async () => {},
    };

    const first = await runImport({ data: state }, dependencies);
    expect(first.imported).toBe(2);
    expect(state.cursors[chromeProfile.sourceKey]?.sourceVisitId).toBe('2');

    const second = await runImport({ data: state }, dependencies);
    expect(second.imported).toBe(1);
    expect(second.alreadyPresent).toBe(0);
    expect(seenCursors[1]).toMatchObject({ sourceVisitId: '2' });
    expect(state.cursors[chromeProfile.sourceKey]?.sourceVisitId).toBe('3');
  });

  it('converts a corrupt sqlite header into a per-profile failure without throwing', async () => {
    const state = persisted();

    const summary = await runImport(
      { data: state },
      {
        discover: async () => [chromeProfile],
        readVisits: async () => {
          throw new Error('file is not a database');
        },
        vault: fakeVault(),
        saveData: async () => {},
      },
    );

    expect(summary.imported).toBe(0);
    expect(summary.failedProfiles).toEqual([
      { sourceKey: chromeProfile.sourceKey, message: 'file is not a database' },
    ]);
    expect(state.cursors[chromeProfile.sourceKey]).toBeUndefined();
  });
});

describe('redteam sqlite snapshot', () => {
  it('snapshots a WAL-mode database held open by the browser and leaves no temp residue', async () => {
    const before = await snapshotDirs();
    const dir = await mkdtemp(path.join(tmpdir(), 'redteam-wal-'));
    const dbPath = path.join(dir, 'History');
    const native = new DatabaseSync(dbPath);
    let rows: NormalizedVisit[] | undefined;
    try {
      native.exec(
        'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT)',
      );
      native.exec(
        'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL)',
      );
      native.exec('PRAGMA journal_mode=WAL');
      native.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)').run(
        1,
        'https://example.com/',
        'Example',
      );
      native.prepare('INSERT INTO visits (id, url, visit_time) VALUES (?, ?, ?)').run(
        1,
        1,
        chromiumTime('2026-08-03T12:34:56Z'),
      );
      native.exec('PRAGMA wal_checkpoint(TRUNCATE)');

      const sql = await initSqlJs({
        locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
      });
      const factory = createSqliteFactory({
        initialize: async () => sql,
        readFile: (filePath) => import('node:fs/promises').then(({ readFile }) => readFile(filePath)),
        wasmBinary: new Uint8Array(),
      });

      // The native handle stays open (browser lock held) while the snapshot copies.
      rows = await withDatabaseSnapshot(dbPath, async (snapshotPath) => {
        const db = await factory.open(snapshotPath);
        try {
          return new ChromiumReader().read(db, chromeProfile, undefined);
        } finally {
          db.close();
        }
      });
    } finally {
      native.close();
    }

    expect(rows).toHaveLength(1);
    const leaked = (await snapshotDirs()).filter((entry) => !before.includes(entry));
    expect(leaked).toEqual([]);
  });

  it('removes its temp snapshot when the read operation fails (no residue)', async () => {
    const before = await snapshotDirs();
    const dir = await mkdtemp(path.join(tmpdir(), 'redteam-snap-'));
    const source = path.join(dir, 'History');
    await writeFile(source, 'not-a-database');

    await expect(
      withDatabaseSnapshot(source, async () => {
        throw new Error('reader failed');
      }),
    ).rejects.toThrow('reader failed');

    const leaked = (await snapshotDirs()).filter((entry) => !before.includes(entry));
    expect(leaked).toEqual([]);
  });

  it('removes its temp directory when copying a missing database fails', async () => {
    const before = await snapshotDirs();

    await expect(
      withDatabaseSnapshot(
        path.join(tmpdir(), 'redteam-missing-History'),
        async () => 'unreachable',
      ),
    ).rejects.toThrow();

    const leaked = (await snapshotDirs()).filter((entry) => !before.includes(entry));
    expect(leaked).toEqual([]);
  });

  it('proves a corrupt header fails reads with "file is not a database" and the importer contains it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'redteam-corrupt-'));
    const dbPath = path.join(dir, 'History');
    await writeFile(
      dbPath,
      Buffer.from(Array.from({ length: 64 }, (_, index) => index % 7)),
    );
    const sql = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });
    const factory = createSqliteFactory({
      initialize: async () => sql,
      readFile: (filePath) => import('node:fs/promises').then(({ readFile }) => readFile(filePath)),
      wasmBinary: new Uint8Array(),
    });

    let readFailure: unknown;
    try {
      await withDatabaseSnapshot(dbPath, async (snapshotPath) => {
        const db = await factory.open(snapshotPath);
        try {
          new ChromiumReader().read(db, chromeProfile, undefined);
        } finally {
          db.close();
        }
      });
    } catch (error) {
      readFailure = error;
    }
    expect(String((readFailure as Error)?.message ?? readFailure)).toMatch(
      /file is not a database/i,
    );

    // The same corruption wired through the real snapshot stack stays a
    // per-profile failure: runImport resolves instead of throwing.
    const state = persisted();
    const summary = await runImport(
      { data: state },
      {
        discover: async () => [chromeProfile],
        readVisits: async (profile) =>
          withDatabaseSnapshot(profile.databasePath, async (snapshotPath) => {
            const db = await factory.open(snapshotPath);
            try {
              return new ChromiumReader().read(db, profile, undefined);
            } finally {
              db.close();
            }
          }),
        vault: fakeVault(),
        saveData: async () => {},
      },
    );
    expect(summary.failedProfiles).toHaveLength(1);
    expect(summary.failedProfiles[0]?.sourceKey).toBe(chromeProfile.sourceKey);
  });
});

const emptySummary: ImportSummary = {
  imported: 0,
  alreadyPresent: 0,
  skippedProfiles: 0,
  failedProfiles: [],
};

const TOKEN_A = 'a'.repeat(64);

class PluginHarness extends BrowserSyncPlugin {
  readonly commands: Command[] = [];

  constructor(
    private readonly loaded: unknown,
    private readonly fakeRuntime: BrowserSyncRuntime,
  ) {
    super(
      { vault: { configDir: '.obsidian' } } as never,
      { id: 'browser-history-sync' } as never,
    );
  }

  override async loadData(): Promise<unknown> {
    return this.loaded;
  }

  override async saveData(): Promise<void> {}

  override addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }

  override addSettingTab(): void {}

  protected override createRuntime(): BrowserSyncRuntime {
    return this.fakeRuntime;
  }
}

function pluginRuntime(
  overrides: Partial<BrowserSyncRuntime> = {},
): BrowserSyncRuntime {
  return {
    platform: 'linux',
    deviceIdentity: { read: () => TOKEN_A, write: () => {} },
    vault: fakeVault({ files: { 'Browser History/.keep': '' } }),
    discover: async () => [],
    readVisits: async () => [],
    runImporter: async () => emptySummary,
    runConverter: async () =>
      ({
        converted: 0,
        alreadyCurrent: 0,
        retained: 0,
        skippedReplacement: 0,
        failed: [],
      }),
    notice: vi.fn(),
    ...overrides,
  };
}

describe('redteam plugin failure mapping', () => {
  it.each(['EACCES', 'EPERM'])(
    '%s Safari failures map to the permission-denied category with Full Disk Access guidance',
    async (code) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const notice = vi.fn();
      const plugin = new PluginHarness(
        undefined,
        pluginRuntime({
          platform: 'darwin',
          notice,
          runImporter: async () => ({
            ...emptySummary,
            failedProfiles: [
              {
                sourceKey: 'safari:history',
                message: `${code}: permission denied while reading Safari History.db`,
              },
            ],
          }),
        }),
      );
      await plugin.onload();

      await plugin.importBrowserHistory();

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Profile import failed'),
        expect.objectContaining({ category: 'permission-denied' }),
      );
      const notices = notice.mock.calls.flat().join('\n');
      expect(notices).toContain('Full Disk Access');
      expect(notices).toContain('System Settings');
      consoleError.mockRestore();
    },
  );

  it('a corrupt database never throws out of the plugin host', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notice = vi.fn();
    const plugin = new PluginHarness(
      undefined,
      pluginRuntime({
        notice,
        discover: async () => [chromeProfile],
        readVisits: async () => {
          throw new Error('file is not a database');
        },
        runImporter: runImport,
      }),
    );
    await plugin.onload();

    await expect(plugin.importBrowserHistory()).resolves.toBeUndefined();

    const notices = notice.mock.calls.flat().join('\n');
    expect(notices).toContain('1 failed');
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Profile import failed'),
      expect.objectContaining({ category: expect.any(String) }),
    );
    consoleError.mockRestore();
  });
});
