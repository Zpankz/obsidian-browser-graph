import type { PluginSettings, VaultPort } from '../domain';
import { codecFor, formatForPath, type OutputFormat } from '../output/codec';
import {
  reconcileRecords,
  type BrowserHistoryDocument,
  type HistorySourceFormat,
  type ManagedDocumentParse,
} from '../output/document';
import { destinationPath } from '../output/periods';
import { browserSyncOperationGuard } from './operation-guard';

export interface ConversionSummary {
  converted: number;
  alreadyCurrent: number;
  retained: number;
  skippedReplacement: number;
  failed: Array<{ path: string; category: string }>;
}

export interface ConversionRequest {
  settings: PluginSettings;
}

export interface ConversionDependencies {
  vault: VaultPort;
}

interface ManagedSource extends ManagedDocumentParse {
  path: string;
  format: OutputFormat;
  content: string;
}

interface DestinationGroup {
  path: string;
  period: string;
  sources: ManagedSource[];
}

export async function convertExistingExports(
  request: ConversionRequest,
  dependencies: ConversionDependencies,
): Promise<ConversionSummary> {
  const settings = cloneSettings(request.settings);
  return browserSyncOperationGuard.run(
    async () => await performConversion(settings, dependencies.vault),
  );
}

async function performConversion(
  settings: PluginSettings,
  vault: VaultPort,
): Promise<ConversionSummary> {
  const summary: ConversionSummary = {
    converted: 0,
    alreadyCurrent: 0,
    retained: 0,
    skippedReplacement: 0,
    failed: [],
  };
  const managed = new Map<string, ManagedSource>();
  const invalidManagedPaths = new Set<string>();
  const scannedPaths = new Set<string>();

  await vault.scanFiles(['.md', '.csv', '.json'], ({ path, content }) => {
    scannedPaths.add(path);
    const format = formatForPath(path);
    if (!format || !hasManagedIdentity(format, content)) {
      return;
    }
    try {
      const parsed = codecFor(format).parse(content);
      managed.set(path, { path, format, content, ...parsed });
    } catch {
      invalidManagedPaths.add(path);
      summary.failed.push({ path, category: 'invalid-source' });
    }
  }, settings.outputFolder);

  const groups = groupByDestination(managed.values(), settings);
  for (const group of [...groups.values()].sort(compareGroupPath)) {
    if (invalidManagedPaths.has(group.path)) {
      continue;
    }
    if (!managed.has(group.path) && scannedPaths.has(group.path)) {
      summary.failed.push({ path: group.path, category: 'unmanaged-destination' });
      continue;
    }
    if (!await refreshDestination(group, settings.outputFormat, vault, summary)) {
      continue;
    }
    if (group.sources.length === 0) {
      continue;
    }
    const targetSource = group.sources.find((source) => source.path === group.path);

    const destination = attempt(
      () => mergedDocument(group),
      'conflict',
      group.path,
      summary,
    );
    if (!destination) {
      continue;
    }
    const codec = codecFor(settings.outputFormat);
    const serialized = attempt(
      () => {
        const candidate = codec.serialize(destination);
        codec.parse(candidate, { period: group.period });
        return candidate;
      },
      'validation',
      group.path,
      summary,
    );
    if (serialized === undefined) {
      continue;
    }

    const current = targetSource?.content === serialized;
    if (!current) {
      try {
        await ensureParentFolder(vault, group.path);
        await vault.write(group.path, serialized);
      } catch {
        summary.failed.push({ path: group.path, category: 'write' });
        continue;
      }
    }

    try {
      const written = codec.parse(await vault.read(group.path), {
        period: group.period,
      }).document;
      if (JSON.stringify(written) !== JSON.stringify(destination)) {
        throw new Error('Destination does not match the converted document');
      }
    } catch {
      summary.failed.push({ path: group.path, category: 'read-back' });
      continue;
    }

    if (current) {
      summary.alreadyCurrent += 1;
    } else {
      summary.converted += 1;
    }

    const originalSources = group.sources.filter(
      (source) => source.path !== group.path,
    );
    if (settings.formatConversionBehavior === 'keep') {
      summary.retained += originalSources.length;
      continue;
    }
    for (const source of originalSources) {
      if (source.hasUnrecognizedContent) {
        summary.skippedReplacement += 1;
        continue;
      }
      let currentSource: string;
      try {
        currentSource = await vault.read(source.path);
      } catch {
        summary.failed.push({ path: source.path, category: 'read-source' });
        continue;
      }
      if (currentSource !== source.content) {
        if (hasUnrecognizedMarkdownContent(source, currentSource)) {
          summary.skippedReplacement += 1;
        } else {
          summary.failed.push({ path: source.path, category: 'source-changed' });
        }
        continue;
      }
      try {
        await vault.trash(source.path);
      } catch {
        summary.failed.push({ path: source.path, category: 'trash' });
      }
    }
  }

  summary.failed.sort(compareFailure);
  return summary;
}

function hasUnrecognizedMarkdownContent(
  source: ManagedSource,
  content: string,
): boolean {
  if (source.format !== 'markdown' || !hasManagedIdentity('markdown', content)) {
    return false;
  }
  try {
    return codecFor('markdown').parse(content).hasUnrecognizedContent;
  } catch {
    return false;
  }
}

async function refreshDestination(
  group: DestinationGroup,
  format: OutputFormat,
  vault: VaultPort,
  summary: ConversionSummary,
): Promise<boolean> {
  const scannedTarget = group.sources.find((source) => source.path === group.path);
  let exists: boolean;
  try {
    exists = await vault.exists(group.path);
  } catch {
    summary.failed.push({ path: group.path, category: 'read-destination' });
    return false;
  }
  if (!exists) {
    if (scannedTarget) {
      group.sources = group.sources.filter((source) => source.path !== group.path);
    }
    return true;
  }

  let content: string;
  try {
    content = await vault.read(group.path);
  } catch {
    summary.failed.push({ path: group.path, category: 'read-destination' });
    return false;
  }
  if (scannedTarget?.content === content) {
    return true;
  }
  if (!hasManagedIdentity(format, content)) {
    summary.failed.push({ path: group.path, category: 'unmanaged-destination' });
    return false;
  }
  try {
    const parsed = codecFor(format).parse(content, { period: group.period });
    const refreshed: ManagedSource = {
      path: group.path,
      format,
      content,
      ...parsed,
    };
    group.sources = [
      ...group.sources.filter((source) => source.path !== group.path),
      refreshed,
    ].sort((left, right) => left.path.localeCompare(right.path));
    return true;
  } catch {
    summary.failed.push({ path: group.path, category: 'invalid-destination' });
    return false;
  }
}

function groupByDestination(
  sources: Iterable<ManagedSource>,
  settings: PluginSettings,
): Map<string, DestinationGroup> {
  const groups = new Map<string, DestinationGroup>();
  for (const source of sources) {
    const period = source.document.metadata.period;
    const path = pathForPeriod(settings, period);
    const group = groups.get(path) ?? { path, period, sources: [] };
    group.sources.push(source);
    groups.set(path, group);
  }
  for (const group of groups.values()) {
    group.sources.sort((left, right) => left.path.localeCompare(right.path));
  }
  return groups;
}

function mergedDocument(group: DestinationGroup): BrowserHistoryDocument {
  const records = reconcileRecords(
    group.sources.map((source) => source.document.records),
  );
  return {
    schema_version: 1,
    type: 'browser_history',
    metadata: {
      browser_sync: true,
      period: group.period,
      heading: 'Browser history',
      source_format: mergedSourceFormat(group.sources),
    },
    records,
  };
}

function mergedSourceFormat(sources: ManagedSource[]): HistorySourceFormat {
  const formats = new Set(
    sources.map((source) => source.document.metadata.source_format),
  );
  return formats.size === 1
    ? sources[0].document.metadata.source_format
    : 'obsidian_browser_sync_mixed';
}

function pathForPeriod(settings: PluginSettings, period: string): string {
  const descriptor = dateAndKindForPeriod(period);
  return destinationPath(
    { ...settings, period: descriptor.kind },
    descriptor.date,
  );
}

function dateAndKindForPeriod(
  period: string,
): { date: Date; kind: PluginSettings['period'] } {
  if (/^\d{4}$/.test(period)) {
    return { date: localDate(Number(period), 1, 1), kind: 'year' };
  }
  if (/^\d{4}-\d{2}$/.test(period)) {
    return {
      date: localDate(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1),
      kind: 'month',
    };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    return {
      date: localDate(
        Number(period.slice(0, 4)),
        Number(period.slice(5, 7)),
        Number(period.slice(8, 10)),
      ),
      kind: 'day',
    };
  }

  const weekYear = Number(period.slice(0, 4));
  const week = Number(period.slice(6, 8));
  const januaryFourth = localDate(weekYear, 1, 4);
  const weekday = januaryFourth.getDay() || 7;
  januaryFourth.setDate(januaryFourth.getDate() - weekday + 1 + (week - 1) * 7);
  return { date: januaryFourth, kind: 'week' };
}

function localDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 12);
}

function hasManagedIdentity(format: OutputFormat, content: string): boolean {
  if (format === 'markdown') {
    const lines = content.split(/\r?\n/, 3);
    return lines[0] === '---' && lines[1] === 'browser-sync: true';
  }
  if (format === 'csv') {
    return content.startsWith(
      'schema_version,type,metadata_browser_sync,metadata_period,'
      + 'metadata_heading,metadata_source_format,',
    );
  }
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value)
      && (value.type === 'browser_history'
        || (isRecord(value.metadata) && value.metadata.browser_sync === true));
  } catch {
    return /"type"\s*:\s*"browser_history"/.test(content)
      || /"browser_sync"\s*:\s*true/.test(content);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function ensureParentFolder(vault: VaultPort, path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  if (slash !== -1) {
    await vault.ensureFolder(path.slice(0, slash));
  }
}

function cloneSettings(settings: PluginSettings): PluginSettings {
  return {
    ...settings,
    enabledBrowsers: { ...settings.enabledBrowsers },
  };
}

function compareGroupPath(left: DestinationGroup, right: DestinationGroup): number {
  return left.path.localeCompare(right.path);
}

function compareFailure(
  left: ConversionSummary['failed'][number],
  right: ConversionSummary['failed'][number],
): number {
  return left.path.localeCompare(right.path)
    || left.category.localeCompare(right.category);
}

function attempt<T>(
  operation: () => T,
  category: string,
  path: string,
  summary: ConversionSummary,
): T | undefined {
  try {
    return operation();
  } catch {
    summary.failed.push({ path, category });
    return undefined;
  }
}
