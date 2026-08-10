import type {
  BrowserProfile,
  ImportSummary,
  NormalizedVisit,
  PersistedData,
  PluginSettings,
  ProfileCursor,
  VaultPort,
} from '../domain';
import {
  extractImportedIds,
  newNote,
  renderHistoryRecord,
} from '../output/markdown';
import { codecFor, formatForPath, type OutputFormat } from '../output/codec';
import {
  compareHistoryRecords,
  reconcileRecords,
  recordFromVisit,
  type BrowserHistoryDocument,
  type BrowserHistoryRecord,
  type HistorySourceFormat,
} from '../output/document';
import { destinationPath, periodFor } from '../output/periods';
import { browserSyncOperationGuard } from './operation-guard';

export interface ImportDependencies {
  discover: () => Promise<BrowserProfile[]>;
  readVisits: (
    profile: BrowserProfile,
    cursor?: ProfileCursor,
  ) => Promise<NormalizedVisit[]>;
  vault: VaultPort;
  saveData: (data: PersistedData) => Promise<void>;
}

export interface ImportRequest {
  data: PersistedData;
  settings?: PluginSettings;
  rebuild?: boolean;
}

export async function runImport(
  request: ImportRequest,
  dependencies: ImportDependencies,
): Promise<ImportSummary> {
  return browserSyncOperationGuard.run(async () => {
    const settings = cloneSettings(request.settings ?? request.data.settings);
    if (request.rebuild) {
      await resetCursorsForRebuild(request.data, dependencies.saveData);
    }
    return await performImport(
      request,
      dependencies,
      settings,
      request.rebuild ? settings.outputFolder : undefined,
    );
  });
}

interface ProfileResult {
  profile: BrowserProfile;
  visits: NormalizedVisit[];
}

interface Candidate {
  id: string;
  owner: ProfileResult;
  record: BrowserHistoryRecord;
}

interface DestinationGroup {
  label: string;
  candidates: Candidate[];
}

async function performImport(
  request: ImportRequest,
  dependencies: ImportDependencies,
  settings: PluginSettings,
  markerRoot?: string,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    imported: 0,
    alreadyPresent: 0,
    skippedProfiles: 0,
    failedProfiles: [],
  };
  const managedIds = await readManagedMarkerIndex(dependencies.vault, markerRoot);
  const profiles = await dependencies.discover();
  const enabledProfiles = profiles.filter((profile) => {
    const enabled = settings.enabledBrowsers[profile.browserId];
    if (!enabled) {
      summary.skippedProfiles += 1;
    }
    return enabled;
  });
  const readResults = await Promise.all(enabledProfiles.map(async (profile) => {
    try {
      return {
        profile,
        visits: await dependencies.readVisits(
          profile,
          request.data.cursors[profile.sourceKey],
        ),
      };
    } catch (error) {
      summary.failedProfiles.push({
        sourceKey: profile.sourceKey,
        message: errorMessage(error),
      });
      return undefined;
    }
  }));
  const successfulReads = readResults.filter(
    (result): result is ProfileResult => result !== undefined,
  );
  const groups = groupDestinations(successfulReads, settings);
  const failedProfileWrites = new Map<string, string>();

  for (const [path, group] of sortedGroups(groups)) {
    let contributors = new Set<string>();
    try {
      const pending = candidatesMissingFromIndex(
        group.candidates,
        managedIds,
        summary,
      );
      contributors = contributorKeys(pending);
      if (pending.length === 0) {
        continue;
      }

      const existing = await readExisting(dependencies.vault, path);
      addDestinationIds(
        managedIds,
        settings.outputFormat,
        existing,
        group.label,
      );
      const pendingAfterRead = candidatesMissingFromIndex(
        pending,
        managedIds,
        summary,
      );
      contributors = contributorKeys(pendingAfterRead);

      if (pendingAfterRead.length > 0) {
        const latestExisting = await readExisting(dependencies.vault, path);
        addDestinationIds(
          managedIds,
          settings.outputFormat,
          latestExisting,
          group.label,
        );
        const appendable = candidatesMissingFromIndex(
          pendingAfterRead,
          managedIds,
          summary,
        );
        contributors = contributorKeys(appendable);
        if (appendable.length > 0) {
          if (settings.outputFormat === 'markdown') {
            await appendEntries(
              dependencies.vault,
              path,
              group.label,
              latestExisting,
              appendable.map((candidate) => renderHistoryRecord(candidate.record)),
            );
          } else {
            await writeStructuredEntries(
              dependencies.vault,
              path,
              group.label,
              settings.outputFormat,
              latestExisting,
              appendable.map((candidate) => candidate.record),
            );
          }
          for (const candidate of appendable) {
            managedIds.add(candidate.id);
          }
          summary.imported += appendable.length;
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      for (const sourceKey of contributors) {
        if (!failedProfileWrites.has(sourceKey)) {
          failedProfileWrites.set(sourceKey, message);
        }
      }
    }
  }

  for (const result of successfulReads) {
    const profileFailure = failedProfileWrites.get(result.profile.sourceKey);
    if (profileFailure) {
      summary.failedProfiles.push({
        sourceKey: result.profile.sourceKey,
        message: profileFailure,
      });
      continue;
    }

    const sourceKey = result.profile.sourceKey;
    const previous = request.data.cursors[sourceKey];
    const newest = newestCursor(result.visits, previous);
    if (newest && !sameCursor(previous, newest)) {
      request.data.cursors[sourceKey] = newest;
      try {
        await dependencies.saveData(request.data);
      } catch (error) {
        if (previous) {
          request.data.cursors[sourceKey] = previous;
        } else {
          delete request.data.cursors[sourceKey];
        }
        summary.failedProfiles.push({
          sourceKey,
          message: errorMessage(error),
        });
      }
    }
  }

  return summary;
}

function groupDestinations(
  profiles: ProfileResult[],
  settings: PluginSettings,
): Map<string, DestinationGroup> {
  const groups = new Map<string, DestinationGroup>();
  for (const owner of profiles) {
    for (const candidate of owner.visits) {
      const path = destinationPath(settings, candidate.visitedAt);
      const group = groups.get(path) ?? {
        label: periodFor(candidate.visitedAt, settings.period).label,
        candidates: [],
      };
      const record = recordFromVisit(candidate);
      group.candidates.push({ id: record.sync!.id, owner, record });
      groups.set(path, group);
    }
  }

  for (const group of groups.values()) {
    group.candidates.sort(compareCandidates);
  }
  return groups;
}

function sortedGroups(
  groups: Map<string, DestinationGroup>,
): Array<[string, DestinationGroup]> {
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return compareHistoryRecords(left.record, right.record);
}

async function readExisting(vault: VaultPort, path: string): Promise<string | undefined> {
  return await vault.exists(path) ? vault.read(path) : undefined;
}

async function readManagedMarkerIndex(
  vault: VaultPort,
  root?: string,
): Promise<Set<string>> {
  const importedIds = new Set<string>();
  await vault.scanFiles(['.md', '.csv', '.json'], ({ path, content }) => {
    const format = formatForPath(path);
    if (!format) {
      return;
    }
    if (format === 'markdown' && !hasManagedMarkdownIdentity(content)) {
      for (const id of extractImportedIds(content)) {
        importedIds.add(id);
      }
      return;
    }
    try {
      const parsed = codecFor(format).parse(content);
      addRecordIds(importedIds, parsed.document.records);
    } catch {
      // Unsupported and malformed vault files are not managed history exports.
    }
  }, root);
  return importedIds;
}

function candidatesMissingFromIndex(
  candidates: Candidate[],
  importedIds: Set<string>,
  summary: ImportSummary,
): Candidate[] {
  const pending: Candidate[] = [];
  const pendingIds = new Set<string>();
  for (const candidate of candidates) {
    if (importedIds.has(candidate.id) || pendingIds.has(candidate.id)) {
      summary.alreadyPresent += 1;
      continue;
    }
    pendingIds.add(candidate.id);
    pending.push(candidate);
  }
  return pending;
}

function contributorKeys(candidates: Candidate[]): Set<string> {
  return new Set(
    candidates.map((candidate) => candidate.owner.profile.sourceKey),
  );
}

function addDestinationIds(
  importedIds: Set<string>,
  format: OutputFormat,
  content: string | undefined,
  period: string,
): void {
  if (content === undefined) {
    return;
  }
  if (format === 'markdown') {
    if (hasManagedMarkdownIdentity(content)) {
      const parsed = codecFor(format).parse(content, { period });
      addRecordIds(importedIds, parsed.document.records);
    } else {
      for (const id of extractImportedIds(content)) {
        importedIds.add(id);
      }
    }
    return;
  }
  const parsed = codecFor(format).parse(content, { period });
  addRecordIds(importedIds, parsed.document.records);
}

function hasManagedMarkdownIdentity(content: string): boolean {
  const lines = content.split(/\r?\n/, 3);
  return lines[0] === '---' && lines[1] === 'browser-sync: true';
}

function addRecordIds(
  importedIds: Set<string>,
  records: BrowserHistoryRecord[],
): void {
  for (const record of records) {
    if (record.sync) {
      importedIds.add(record.sync.id);
    }
  }
}

async function writeStructuredEntries(
  vault: VaultPort,
  path: string,
  period: string,
  format: Exclude<OutputFormat, 'markdown'>,
  existing: string | undefined,
  records: BrowserHistoryRecord[],
): Promise<void> {
  const codec = codecFor(format);
  const parsedExisting = existing === undefined
    ? undefined
    : codec.parse(existing, { period }).document;
  const mergedDocument = historyDocument(
    period,
    reconcileRecords([parsedExisting?.records ?? [], records]),
    importedSourceFormat(parsedExisting),
  );
  const serialized = codec.serialize(mergedDocument);
  codec.parse(serialized, { period });
  await ensureParentFolder(vault, path);
  await vault.write(path, serialized);
}

function historyDocument(
  period: string,
  records: BrowserHistoryRecord[],
  sourceFormat: HistorySourceFormat,
): BrowserHistoryDocument {
  return {
    schema_version: 1,
    type: 'browser_history',
    metadata: {
      browser_sync: true,
      period,
      heading: 'Browser history',
      source_format: sourceFormat,
    },
    records,
  };
}

function importedSourceFormat(
  existing: BrowserHistoryDocument | undefined,
): HistorySourceFormat {
  if (existing === undefined
    || existing.metadata.source_format === 'obsidian_browser_sync_browser_database') {
    return 'obsidian_browser_sync_browser_database';
  }
  return 'obsidian_browser_sync_mixed';
}

async function ensureParentFolder(vault: VaultPort, path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  if (slash !== -1) {
    await vault.ensureFolder(path.slice(0, slash));
  }
}

async function resetCursorsForRebuild(
  data: PersistedData,
  saveData: (data: PersistedData) => Promise<void>,
): Promise<void> {
  if (Object.keys(data.cursors).length === 0) {
    return;
  }

  const previousCursors = data.cursors;
  data.cursors = {};
  try {
    await saveData(data);
  } catch (error) {
    data.cursors = previousCursors;
    throw error;
  }
}

async function appendEntries(
  vault: VaultPort,
  path: string,
  label: string,
  existing: string | undefined,
  entries: string[],
): Promise<void> {
  const separator = existing === undefined || existing.endsWith('\n\n')
    ? ''
    : existing.endsWith('\n') ? '\n' : '\n\n';
  if (existing === undefined) {
    await ensureParentFolder(vault, path);
    await vault.create(path, newNote(label, []));
  }
  await vault.append(path, separator + entries.join('\n'));
}

function newestCursor(
  visits: NormalizedVisit[],
  current?: ProfileCursor,
): ProfileCursor | undefined {
  let visitedAtMs = current?.visitedAtMs;
  let sourceVisitId = current?.sourceVisitId;
  for (const visit of visits) {
    const timestamp = visit.visitedAt.getTime();
    if (visitedAtMs === undefined || timestamp > visitedAtMs) {
      visitedAtMs = timestamp;
    }
    if (
      sourceVisitId === undefined
      || compareSourceVisitIds(sourceVisitId, visit.sourceVisitId) < 0
    ) {
      sourceVisitId = visit.sourceVisitId;
    }
  }
  return visitedAtMs === undefined || sourceVisitId === undefined
    ? undefined
    : { visitedAtMs, sourceVisitId };
}

function sameCursor(
  left: ProfileCursor | undefined,
  right: ProfileCursor,
): boolean {
  return left?.visitedAtMs === right.visitedAtMs
    && left.sourceVisitId === right.sourceVisitId;
}

function compareSourceVisitIds(left: string, right: string): number {
  if (/^-?\d+$/.test(left) && /^-?\d+$/.test(right)) {
    return compareIntegerStrings(left, right);
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneSettings(settings: PluginSettings): PluginSettings {
  return {
    ...settings,
    enabledBrowsers: { ...settings.enabledBrowsers },
  };
}

function compareIntegerStrings(left: string, right: string): number {
  const leftInteger = canonicalInteger(left);
  const rightInteger = canonicalInteger(right);
  if (leftInteger.negative !== rightInteger.negative) {
    return leftInteger.negative ? -1 : 1;
  }

  const direction = leftInteger.negative ? -1 : 1;
  if (leftInteger.digits.length !== rightInteger.digits.length) {
    return (leftInteger.digits.length < rightInteger.digits.length ? -1 : 1)
      * direction;
  }
  if (leftInteger.digits < rightInteger.digits) {
    return -direction;
  }
  if (leftInteger.digits > rightInteger.digits) {
    return direction;
  }
  return 0;
}

function canonicalInteger(value: string): { digits: string; negative: boolean } {
  const negative = value.startsWith('-');
  const digits = value.slice(negative ? 1 : 0).replace(/^0+(?=\d)/, '');
  return { digits, negative: negative && digits !== '0' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
