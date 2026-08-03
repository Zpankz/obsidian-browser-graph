import { expect, it } from 'vitest';
import type {
  BrowserProfile,
  NormalizedVisit,
  PersistedData,
} from '../../src/domain';
import {
  ImportAlreadyRunningError,
  runImport,
  type ImportDependencies,
} from '../../src/sync/importer';
import { DEFAULT_SETTINGS } from '../../src/settings';
import {
  fakeVault,
  fakeVaultWithRenderedVisit,
  type FakeVault,
} from '../helpers/fake-vault';
import { renderVisit } from '../../src/output/markdown';
import { visit } from '../helpers/visits';

const profile: BrowserProfile = {
  sourceKey: 'chrome:profile',
  browserId: 'chrome',
  browserName: 'Google Chrome',
  profileId: 'profile',
  profileName: 'Profile',
  databasePath: '/synthetic/History',
  readerKind: 'chromium',
};

function browserProfile(
  sourceKey: string,
  overrides: Partial<BrowserProfile> = {},
): BrowserProfile {
  return {
    ...profile,
    sourceKey,
    profileId: sourceKey,
    profileName: sourceKey,
    databasePath: `/synthetic/${sourceKey}/History`,
    ...overrides,
  };
}

function persisted(overrides: Partial<PersistedData> = {}): PersistedData {
  const defaults: PersistedData = {
    version: 3,
    deviceIdentityHash: 'a'.repeat(64),
    settings: {
      ...DEFAULT_SETTINGS,
      enabledBrowsers: { ...DEFAULT_SETTINGS.enabledBrowsers },
    },
    cursors: {},
  };
  return {
    ...defaults,
    ...overrides,
    settings: overrides.settings ?? defaults.settings,
    cursors: overrides.cursors ?? defaults.cursors,
  };
}

function normalized(overrides: Partial<NormalizedVisit> = {}): NormalizedVisit {
  return visit({
    sourceKey: profile.sourceKey,
    browserId: profile.browserId,
    browserName: profile.browserName,
    profileId: profile.profileId,
    profileName: profile.profileName,
    ...overrides,
  });
}

function normalizedFor(
  owner: BrowserProfile,
  overrides: Partial<NormalizedVisit> = {},
): NormalizedVisit {
  return visit({
    sourceKey: owner.sourceKey,
    browserId: owner.browserId,
    browserName: owner.browserName,
    profileId: owner.profileId,
    profileName: owner.profileName,
    ...overrides,
  });
}

function deps(options: {
  vault: FakeVault;
  visits: NormalizedVisit[];
}): ImportDependencies {
  return {
    discover: async () => [profile],
    readVisits: async () => options.visits,
    vault: options.vault,
    saveData: async () => {},
  };
}

it('imports every visit once and advances each successful profile cursor', async () => {
  const vault = fakeVault();
  const state = persisted();
  const visits = [
    normalized({ sourceVisitId: '1' }),
    normalized({ sourceVisitId: '2', visitedAt: new Date('2026-08-03T12:35:56Z') }),
  ];

  const first = await runImport({ data: state }, deps({ vault, visits }));
  expect(first.imported).toBe(2);
  expect(state.cursors['chrome:profile']).toEqual(
    expect.objectContaining({ sourceVisitId: '2' }),
  );

  const second = await runImport({ data: state }, deps({ vault, visits }));
  expect(second.imported).toBe(0);
  expect(second.alreadyPresent).toBe(2);
  expect(
    vault
      .readText('Browser History/2026/2026-08.md')
      .match(/obsidian-browser-sync/g),
  ).toHaveLength(2);
});

it('does not advance a cursor when one planned note write fails', async () => {
  const state = persisted();
  const vault = fakeVault({
    failAppend: 'Browser History/2026/2026-09.md',
  });
  const visits = [
    normalized({
      sourceVisitId: '1',
      visitedAt: new Date('2026-08-31T12:00:00Z'),
    }),
    normalized({
      sourceVisitId: '2',
      visitedAt: new Date('2026-09-01T12:00:00Z'),
    }),
  ];

  const result = await runImport({ data: state }, deps({ vault, visits }));

  expect(state.cursors['chrome:profile']).toBeUndefined();
  expect(result.failedProfiles).toHaveLength(1);
});

it('recovers from missing cursor state by reading hidden markers', async () => {
  const first = normalized({ sourceVisitId: '1' });
  const second = normalized({
    sourceVisitId: '2',
    visitedAt: new Date('2026-08-03T12:35:56Z'),
  });
  const vault = fakeVaultWithRenderedVisit(first);
  const state = persisted({ cursors: {} });

  const result = await runImport(
    { data: state },
    deps({ vault, visits: [first, second] }),
  );

  expect(result.imported).toBe(1);
  expect(result.alreadyPresent).toBe(1);
});

it('uses vault-wide markers across output folder, layout, period, timezone, and local path changes', async () => {
  const original = normalized({
    sourceKey: 'chrome:path-on-device-a',
    profileId: 'Default',
    sourceVisitId: '41',
    visitedAt: new Date('2026-08-03T00:30:00Z'),
  });
  const moved = {
    ...original,
    sourceKey: 'chrome:path-on-device-b',
  };
  const preserved = `# User archive\n\nDo not rewrite me.\n\n${renderVisit(original)}`;
  const vault = fakeVault({
    files: {
      'Old Output/2026/2026-08/2026-W32/2026-08-02.md': preserved,
    },
  });
  const state = persisted({
    settings: {
      ...DEFAULT_SETTINGS,
      enabledBrowsers: { ...DEFAULT_SETTINGS.enabledBrowsers },
      outputFolder: 'New Output',
      layout: 'flat',
      period: 'year',
    },
  });

  const result = await runImport(
    { data: state },
    deps({ vault, visits: [moved] }),
  );

  expect(result).toMatchObject({ imported: 0, alreadyPresent: 1 });
  expect(vault.readText(
    'Old Output/2026/2026-08/2026-W32/2026-08-02.md',
  )).toBe(preserved);
  expect(() => vault.readText('New Output/2026.md')).toThrow('Missing vault file');
});

it('does not treat markers in non-Markdown vault files as imported state', async () => {
  const input = normalized({ sourceVisitId: '73' });
  const vault = fakeVault({
    files: {
      'Attachments/browser-export.txt': renderVisit(input),
    },
  });

  const result = await runImport(
    { data: persisted() },
    deps({ vault, visits: [input] }),
  );

  expect(result).toMatchObject({ imported: 1, alreadyPresent: 0 });
});

it('rechecks the destination immediately before append to catch a concurrently synced marker', async () => {
  const input = normalized({ sourceVisitId: '74' });
  const path = 'Browser History/2026/2026-08.md';
  const vault = fakeVault({ files: { [path]: '# User note\n\n' } });
  const read = vault.read.bind(vault);
  let reads = 0;
  vault.read = async (candidatePath) => {
    const content = await read(candidatePath);
    reads += 1;
    if (reads === 1) {
      await vault.append(candidatePath, renderVisit(input));
    }
    return content;
  };

  const result = await runImport(
    { data: persisted() },
    deps({ vault, visits: [input] }),
  );

  expect(reads).toBe(2);
  expect(result).toMatchObject({ imported: 0, alreadyPresent: 1 });
  expect(vault.readText(path).match(/obsidian-browser-sync/g)).toHaveLength(1);
});

it('rejects a second import while the shared run guard is active', async () => {
  let releaseDiscovery: (profiles: BrowserProfile[]) => void = () => {};
  let discoveryCalls = 0;
  const discoveryPending = new Promise<BrowserProfile[]>((resolve) => {
    releaseDiscovery = resolve;
  });
  const dependencies: ImportDependencies = {
    discover: () => {
      discoveryCalls += 1;
      return discoveryCalls === 1 ? discoveryPending : Promise.resolve([]);
    },
    readVisits: async () => [],
    vault: fakeVault(),
    saveData: async () => {},
  };

  const first = runImport({ data: persisted() }, dependencies);
  const second = runImport({ data: persisted() }, dependencies);
  releaseDiscovery([profile]);

  await expect(second).rejects.toBeInstanceOf(ImportAlreadyRunningError);
  await first;
});

it('treats absent and disabled browsers as non-failures', async () => {
  const absent = await runImport(
    { data: persisted() },
    {
      discover: async () => [],
      readVisits: async () => {
        throw new Error('unreachable');
      },
      vault: fakeVault(),
      saveData: async () => {},
    },
  );
  expect(absent.failedProfiles).toEqual([]);

  const disabledProfile = browserProfile('safari:profile', {
    browserId: 'safari',
    browserName: 'Safari',
    readerKind: 'safari',
  });
  const state = persisted();
  state.settings.enabledBrowsers.safari = false;
  const disabled = await runImport(
    { data: state },
    {
      discover: async () => [disabledProfile],
      readVisits: async () => {
        throw new Error('unreachable');
      },
      vault: fakeVault(),
      saveData: async () => {},
    },
  );
  expect(disabled.skippedProfiles).toBe(1);
  expect(disabled.failedProfiles).toEqual([]);
});

it('keeps importing healthy profiles when another profile is corrupt', async () => {
  const corrupt = browserProfile('chrome:corrupt');
  const healthy = browserProfile('chrome:healthy');
  const healthyVisit = normalizedFor(healthy, { sourceVisitId: '7' });
  const state = persisted();

  const result = await runImport(
    { data: state },
    {
      discover: async () => [corrupt, healthy],
      readVisits: async (candidate) => {
        if (candidate.sourceKey === corrupt.sourceKey) {
          throw new Error('Unsupported Chromium history schema');
        }
        return [healthyVisit];
      },
      vault: fakeVault(),
      saveData: async () => {},
    },
  );

  expect(result.imported).toBe(1);
  expect(result.failedProfiles).toEqual([
    {
      sourceKey: corrupt.sourceKey,
      message: 'Unsupported Chromium history schema',
    },
  ]);
  expect(state.cursors[corrupt.sourceKey]).toBeUndefined();
  expect(state.cursors[healthy.sourceKey]?.sourceVisitId).toBe('7');
});

it('serializes two profiles into one note in stable chronological order', async () => {
  const laterProfile = browserProfile('chrome:later');
  const earlierProfile = browserProfile('chrome:earlier');
  const later = normalizedFor(laterProfile, {
    sourceVisitId: '20',
    title: 'Later visit',
    visitedAt: new Date('2026-08-03T13:00:00Z'),
  });
  const earlier = normalizedFor(earlierProfile, {
    sourceVisitId: '10',
    title: 'Earlier visit',
    visitedAt: new Date('2026-08-03T11:00:00Z'),
  });
  const vault = fakeVault();

  const result = await runImport(
    { data: persisted() },
    {
      discover: async () => [laterProfile, earlierProfile],
      readVisits: async (candidate) =>
        candidate.sourceKey === laterProfile.sourceKey ? [later] : [earlier],
      vault,
      saveData: async () => {},
    },
  );

  const note = vault.readText('Browser History/2026/2026-08.md');
  expect(result.imported).toBe(2);
  expect(note.indexOf('Earlier visit')).toBeLessThan(note.indexOf('Later visit'));
  expect(note.match(/obsidian-browser-sync/g)).toHaveLength(2);
});

it('attributes a shared write failure to every contributor and commits unrelated profiles', async () => {
  const firstContributor = browserProfile('chrome:first');
  const secondContributor = browserProfile('chrome:second');
  const unrelated = browserProfile('chrome:unrelated');
  const visits = new Map<string, NormalizedVisit[]>([
    [firstContributor.sourceKey, [normalizedFor(firstContributor, {
      sourceVisitId: '1',
      visitedAt: new Date('2026-09-01T10:00:00Z'),
    })]],
    [secondContributor.sourceKey, [normalizedFor(secondContributor, {
      sourceVisitId: '2',
      visitedAt: new Date('2026-09-01T11:00:00Z'),
    })]],
    [unrelated.sourceKey, [normalizedFor(unrelated, {
      sourceVisitId: '3',
      visitedAt: new Date('2026-08-01T10:00:00Z'),
    })]],
  ]);
  const state = persisted();

  const result = await runImport(
    { data: state },
    {
      discover: async () => [firstContributor, secondContributor, unrelated],
      readVisits: async (candidate) => visits.get(candidate.sourceKey) ?? [],
      vault: fakeVault({ failAppend: 'Browser History/2026/2026-09.md' }),
      saveData: async () => {},
    },
  );

  expect(result.imported).toBe(1);
  expect(result.failedProfiles.map(({ sourceKey }) => sourceKey).sort()).toEqual([
    firstContributor.sourceKey,
    secondContributor.sourceKey,
  ].sort());
  expect(state.cursors[firstContributor.sourceKey]).toBeUndefined();
  expect(state.cursors[secondContributor.sourceKey]).toBeUndefined();
  expect(state.cursors[unrelated.sourceKey]?.sourceVisitId).toBe('3');
});

it('does not fail a profile whose shared-path candidate was already present', async () => {
  const recovered = browserProfile('chrome:recovered');
  const contributor = browserProfile('chrome:contributor');
  const recoveredVisit = normalizedFor(recovered, { sourceVisitId: '1' });
  const newVisit = normalizedFor(contributor, {
    sourceVisitId: '2',
    visitedAt: new Date('2026-08-03T13:00:00Z'),
  });
  const state = persisted();
  const vault = fakeVaultWithRenderedVisit(recoveredVisit, {
    failAppend: 'Browser History/2026/2026-08.md',
  });

  const result = await runImport(
    { data: state },
    {
      discover: async () => [recovered, contributor],
      readVisits: async (candidate) =>
        candidate.sourceKey === recovered.sourceKey
          ? [recoveredVisit]
          : [newVisit],
      vault,
      saveData: async () => {},
    },
  );

  expect(result.alreadyPresent).toBe(1);
  expect(result.failedProfiles).toEqual([
    expect.objectContaining({ sourceKey: contributor.sourceKey }),
  ]);
  expect(state.cursors[recovered.sourceKey]?.sourceVisitId).toBe('1');
  expect(state.cursors[contributor.sourceKey]).toBeUndefined();
});

it('rolls back a cursor when persistence fails and recovers from the written marker', async () => {
  const state = persisted();
  const vault = fakeVault();
  const input = normalized({ sourceVisitId: '9' });
  const failingDependencies = deps({ vault, visits: [input] });
  failingDependencies.saveData = async () => {
    throw new Error('Could not save plugin state');
  };

  const first = await runImport({ data: state }, failingDependencies);

  expect(first.imported).toBe(1);
  expect(first.failedProfiles).toEqual([
    {
      sourceKey: profile.sourceKey,
      message: 'Could not save plugin state',
    },
  ]);
  expect(state.cursors[profile.sourceKey]).toBeUndefined();

  const second = await runImport(
    { data: state },
    deps({ vault, visits: [input] }),
  );
  expect(second.imported).toBe(0);
  expect(second.alreadyPresent).toBe(1);
  expect(state.cursors[profile.sourceKey]?.sourceVisitId).toBe('9');
});

it('advances timestamp and visit-ID cursor dimensions independently after clock correction', async () => {
  const futureTimestamp = Date.parse('2026-08-03T13:00:00Z');
  const state = persisted({
    cursors: {
      [profile.sourceKey]: {
        visitedAtMs: futureTimestamp,
        sourceVisitId: '7',
      },
    },
  });
  const corrected = normalized({
    sourceVisitId: '8',
    visitedAt: new Date('2026-08-03T10:00:00Z'),
  });

  await runImport({ data: state }, deps({ vault: fakeVault(), visits: [corrected] }));

  expect(state.cursors[profile.sourceKey]).toEqual({
    visitedAtMs: futureTimestamp,
    sourceVisitId: '8',
  });
});

it('uses one immutable settings snapshot for an entire deferred import', async () => {
  const chrome = browserProfile('chrome:original', {
    browserId: 'chrome',
    profileId: 'Default',
  });
  const firefox = browserProfile('firefox:next', {
    browserId: 'firefox',
    browserName: 'Firefox',
    profileId: 'work.default',
    readerKind: 'firefox',
  });
  const state = persisted();
  state.settings.enabledBrowsers.firefox = false;
  let releaseDiscovery!: (profiles: BrowserProfile[]) => void;
  const discovery = new Promise<BrowserProfile[]>((resolve) => {
    releaseDiscovery = resolve;
  });
  const vault = fakeVault();
  const reads: string[] = [];
  const dependencies: ImportDependencies = {
    discover: () => discovery,
    readVisits: async (candidate) => {
      reads.push(candidate.sourceKey);
      return [normalizedFor(candidate, {
        sourceVisitId: candidate.browserId === 'chrome' ? '101' : '202',
        title: candidate.browserId === 'chrome' ? 'Original settings' : 'Next settings',
      })];
    },
    vault,
    saveData: async () => {},
  };

  const active = runImport({ data: state }, dependencies);
  state.settings.enabledBrowsers.chrome = false;
  state.settings.enabledBrowsers.firefox = true;
  state.settings.outputFolder = 'Next History';
  state.settings.layout = 'flat';
  state.settings.period = 'day';
  releaseDiscovery([chrome, firefox]);
  await active;

  expect(reads).toEqual([chrome.sourceKey]);
  expect(vault.readText('Browser History/2026/2026-08.md'))
    .toContain('Original settings');

  await runImport({ data: state }, {
    ...dependencies,
    discover: async () => [chrome, firefox],
  });

  expect(reads).toEqual([chrome.sourceKey, firefox.sourceKey]);
  expect(vault.readText('Next History/2026-08-03.md'))
    .toContain('Next settings');
});
