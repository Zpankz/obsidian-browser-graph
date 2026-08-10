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
  routingCollision: boolean;
}

const MAX_DESTINATION_WRITE_ATTEMPTS = 3;

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
      const period = periodContextForPath(path, format, settings);
      const parsed = codecFor(format).parse(
        content,
        period === undefined ? {} : { period },
      );
      managed.set(path, { path, format, content, ...parsed });
    } catch {
      invalidManagedPaths.add(path);
      summary.failed.push({ path, category: 'invalid-source' });
    }
  }, settings.outputFolder);

  const groups = groupByDestination(managed.values(), settings);
  for (const group of groups.values()) {
    const occupyingSource = managed.get(group.path);
    if (occupyingSource
      && occupyingSource.document.metadata.period !== group.period) {
      group.routingCollision = true;
    }
  }
  const hasRoutingCollision = [...groups.values()].some(
    (group) => group.routingCollision,
  );
  for (const group of [...groups.values()].sort(compareGroupPath)) {
    if (group.routingCollision) {
      summary.failed.push({ path: group.path, category: 'routing-collision' });
      continue;
    }
    if (invalidManagedPaths.has(group.path)) {
      continue;
    }
    if (!managed.has(group.path) && scannedPaths.has(group.path)) {
      summary.failed.push({ path: group.path, category: 'unmanaged-destination' });
      continue;
    }
    let completed = false;
    for (
      let attemptIndex = 0;
      attemptIndex < MAX_DESTINATION_WRITE_ATTEMPTS;
      attemptIndex += 1
    ) {
      if (!await refreshDestination(group, settings.outputFormat, vault, summary)) {
        break;
      }
      if (group.sources.length === 0) {
        break;
      }
      const targetSource = group.sources.find(
        (source) => source.path === group.path,
      );
      const destination = attempt(
        () => mergedDocument(group),
        'conflict',
        group.path,
        summary,
      );
      if (!destination) {
        break;
      }
      const codec = codecFor(settings.outputFormat);
      const serialized = attempt(
        () => {
          const content = codec.serialize(destination);
          const expectedDocument = codec.parse(content, {
            period: group.period,
          }).document;
          return { content, expectedDocument };
        },
        'validation',
        group.path,
        summary,
      );
      if (serialized === undefined) {
        break;
      }

      const current = targetSource?.content === serialized.content;
      if (!current) {
        let replaced: boolean;
        try {
          await ensureParentFolder(vault, group.path);
          replaced = await vault.writeIfUnchanged(
            group.path,
            targetSource?.content,
            serialized.content,
          );
        } catch {
          summary.failed.push({ path: group.path, category: 'write' });
          break;
        }
        if (!replaced) {
          if (attemptIndex === MAX_DESTINATION_WRITE_ATTEMPTS - 1) {
            summary.failed.push({ path: group.path, category: 'concurrency' });
          }
          continue;
        }
      }

      try {
        const written = codec.parse(await vault.read(group.path), {
          period: group.period,
        }).document;
        if (JSON.stringify(written) !== JSON.stringify(serialized.expectedDocument)) {
          throw new Error('Destination does not match the converted document');
        }
      } catch {
        summary.failed.push({ path: group.path, category: 'read-back' });
        break;
      }

      if (current) {
        summary.alreadyCurrent += 1;
      } else {
        summary.converted += 1;
      }
      completed = true;
      break;
    }
    if (!completed) {
      continue;
    }

    const originalSources = group.sources.filter(
      (source) => source.path !== group.path,
    );
    if (settings.formatConversionBehavior === 'keep') {
      summary.retained += originalSources.length;
      continue;
    }
    if (invalidManagedPaths.size > 0 || hasRoutingCollision) {
      summary.skippedReplacement += originalSources.length;
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
    if (format === 'markdown' && scannedTarget.hasUnrecognizedContent) {
      summary.failed.push({
        path: group.path,
        category: 'user-content-destination',
      });
      return false;
    }
    return true;
  }
  if (!hasManagedIdentity(format, content)) {
    summary.failed.push({ path: group.path, category: 'unmanaged-destination' });
    return false;
  }
  try {
    const parsed = codecFor(format).parse(content, { period: group.period });
    if (parsed.document.metadata.period !== group.period) {
      summary.failed.push({ path: group.path, category: 'routing-collision' });
      return false;
    }
    const refreshed: ManagedSource = {
      path: group.path,
      format,
      content,
      ...parsed,
    };
    if (format === 'markdown' && refreshed.hasUnrecognizedContent) {
      summary.failed.push({
        path: group.path,
        category: 'user-content-destination',
      });
      return false;
    }
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
    const group = groups.get(path) ?? {
      path,
      period,
      sources: [],
      routingCollision: false,
    };
    if (group.period !== period) {
      group.routingCollision = true;
    }
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
      source_format: mergedSourceFormat(group),
    },
    records,
  };
}

function mergedSourceFormat(group: DestinationGroup): HistorySourceFormat {
  const target = group.sources.find((source) => source.path === group.path);
  const nonTargets = target === undefined
    ? group.sources
    : group.sources.filter((source) => source !== target);
  if (nonTargets.length === 0 && target) {
    return target.document.metadata.source_format;
  }
  const formats = new Set(nonTargets.map((source) => sourceFormatFor(source.format)));
  return formats.size === 1
    ? sourceFormatFor(nonTargets[0].format)
    : 'obsidian_browser_sync_mixed';
}

function sourceFormatFor(format: OutputFormat): HistorySourceFormat {
  switch (format) {
    case 'markdown':
      return 'obsidian_browser_sync_markdown';
    case 'csv':
      return 'obsidian_browser_sync_csv';
    case 'json':
      return 'obsidian_browser_sync_json';
  }
}

function pathForPeriod(
  settings: PluginSettings,
  period: string,
  outputFormat: OutputFormat = settings.outputFormat,
): string {
  const descriptor = dateAndKindForPeriod(period);
  return destinationPath(
    { ...settings, period: descriptor.kind, outputFormat },
    descriptor.date,
  );
}

function periodContextForPath(
  path: string,
  format: OutputFormat,
  settings: PluginSettings,
): string | undefined {
  if (format !== 'csv') {
    return undefined;
  }
  const extension = codecFor(format).extension;
  if (!path.toLowerCase().endsWith(extension)) {
    return undefined;
  }
  const basename = path.slice(path.lastIndexOf('/') + 1, -extension.length);
  const token = '{period}';
  const templateParts = settings.fileNameTemplate.split(token);
  if (templateParts.length < 2) {
    return undefined;
  }
  const periodLength = periodKeyLength(settings.period);
  let position = 0;
  let period: string | undefined;
  for (let index = 0; index < templateParts.length; index += 1) {
    const fixedText = templateParts[index];
    if (!basename.startsWith(fixedText, position)) {
      return undefined;
    }
    position += fixedText.length;
    if (index === templateParts.length - 1) {
      continue;
    }
    const candidate = basename.slice(position, position + periodLength);
    if (candidate.length !== periodLength
      || (period !== undefined && candidate !== period)) {
      return undefined;
    }
    period = candidate;
    position += periodLength;
  }
  if (position !== basename.length || period === undefined) {
    return undefined;
  }
  if (!periodMatchesKind(period, settings.period)) {
    return undefined;
  }
  return pathForPeriod(settings, period, format) === path ? period : undefined;
}

function periodKeyLength(kind: PluginSettings['period']): number {
  switch (kind) {
    case 'year':
      return 4;
    case 'month':
      return 7;
    case 'week':
      return 8;
    case 'day':
      return 10;
  }
}

function periodMatchesKind(
  period: string,
  kind: PluginSettings['period'],
): boolean {
  switch (kind) {
    case 'year':
      return /^\d{4}$/.test(period);
    case 'month':
      return /^\d{4}-\d{2}$/.test(period);
    case 'week':
      return /^\d{4}-W\d{2}$/.test(period);
    case 'day':
      return /^\d{4}-\d{2}-\d{2}$/.test(period);
  }
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
