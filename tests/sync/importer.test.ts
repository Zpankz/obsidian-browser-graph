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
    version: 1,
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
