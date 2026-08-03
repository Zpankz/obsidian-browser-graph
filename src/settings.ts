import type {
  BrowserId,
  NotePeriod,
  OutputLayout,
  PersistedData,
  PluginSettings,
  ProfileCursor,
} from './domain';
import {
  hashDeviceIdentityToken,
  resolveDeviceIdentity,
} from './device-identity';
import { isSafeVisitTimestamp } from './browsers/reader';
import { normalizeSafeVaultPath } from './vault-path';

export { hashDeviceIdentityToken, resolveDeviceIdentity };

const browserIds: readonly BrowserId[] = [
  'safari',
  'firefox',
  'chrome',
  'edge',
  'brave',
  'chromium',
  'vivaldi',
];

const notePeriods: readonly NotePeriod[] = ['day', 'week', 'month', 'year'];
const outputLayouts: readonly OutputLayout[] = ['flat', 'tiered'];
const DEVICE_IDENTITY_HASH = /^[a-f0-9]{64}$/;
const MAX_SQLITE_VISIT_ID = '9223372036854775807';

export const DEFAULT_SETTINGS: PluginSettings = {
  enabledBrowsers: {
    safari: true,
    firefox: true,
    chrome: true,
    edge: true,
    brave: true,
    chromium: true,
    vivaldi: true,
  },
  outputFolder: 'Browser History',
  layout: 'tiered',
  period: 'month',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedVaultFolder(value: string, configDir?: string): string | null {
  return normalizeSafeVaultPath(value, configDir);
}

export function isSafeVaultFolder(value: unknown, configDir?: string): value is string {
  return typeof value === 'string' && normalizedVaultFolder(value, configDir) !== null;
}

function settingValue<T extends string>(
  value: unknown,
  permitted: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && permitted.includes(value as T)
    ? (value as T)
    : fallback;
}

function migrateSettings(value: unknown, configDir?: string): PluginSettings {
  if (!isRecord(value)) {
    return {
      ...DEFAULT_SETTINGS,
      enabledBrowsers: { ...DEFAULT_SETTINGS.enabledBrowsers },
    };
  }

  const savedBrowsers = isRecord(value.enabledBrowsers)
    ? value.enabledBrowsers
    : {};
  const enabledBrowsers = browserIds.reduce<Record<BrowserId, boolean>>(
    (result, browserId) => {
      result[browserId] =
        typeof savedBrowsers[browserId] === 'boolean'
          ? savedBrowsers[browserId]
          : DEFAULT_SETTINGS.enabledBrowsers[browserId];
      return result;
    },
    {} as Record<BrowserId, boolean>,
  );
  const outputFolder = isSafeVaultFolder(value.outputFolder, configDir)
    ? normalizedVaultFolder(value.outputFolder, configDir) ?? DEFAULT_SETTINGS.outputFolder
    : DEFAULT_SETTINGS.outputFolder;

  return {
    enabledBrowsers,
    outputFolder,
    layout: settingValue(value.layout, outputLayouts, DEFAULT_SETTINGS.layout),
    period: settingValue(value.period, notePeriods, DEFAULT_SETTINGS.period),
  };
}

function migrateCursors(
  value: unknown,
  nowMs: number,
): Record<string, ProfileCursor> {
  if (!isRecord(value)) {
    return {};
  }

  const cursors: Record<string, ProfileCursor> = {};
  for (const [sourceKey, cursor] of Object.entries(value)) {
    if (
      !isRecord(cursor) ||
      !isSafeVisitTimestamp(cursor.visitedAtMs, nowMs) ||
      !Number.isSafeInteger(cursor.visitedAtMs) ||
      typeof cursor.sourceVisitId !== 'string' ||
      !isSafeSourceVisitId(cursor.sourceVisitId)
    ) {
      continue;
    }

    cursors[sourceKey] = {
      visitedAtMs: cursor.visitedAtMs,
      sourceVisitId: cursor.sourceVisitId,
    };
  }

  return cursors;
}

function isSafeSourceVisitId(value: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return false;
  }
  return value.length < MAX_SQLITE_VISIT_ID.length
    || (value.length === MAX_SQLITE_VISIT_ID.length
      && value <= MAX_SQLITE_VISIT_ID);
}

export function migratePersistedData(
  raw: unknown,
  currentDeviceIdentityHash: string,
  nowMs = Date.now(),
  configDir?: string,
): PersistedData {
  if (!DEVICE_IDENTITY_HASH.test(currentDeviceIdentityHash)) {
    throw new Error('Browser Sync requires a hashed local device identity.');
  }
  const data = isRecord(raw) ? raw : {};
  const cursorsBelongToThisDevice = data.version === 3
    && data.deviceIdentityHash === currentDeviceIdentityHash;

  return {
    version: 3,
    deviceIdentityHash: currentDeviceIdentityHash,
    settings: migrateSettings(data.settings, configDir),
    cursors: cursorsBelongToThisDevice ? migrateCursors(data.cursors, nowMs) : {},
  };
}
