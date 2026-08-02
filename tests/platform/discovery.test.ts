import { describe, expect, it } from 'vitest';
import { discoverProfiles, type DiscoveryContext } from '../../src/platform/discovery';
import { fakeFs } from '../helpers/fake-fs';

function context(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
  const platform = overrides.platform ?? 'linux';
  return {
    platform,
    homeDir: platform === 'darwin' ? '/Users/alex' : platform === 'win32' ? 'C:\\Users\\alex' : '/home/alex',
    environment: {},
    fs: fakeFs([]),
    ...overrides,
  };
}

describe('discoverProfiles', () => {
  it.each([
    ['darwin', '/Users/alex/Library/Application Support/Google/Chrome'],
    ['win32', 'C:\\Users\\alex\\AppData\\Local\\Google\\Chrome\\User Data'],
    ['linux', '/home/alex/.config/google-chrome'],
  ] as const)('discovers every Chrome profile on %s', async (platform, root) => {
    const slash = platform === 'win32' ? '\\' : '/';
    const fs = fakeFs([
      `${root}${slash}Default${slash}History`,
      `${root}${slash}Profile 1${slash}History`,
      `${root}${slash}Profile 2${slash}History`,
    ]);

    const profiles = await discoverProfiles(context({ platform, fs }));

    expect(profiles.filter((profile) => profile.browserId === 'chrome')).toHaveLength(3);
  });

  it.each([
    ['darwin', '/Users/alex/Library/Application Support'],
    ['win32', 'C:\\Users\\alex\\AppData\\Local'],
    ['linux', '/home/alex/.config'],
  ] as const)('discovers each Chromium browser on %s', async (platform, base) => {
    const slash = platform === 'win32' ? '\\' : '/';
    const roots = platform === 'darwin'
      ? [
          `Google${slash}Chrome`,
          `Microsoft Edge`,
          `BraveSoftware${slash}Brave-Browser`,
          'Chromium',
          'Vivaldi',
        ]
      : platform === 'win32'
        ? [
            `Google${slash}Chrome${slash}User Data`,
            `Microsoft${slash}Edge${slash}User Data`,
            `BraveSoftware${slash}Brave-Browser${slash}User Data`,
            `Chromium${slash}User Data`,
            `Vivaldi${slash}User Data`,
          ]
        : [
            'google-chrome',
            'microsoft-edge',
            `BraveSoftware${slash}Brave-Browser`,
            'chromium',
            'vivaldi',
          ];
    const fs = fakeFs(roots.map((root) => `${base}${slash}${root}${slash}Default${slash}History`));

    expect((await discoverProfiles(context({ platform, fs }))).map((profile) => profile.browserId).sort())
      .toEqual(['brave', 'chrome', 'chromium', 'edge', 'vivaldi']);
  });

  it('discovers a Chromium profile with a nonstandard directory name', async () => {
    const fs = fakeFs(['/home/alex/.config/chromium/Work account/History']);

    expect(await discoverProfiles(context({ fs }))).toContainEqual(expect.objectContaining({
      browserId: 'chromium',
      profileId: 'Work account',
      profileName: 'Work account',
    }));
  });

  it('discovers Firefox profiles from profiles.ini', async () => {
    const fs = fakeFs([], {
      '/home/alex/.mozilla/firefox/profiles.ini': '[Profile0]\nName=Personal\nIsRelative=1\nPath=abc.default-release\n',
      '/home/alex/.mozilla/firefox/abc.default-release/places.sqlite': '',
    });

    expect((await discoverProfiles(context({ fs })))[0]).toMatchObject({
      browserId: 'firefox',
      profileName: 'Personal',
      profileId: 'abc.default-release',
    });
  });

  it('respects absolute Firefox profile paths', async () => {
    const fs = fakeFs([], {
      '/home/alex/.mozilla/firefox/profiles.ini': '[Profile0]\nName=Work\nIsRelative=0\nPath=/mnt/profiles/work\n',
      '/mnt/profiles/work/places.sqlite': '',
    });

    expect(await discoverProfiles(context({ fs }))).toContainEqual(expect.objectContaining({
      profileName: 'Work',
      databasePath: '/mnt/profiles/work/places.sqlite',
    }));
  });

  it('offers Safari only on macOS', async () => {
    const macFs = fakeFs(['/Users/alex/Library/Safari/History.db']);
    expect(await discoverProfiles(context({ platform: 'darwin', homeDir: '/Users/alex', fs: macFs }))).toContainEqual(expect.objectContaining({
      browserId: 'safari',
      profileName: 'History',
    }));
    expect(await discoverProfiles(context({ platform: 'win32', fs: fakeFs([]) }))).not.toContainEqual(expect.objectContaining({ browserId: 'safari' }));
  });

  it('returns no profiles when known browser roots are absent', async () => {
    expect(await discoverProfiles(context({ fs: fakeFs([]) }))).toEqual([]);
  });

  it('uses injected Windows environment locations', async () => {
    const fs = fakeFs(['D:\\Local\\Google\\Chrome\\User Data\\Default\\History']);

    expect(await discoverProfiles(context({
      platform: 'win32',
      environment: { LOCALAPPDATA: 'D:\\Local' },
      fs,
    }))).toContainEqual(expect.objectContaining({ browserId: 'chrome' }));
  });

  it('sorts profiles by canonical database path and gives each one a stable source key', async () => {
    const fs = fakeFs([
      '/home/alex/.config/google-chrome/Zulu/History',
      '/home/alex/.config/google-chrome/Alpha/History',
    ]);

    const profiles = await discoverProfiles(context({ fs }));

    expect(profiles.map((profile) => profile.databasePath)).toEqual([
      '/home/alex/.config/google-chrome/Alpha/History',
      '/home/alex/.config/google-chrome/Zulu/History',
    ]);
    expect(profiles.map((profile) => profile.sourceKey)).toEqual([
      'chrome:e635597be4ab892f',
      'chrome:ec4664a4e70bb7e2',
    ]);
  });
});
