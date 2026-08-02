import type { BrowserId, BrowserProfile } from '../domain';

export type DiscoveryPlatform = 'darwin' | 'win32' | 'linux';

export interface BrowserRoot {
  environmentVariable?: 'APPDATA' | 'LOCALAPPDATA';
  fallbackHomePath?: string[];
  homePath?: string[];
}

export interface BrowserCatalogEntry {
  browserId: BrowserId;
  browserName: string;
  readerKind: BrowserProfile['readerKind'];
  roots: Partial<Record<DiscoveryPlatform, BrowserRoot>>;
}

const chromiumRoot = (
  macPath: string[],
  windowsPath: string[],
  linuxPath: string[],
): Partial<Record<DiscoveryPlatform, BrowserRoot>> => ({
  darwin: { homePath: macPath },
  win32: {
    environmentVariable: 'LOCALAPPDATA',
    fallbackHomePath: ['AppData', 'Local'],
    homePath: windowsPath,
  },
  linux: { homePath: linuxPath },
});

export const BROWSER_CATALOG: readonly BrowserCatalogEntry[] = [
  {
    browserId: 'safari',
    browserName: 'Safari',
    readerKind: 'safari',
    roots: { darwin: { homePath: ['Library', 'Safari'] } },
  },
  {
    browserId: 'firefox',
    browserName: 'Firefox',
    readerKind: 'firefox',
    roots: {
      darwin: { homePath: ['Library', 'Application Support', 'Firefox'] },
      win32: {
        environmentVariable: 'APPDATA',
        fallbackHomePath: ['AppData', 'Roaming'],
        homePath: ['Mozilla', 'Firefox'],
      },
      linux: { homePath: ['.mozilla', 'firefox'] },
    },
  },
  {
    browserId: 'chrome',
    browserName: 'Google Chrome',
    readerKind: 'chromium',
    roots: chromiumRoot(
      ['Library', 'Application Support', 'Google', 'Chrome'],
      ['Google', 'Chrome', 'User Data'],
      ['.config', 'google-chrome'],
    ),
  },
  {
    browserId: 'edge',
    browserName: 'Microsoft Edge',
    readerKind: 'chromium',
    roots: chromiumRoot(
      ['Library', 'Application Support', 'Microsoft Edge'],
      ['Microsoft', 'Edge', 'User Data'],
      ['.config', 'microsoft-edge'],
    ),
  },
  {
    browserId: 'brave',
    browserName: 'Brave',
    readerKind: 'chromium',
    roots: chromiumRoot(
      ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'],
      ['BraveSoftware', 'Brave-Browser', 'User Data'],
      ['.config', 'BraveSoftware', 'Brave-Browser'],
    ),
  },
  {
    browserId: 'chromium',
    browserName: 'Chromium',
    readerKind: 'chromium',
    roots: chromiumRoot(
      ['Library', 'Application Support', 'Chromium'],
      ['Chromium', 'User Data'],
      ['.config', 'chromium'],
    ),
  },
  {
    browserId: 'vivaldi',
    browserName: 'Vivaldi',
    readerKind: 'chromium',
    roots: chromiumRoot(
      ['Library', 'Application Support', 'Vivaldi'],
      ['Vivaldi', 'User Data'],
      ['.config', 'vivaldi'],
    ),
  },
];
