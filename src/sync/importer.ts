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
  renderVisit,
  stableVisitId,
} from '../output/markdown';
import { destinationPath, periodFor } from '../output/periods';

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
}

export class ImportAlreadyRunningError extends Error {
  constructor() {
    super('A browser history import is already running');
    this.name = 'ImportAlreadyRunningError';
  }
}

let importRunning = false;

export async function runImport(
  request: ImportRequest,
  dependencies: ImportDependencies,
): Promise<ImportSummary> {
  if (importRunning) {
    throw new ImportAlreadyRunningError();
  }

  importRunning = true;
  const settings = cloneSettings(request.settings ?? request.data.settings);
  try {
    return await performImport(request, dependencies, settings);
  } finally {
    importRunning = false;
  }
}

interface ProfileResult {
  profile: BrowserProfile;
  visits: NormalizedVisit[];
}

interface Candidate {
  id: string;
  owner: ProfileResult;
  visit: NormalizedVisit;
}

interface DestinationGroup {
  label: string;
  candidates: Candidate[];
}

async function performImport(
  request: ImportRequest,
  dependencies: ImportDependencies,
  settings: PluginSettings,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    imported: 0,
    alreadyPresent: 0,
    skippedProfiles: 0,
    failedProfiles: [],
  };
  const managedIds = await readManagedMarkerIndex(dependencies.vault);
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
    let contributors = new Set(
      group.candidates.map((candidate) => candidate.owner.profile.sourceKey),
    );
    try {
      const existing = await readExisting(dependencies.vault, path);
      for (const id of extractImportedIds(existing ?? '')) {
        managedIds.add(id);
      }
      const pending: Candidate[] = [];
      const pendingIds = new Set<string>();
      contributors = new Set<string>();
      for (const candidate of group.candidates) {
        if (managedIds.has(candidate.id) || pendingIds.has(candidate.id)) {
          summary.alreadyPresent += 1;
          continue;
        }
        pendingIds.add(candidate.id);
        contributors.add(candidate.owner.profile.sourceKey);
        pending.push(candidate);
      }

      if (pending.length > 0) {
        const latestExisting = await readExisting(dependencies.vault, path);
        for (const id of extractImportedIds(latestExisting ?? '')) {
          managedIds.add(id);
        }
        const appendable = pending.filter((candidate) => {
          if (managedIds.has(candidate.id)) {
            summary.alreadyPresent += 1;
            return false;
          }
          return true;
        });
        contributors = new Set(
          appendable.map((candidate) => candidate.owner.profile.sourceKey),
        );
        if (appendable.length > 0) {
          await appendEntries(
            dependencies.vault,
            path,
            group.label,
            latestExisting,
            appendable.map((candidate) => renderVisit(candidate.visit)),
          );
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
      group.candidates.push({
        id: stableVisitId(candidate),
        owner,
        visit: candidate,
      });
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
  const timeOrder = left.visit.visitedAt.getTime() - right.visit.visitedAt.getTime();
  return timeOrder || left.id.localeCompare(right.id);
}

async function readExisting(vault: VaultPort, path: string): Promise<string | undefined> {
  return await vault.exists(path) ? vault.read(path) : undefined;
}

async function readManagedMarkerIndex(vault: VaultPort): Promise<Set<string>> {
  const importedIds = new Set<string>();
  await vault.scanMarkdownFiles((content) => {
    for (const id of extractImportedIds(content)) {
      importedIds.add(id);
    }
  });
  return importedIds;
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
    const slash = path.lastIndexOf('/');
    if (slash !== -1) {
      await vault.ensureFolder(path.slice(0, slash));
    }
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
