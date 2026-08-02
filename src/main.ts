import { access, readFile, readdir } from 'node:fs/promises';
import { constants as fileSystemConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  FileSystemAdapter,
  Notice,
  Plugin,
} from 'obsidian';
import { ChromiumReader } from './browsers/chromium';
import { FirefoxReader } from './browsers/firefox';
import type { BrowserHistoryReader } from './browsers/reader';
import { SafariReader } from './browsers/safari';
import type {
  BrowserProfile,
  ImportSummary,
  PersistedData,
  PluginSettings,
  ProfileCursor,
  VaultPort,
} from './domain';
import { ObsidianVaultPort } from './obsidian-vault';
import { BROWSER_CATALOG, type DiscoveryPlatform } from './platform/catalog';
import { discoverProfiles, type FileSystemPort } from './platform/discovery';
import { BrowserSyncSettingTab, type DetectedProfileStatus } from './settings-tab';
import { DEFAULT_SETTINGS, isSafeVaultFolder, migratePersistedData } from './settings';
import { createSqliteFactory, type SqliteFactory } from './sql/sqlite';
import { withDatabaseSnapshot } from './sql/snapshot';
import {
  ImportAlreadyRunningError,
  runImport,
  type ImportDependencies,
  type ImportRequest,
} from './sync/importer';

export interface BrowserSyncRuntime {
  platform: DiscoveryPlatform;
  vault: VaultPort;
  discover: ImportDependencies['discover'];
  readVisits: ImportDependencies['readVisits'];
  runImporter(
    request: ImportRequest,
    dependencies: ImportDependencies,
  ): Promise<ImportSummary>;
  permissionDenied?(profile: BrowserProfile): boolean;
  notice(message: string): void;
}

const initialData = (): PersistedData => ({
  version: 1,
  settings: {
    ...DEFAULT_SETTINGS,
    enabledBrowsers: { ...DEFAULT_SETTINGS.enabledBrowsers },
  },
  cursors: {},
});

export default class BrowserSyncPlugin extends Plugin {
  data: PersistedData = initialData();
  private runtime?: BrowserSyncRuntime;
  private lastProfileFailures = new Map<string, string>();
  private persistenceQueue: Promise<void> = Promise.resolve();

  get platform(): DiscoveryPlatform {
    return this.runtime?.platform ?? currentPlatform();
  }

  async onload(): Promise<void> {
    this.data = migratePersistedData(await this.loadData());
    this.runtime = this.createRuntime();
    this.addSettingTab(new BrowserSyncSettingTab(this.app, this));
    this.addCommand({
      id: 'import-browser-history',
      name: 'Import browser history',
      callback: () => this.importBrowserHistory(),
    });
  }

  updateSettings(settings: PluginSettings): Promise<void> {
    if (!validSettings(settings)) {
      return Promise.reject(new Error(
        'Browser Sync settings require a safe vault-relative output folder and supported options.',
      ));
    }

    const requested = cloneSettings(settings);
    const submissionBase = cloneSettings(this.data.settings);
    return this.enqueuePersistence(async () => {
      const composed = applySettingsDelta(
        submissionBase,
        requested,
        this.data.settings,
      );
      const normalized = migratePersistedData({
        version: 1,
        settings: composed,
        cursors: this.data.cursors,
      }).settings;
      if (!validSettings(normalized)) {
        throw new Error('Browser Sync settings changed to an unsupported value.');
      }

      const snapshot = clonePersistedData({
        ...this.data,
        settings: normalized,
      });
      await this.saveData(snapshot);
      this.data.settings = normalized;
    });
  }

  async detectedProfileStatuses(): Promise<DetectedProfileStatus[]> {
    const profiles = await this.requireRuntime().discover();
    return profiles.map((profile) => ({
      profile,
      status: this.profileStatus(profile),
    }));
  }

  async importBrowserHistory(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!validSettings(this.data.settings)) {
      runtime.notice(
        'Browser history import could not start. Choose a valid vault-relative output folder in Browser Sync settings.',
      );
      return;
    }

    try {
      await runtime.vault.ensureFolder(this.data.settings.outputFolder);
      const summary = await runtime.runImporter(
        { data: this.data },
        {
          discover: runtime.discover,
          readVisits: runtime.readVisits,
          vault: runtime.vault,
          saveData: (data) => this.persistCursorData(data),
        },
      );
      this.lastProfileFailures = new Map(
        summary.failedProfiles.map((failure) => [failure.sourceKey, failure.message]),
      );
      logProfileFailures(summary, runtime.platform);
      runtime.notice(completionNotice(summary));
      if (hasSafariPermissionDenial(summary, runtime.platform)) {
        runtime.notice(
          'Safari access was denied. Grant Obsidian Full Disk Access in System Settings, then run the import again.',
        );
      }
      if (summary.failedProfiles.length > 0) {
        runtime.notice(
          'Some browser profiles failed. Close the affected browsers and try again; if the problem continues, check for a Browser Sync update.',
        );
      }
    } catch (error) {
      if (error instanceof ImportAlreadyRunningError) {
        runtime.notice('A browser history import is already running.');
        return;
      }
      if (isSafariPermissionDenial(error, runtime.platform)) {
        runtime.notice(
          'Safari access was denied. Grant Obsidian Full Disk Access in System Settings, then run the import again.',
        );
        return;
      }
      console.error('[Browser Sync] Import failed', {
        category: failureCategory(error),
      });
      runtime.notice(
        'Browser history import failed. Check the output folder and local browser permissions, then try again.',
      );
    }
  }

  protected createRuntime(): BrowserSyncRuntime {
    const platform = currentPlatform();
    const permissionDeniedPaths = new Set<string>();
    const fs = nodeFileSystem(permissionDeniedPaths);
    const sqlite = createSqliteFactory(installedPluginDirectory(this));
    return {
      platform,
      vault: new ObsidianVaultPort(this.app.vault),
      discover: () => discoverProfiles({
        platform,
        homeDir: homedir(),
        environment: process.env,
        fs,
      }),
      readVisits: (profile, cursor) => readProfileVisits(
        profile,
        cursor,
        sqlite,
      ),
      runImporter: runImport,
      permissionDenied: (profile) => permissionDeniedPaths.has(profile.databasePath),
      notice: (message) => {
        new Notice(message);
      },
    };
  }

  private profileStatus(profile: BrowserProfile): string {
    if (this.runtime?.permissionDenied?.(profile)) {
      return profile.browserId === 'safari' && this.platform === 'darwin'
        ? 'Permission denied — grant Obsidian Full Disk Access'
        : 'Permission denied';
    }
    const failure = this.lastProfileFailures.get(profile.sourceKey);
    if (!failure) {
      return this.data.settings.enabledBrowsers[profile.browserId]
        ? 'Ready'
        : 'Detected (disabled)';
    }
    if (
      profile.browserId === 'safari'
      && this.platform === 'darwin'
      && isPermissionDenial(failure)
    ) {
      return 'Permission denied — grant Obsidian Full Disk Access';
    }
    return 'Last import failed';
  }

  private requireRuntime(): BrowserSyncRuntime {
    if (!this.runtime) {
      throw new Error('Browser Sync has not loaded');
    }
    return this.runtime;
  }

  private persistCursorData(data: PersistedData): Promise<void> {
    return this.enqueuePersistence(async () => {
      await this.saveData(clonePersistedData(data));
    });
  }

  private enqueuePersistence(operation: () => Promise<void>): Promise<void> {
    const result = this.persistenceQueue.then(operation);
    this.persistenceQueue = result.then(
      () => undefined,
      async () => {
        // Let the caller restore its in-memory transaction before the next
        // queued snapshot is created.
        await Promise.resolve();
      },
    );
    return result;
  }
}

export function readerFor(kind: BrowserProfile['readerKind']): BrowserHistoryReader {
  switch (kind) {
    case 'chromium':
      return new ChromiumReader();
    case 'firefox':
      return new FirefoxReader();
    case 'safari':
      return new SafariReader();
  }
}

async function readProfileVisits(
  profile: BrowserProfile,
  cursor: ProfileCursor | undefined,
  sqlite: SqliteFactory,
) {
  return withDatabaseSnapshot(profile.databasePath, async (snapshotPath) => {
    const database = await sqlite.open(snapshotPath);
    try {
      return readerFor(profile.readerKind).read(database, profile, cursor);
    } finally {
      database.close();
    }
  });
}

function nodeFileSystem(permissionDeniedPaths: Set<string>): FileSystemPort {
  return {
    async exists(filePath) {
      try {
        await access(filePath, fileSystemConstants.R_OK);
        permissionDeniedPaths.delete(filePath);
        return true;
      } catch (error) {
        if (isPermissionDenial(error)) {
          permissionDeniedPaths.add(filePath);
          return true;
        }
        throw error;
      }
    },
    readFile: (filePath) => readFile(filePath, 'utf8'),
    readDir: (directoryPath) => readdir(directoryPath),
  };
}

function installedPluginDirectory(plugin: BrowserSyncPlugin): string {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error('Browser Sync requires Obsidian desktop file access');
  }
  return path.join(
    adapter.getBasePath(),
    plugin.app.vault.configDir,
    'plugins',
    plugin.manifest.id,
  );
}

function currentPlatform(): DiscoveryPlatform {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return process.platform;
  }
  return 'linux';
}

function validSettings(settings: PluginSettings): boolean {
  return isSafeVaultFolder(settings.outputFolder)
    && (settings.layout === 'flat' || settings.layout === 'tiered')
    && ['day', 'week', 'month', 'year'].includes(settings.period)
    && BROWSER_CATALOG.every(
      ({ browserId }) => typeof settings.enabledBrowsers[browserId] === 'boolean',
    );
}

function cloneSettings(settings: PluginSettings): PluginSettings {
  return {
    ...settings,
    enabledBrowsers: { ...settings.enabledBrowsers },
  };
}

function clonePersistedData(data: PersistedData): PersistedData {
  return {
    version: 1,
    settings: cloneSettings(data.settings),
    cursors: Object.fromEntries(
      Object.entries(data.cursors).map(([sourceKey, cursor]) => [
        sourceKey,
        { ...cursor },
      ]),
    ),
  };
}

function applySettingsDelta(
  base: PluginSettings,
  requested: PluginSettings,
  current: PluginSettings,
): PluginSettings {
  const enabledBrowsers = { ...current.enabledBrowsers };
  for (const { browserId } of BROWSER_CATALOG) {
    if (base.enabledBrowsers[browserId] !== requested.enabledBrowsers[browserId]) {
      enabledBrowsers[browserId] = requested.enabledBrowsers[browserId];
    }
  }
  return {
    enabledBrowsers,
    outputFolder: base.outputFolder === requested.outputFolder
      ? current.outputFolder
      : requested.outputFolder,
    layout: base.layout === requested.layout ? current.layout : requested.layout,
    period: base.period === requested.period ? current.period : requested.period,
  };
}

function completionNotice(summary: ImportSummary): string {
  return [
    'Browser history import complete:',
    `${summary.imported} imported,`,
    `${summary.alreadyPresent} already present,`,
    `${summary.skippedProfiles} skipped,`,
    `${summary.failedProfiles.length} failed.`,
  ].join(' ');
}

function hasSafariPermissionDenial(
  summary: ImportSummary,
  platform: DiscoveryPlatform,
): boolean {
  return platform === 'darwin' && summary.failedProfiles.some(
    ({ sourceKey, message }) => sourceKey.startsWith('safari:')
      && isPermissionDenial(message),
  );
}

function isPermissionDenial(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String(error.code).toUpperCase();
    if (code === 'EACCES' || code === 'EPERM') {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:^|\W)(?:EACCES|EPERM)(?:\W|$)/i.test(message);
}

function isSafariPermissionDenial(
  error: unknown,
  platform: DiscoveryPlatform,
): boolean {
  if (platform !== 'darwin' || !isPermissionDenial(error)) {
    return false;
  }
  if (typeof error === 'object' && error !== null && 'path' in error) {
    return /(?:^|[/\\])Safari(?:[/\\]|$)/i.test(String(error.path));
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:^|[/\\\s])Safari(?:[/\\\s]|$)/i.test(message);
}

function logProfileFailures(
  summary: ImportSummary,
  platform: DiscoveryPlatform,
): void {
  for (const failure of summary.failedProfiles) {
    console.error('[Browser Sync] Profile import failed', {
      sourceKey: failure.sourceKey,
      category: platform === 'darwin'
        && failure.sourceKey.startsWith('safari:')
        && isPermissionDenial(failure.message)
        ? 'permission-denied'
        : failureCategory(failure.message),
    });
  }
}

function failureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isPermissionDenial(error)) {
    return 'permission-denied';
  }
  if (/schema/i.test(message)) {
    return 'unsupported-schema';
  }
  if (/locked|busy/i.test(message)) {
    return 'database-busy';
  }
  if (/vault|folder|file|write|append/i.test(message)) {
    return 'vault-io';
  }
  return 'unexpected';
}
