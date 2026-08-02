import type {
  BrowserId,
  NotePeriod,
  OutputLayout,
  PersistedData,
  PluginSettings,
  ProfileCursor,
} from './domain';

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

function normalizedVaultFolder(value: string): string | null {
  const candidate = value.trim().replace(/\\/g, '/');

  if (/^(?:\/|[A-Za-z]:\/)/.test(candidate)) {
    return null;
  }

  const parts = candidate.split('/');
  if (parts.some((part) => part === '..')) {
    return null;
  }

  const normalizedParts = parts.filter((part) => part.length > 0 && part !== '.');
  if (
    normalizedParts.length === 0 ||
    normalizedParts[0].toLowerCase() === '.obsidian'
  ) {
    return null;
  }

  return normalizedParts.join('/');
}

export function isSafeVaultFolder(value: unknown): value is string {
  return typeof value === 'string' && normalizedVaultFolder(value) !== null;
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

function migrateSettings(value: unknown): PluginSettings {
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
  const outputFolder = isSafeVaultFolder(value.outputFolder)
    ? normalizedVaultFolder(value.outputFolder) ?? DEFAULT_SETTINGS.outputFolder
    : DEFAULT_SETTINGS.outputFolder;

  return {
    enabledBrowsers,
    outputFolder,
    layout: settingValue(value.layout, outputLayouts, DEFAULT_SETTINGS.layout),
    period: settingValue(value.period, notePeriods, DEFAULT_SETTINGS.period),
  };
}

function migrateCursors(value: unknown): Record<string, ProfileCursor> {
  if (!isRecord(value)) {
    return {};
  }

  const cursors: Record<string, ProfileCursor> = {};
  for (const [sourceKey, cursor] of Object.entries(value)) {
    if (
      !isRecord(cursor) ||
      typeof cursor.visitedAtMs !== 'number' ||
      !Number.isFinite(cursor.visitedAtMs) ||
      typeof cursor.sourceVisitId !== 'string'
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

export function migratePersistedData(raw: unknown): PersistedData {
  const data = isRecord(raw) ? raw : {};

  return {
    version: 1,
    settings: migrateSettings(data.settings),
    cursors: migrateCursors(data.cursors),
  };
}
