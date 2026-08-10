import { access, readFile, readdir } from 'node:fs/promises';
import { constants as fileSystemConstants } from 'node:fs';
import { homedir } from 'node:os';
import {
  Notice,
  Plugin,
} from 'obsidian';
import { ChromiumReader } from './browsers/chromium';
import { FirefoxReader } from './browsers/firefox';
import type { BrowserHistoryReader } from './browsers/reader';
import { SafariReader } from './browsers/safari';
import type {
  BrowserProfile,
  BrowserId,
  ImportSummary,
  PersistedData,
  PluginSettings,
  ProfileCursor,
  VaultPort,
} from './domain';
import {
  LocalStorageDeviceIdentityPort,
  type DeviceIdentityPort,
} from './device-identity';
import { ObsidianVaultPort } from './obsidian-vault';
import { isSafeFileNameTemplate } from './output/file-name';
import { BROWSER_CATALOG, type DiscoveryPlatform } from './platform/catalog';
import { discoverProfiles, type FileSystemPort } from './platform/discovery';
import {
  BrowserSyncSettingTab,
  type DetectedProfileStatus,
  type PluginSettingField,
} from './settings-tab';
import {
  DEFAULT_SETTINGS,
  isSafeVaultFolder,
  migratePersistedData,
  resolveDeviceIdentity,
} from './settings';
import { createSqliteFactory, type SqliteFactory } from './sql/sqlite';
import { withDatabaseSnapshot } from './sql/snapshot';
import {
  runImport,
  type ImportDependencies,
  type ImportRequest,
} from './sync/importer';
import { BrowserSyncOperationAlreadyRunningError } from './sync/operation-guard';

export interface BrowserSyncRuntime {
  platform: DiscoveryPlatform;
  deviceIdentity: DeviceIdentityPort;
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
  version: 3,
  deviceIdentityHash: '',
  settings: {
    ...DEFAULT_SETTINGS,
    enabledBrowsers: { ...DEFAULT_SETTINGS.enabledBrowsers },
  },
  cursors: {},
});

export default class BrowserSyncPlugin extends Plugin {
  data: PersistedData = initialData();
  private committedData: PersistedData = initialData();
  private runtime?: BrowserSyncRuntime;
  private lastProfileFailures = new Map<string, string>();
  private persistenceQueue: Promise<void> = Promise.resolve();

  get platform(): DiscoveryPlatform {
    return this.runtime?.platform ?? currentPlatform();
  }

  async onload(): Promise<void> {
    const runtime = this.createRuntime();
    const deviceIdentityHash = resolveDeviceIdentity(runtime.deviceIdentity);
    const loaded = migratePersistedData(
      await this.loadData(),
      deviceIdentityHash,
      Date.now(),
      this.app.vault.configDir,
    );
    this.data = clonePersistedData(loaded);
    this.committedData = clonePersistedData(loaded);
    this.runtime = runtime;
    this.addSettingTab(new BrowserSyncSettingTab(this.app, this));
    this.addCommand({
      id: 'import-browser-history',
      name: 'Import browser history',
      callback: () => this.importBrowserHistory(),
    });
    this.addCommand({
      id: 'rebuild-browser-history-output',
      name: 'Rebuild browser history output',
      callback: () => this.importBrowserHistory(true),
    });
  }

  updateSettings(
    settings: PluginSettings,
    changedFields: readonly PluginSettingField[],
  ): Promise<void> {
    if (!validSettings(settings, this.app.vault.configDir)) {
      return Promise.reject(new Error(
        'Browser Sync settings require a safe vault-relative output folder and supported options.',
      ));
    }

    const patch = settingsPatch(settings, changedFields);
    return this.enqueuePersistence(async () => {
      const composed = applySettingsPatch(this.committedData.settings, patch);
      const normalized = migratePersistedData({
        version: 3,
        deviceIdentityHash: this.committedData.deviceIdentityHash,
        settings: composed,
        cursors: this.committedData.cursors,
      }, this.committedData.deviceIdentityHash, Date.now(), this.app.vault.configDir).settings;
      if (!validSettings(normalized, this.app.vault.configDir)) {
        throw new Error('Browser Sync settings changed to an unsupported value.');
      }

      const snapshot = clonePersistedData({
        ...this.committedData,
        settings: normalized,
      });
      await this.saveData(snapshot);
      this.committedData = snapshot;
      this.data.settings = cloneSettings(normalized);
    });
  }

  async detectedProfileStatuses(): Promise<DetectedProfileStatus[]> {
    const profiles = await this.requireRuntime().discover();
    return profiles.map((profile) => ({
      profile,
      status: this.profileStatus(profile),
    }));
  }

  async importBrowserHistory(rebuild = false): Promise<void> {
    const runtime = this.requireRuntime();
    const settings = cloneSettings(this.data.settings);
    if (!validSettings(settings, this.app.vault.configDir)) {
      runtime.notice(
        'Browser history import could not start. Choose a valid vault-relative output folder in Browser Sync settings.',
      );
      return;
    }

    try {
      const outputFolderExists = await runtime.vault.exists(settings.outputFolder);
      await runtime.vault.ensureFolder(settings.outputFolder);
      const rebuildOutput = rebuild || !outputFolderExists;
      const summary = await runtime.runImporter(
        {
          data: this.data,
          settings,
          ...(rebuildOutput ? { rebuild: true } : {}),
        },
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
        if (hasSnapshotCleanupFailure(summary)) {
          runtime.notice(
            'A sensitive temporary database snapshot may remain because cleanup failed. Remove it from the system temporary folder before retrying.',
          );
        }
        runtime.notice(
          'Some browser profiles failed. Close the affected browsers and try again; if the problem continues, check for a Browser Sync update.',
        );
      }
    } catch (error) {
      if (error instanceof BrowserSyncOperationAlreadyRunningError) {
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
    const homeDir = homedir();
    const permissionDeniedPaths = new Set<string>();
    const fs = nodeFileSystem(permissionDeniedPaths);
    const sqlite = createSqliteFactory();
    return {
      platform,
      deviceIdentity: new LocalStorageDeviceIdentityPort(window.localStorage),
      vault: new ObsidianVaultPort(this.app.vault),
      discover: () => discoverProfiles({
        platform,
        homeDir,
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
      const snapshot = clonePersistedData({
        version: 3,
        deviceIdentityHash: this.committedData.deviceIdentityHash,
        settings: this.committedData.settings,
        cursors: data.cursors,
      });
      await this.saveData(snapshot);
      this.committedData = snapshot;
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

export { createSqliteFactory };

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

function currentPlatform(): DiscoveryPlatform {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return process.platform;
  }
  return 'linux';
}

function validSettings(settings: PluginSettings, configDir: string): boolean {
  return isSafeVaultFolder(settings.outputFolder, configDir)
    && isSafeFileNameTemplate(settings.fileNameTemplate)
    && (settings.layout === 'flat' || settings.layout === 'tiered')
    && ['day', 'week', 'month', 'year'].includes(settings.period)
    && ['markdown', 'csv', 'json'].includes(settings.outputFormat)
    && ['keep', 'replace'].includes(settings.formatConversionBehavior)
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
    version: 3,
    deviceIdentityHash: data.deviceIdentityHash,
    settings: cloneSettings(data.settings),
    cursors: Object.fromEntries(
      Object.entries(data.cursors).map(([sourceKey, cursor]) => [
        sourceKey,
        { ...cursor },
      ]),
    ),
  };
}

interface SettingsPatch {
  enabledBrowsers: Partial<Record<BrowserId, boolean>>;
  outputFolder?: string;
  fileNameTemplate?: string;
  layout?: PluginSettings['layout'];
  period?: PluginSettings['period'];
  outputFormat?: PluginSettings['outputFormat'];
  formatConversionBehavior?: PluginSettings['formatConversionBehavior'];
}

function settingsPatch(
  requested: PluginSettings,
  changedFields: readonly PluginSettingField[],
): SettingsPatch {
  const patch: SettingsPatch = { enabledBrowsers: {} };
  for (const field of changedFields) {
    if (field === 'outputFolder') {
      patch.outputFolder = requested.outputFolder;
    } else if (field === 'fileNameTemplate') {
      patch.fileNameTemplate = requested.fileNameTemplate;
    } else if (field === 'layout') {
      patch.layout = requested.layout;
    } else if (field === 'period') {
      patch.period = requested.period;
    } else if (field === 'outputFormat') {
      patch.outputFormat = requested.outputFormat;
    } else if (field === 'formatConversionBehavior') {
      patch.formatConversionBehavior = requested.formatConversionBehavior;
    } else {
      const browserId = field.slice('enabledBrowsers.'.length) as BrowserId;
      patch.enabledBrowsers[browserId] = requested.enabledBrowsers[browserId];
    }
  }
  return patch;
}

function applySettingsPatch(
  current: PluginSettings,
  patch: SettingsPatch,
): PluginSettings {
  return {
    enabledBrowsers: {
      ...current.enabledBrowsers,
      ...patch.enabledBrowsers,
    },
    outputFolder: patch.outputFolder ?? current.outputFolder,
    fileNameTemplate: patch.fileNameTemplate ?? current.fileNameTemplate,
    layout: patch.layout ?? current.layout,
    period: patch.period ?? current.period,
    outputFormat: patch.outputFormat ?? current.outputFormat,
    formatConversionBehavior: patch.formatConversionBehavior
      ?? current.formatConversionBehavior,
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

function hasSnapshotCleanupFailure(summary: ImportSummary): boolean {
  return summary.failedProfiles.some(({ message }) =>
    /sensitive temporary database snapshot[\s\S]*may remain/i.test(message));
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
  if (/sensitive temporary database snapshot|cleanup/i.test(message)) {
    return 'snapshot-cleanup';
  }
  if (/vault|folder|file|write|append/i.test(message)) {
    return 'vault-io';
  }
  return 'unexpected';
}
