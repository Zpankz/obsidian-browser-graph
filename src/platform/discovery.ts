import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BrowserProfile } from '../domain';
import {
  BROWSER_CATALOG,
  type BrowserCatalogEntry,
  type BrowserRoot,
  type DiscoveryPlatform,
} from './catalog';

export interface FileSystemPort {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  readDir(path: string): Promise<string[]>;
}

export interface DiscoveryContext {
  platform: DiscoveryPlatform;
  homeDir: string;
  environment: Readonly<Record<string, string | undefined>>;
  fs: FileSystemPort;
}

type PathApi = typeof path.posix;

export async function discoverProfiles(context: DiscoveryContext): Promise<BrowserProfile[]> {
  const pathApi = context.platform === 'win32' ? path.win32 : path.posix;
  const candidates = await Promise.all(BROWSER_CATALOG.map(async (browser) => {
    const root = rootPath(browser.roots[context.platform], context, pathApi);
    if (!root) {
      return [];
    }

    if (browser.readerKind === 'safari') {
      return discoverSafari(browser, root, context.fs, pathApi, context.platform);
    }
    if (browser.readerKind === 'firefox') {
      return discoverFirefox(browser, root, context.fs, pathApi, context.platform);
    }
    return discoverChromium(browser, root, context.fs, pathApi, context.platform);
  }));

  return candidates.flat().sort((left, right) => comparePaths(
    canonicalPath(left.databasePath, pathApi, context.platform),
    canonicalPath(right.databasePath, pathApi, context.platform),
  ));
}

function rootPath(
  root: BrowserRoot | undefined,
  context: DiscoveryContext,
  pathApi: PathApi,
): string | undefined {
  if (!root?.homePath) {
    return undefined;
  }
  const environmentBase = root.environmentVariable
    ? context.environment[root.environmentVariable] ?? (root.fallbackHomePath
      ? pathApi.join(context.homeDir, ...root.fallbackHomePath)
      : context.homeDir)
    : context.homeDir;
  return pathApi.normalize(pathApi.join(environmentBase, ...root.homePath));
}

async function discoverSafari(
  browser: BrowserCatalogEntry,
  root: string,
  fs: FileSystemPort,
  pathApi: PathApi,
  platform: DiscoveryPlatform,
): Promise<BrowserProfile[]> {
  const databasePath = pathApi.join(root, 'History.db');
  if (!(await exists(fs, databasePath))) {
    return [];
  }
  return [profile(browser, 'History', 'History', databasePath, pathApi, platform)];
}

async function discoverChromium(
  browser: BrowserCatalogEntry,
  root: string,
  fs: FileSystemPort,
  pathApi: PathApi,
  platform: DiscoveryPlatform,
): Promise<BrowserProfile[]> {
  if (!(await exists(fs, root))) {
    return [];
  }

  const directoryNames = await readDir(fs, root);
  const profiles = await Promise.all(directoryNames.map(async (directoryName) => {
    const databasePath = pathApi.join(root, directoryName, 'History');
    if (!(await exists(fs, databasePath))) {
      return undefined;
    }
    return profile(browser, directoryName, directoryName, databasePath, pathApi, platform);
  }));
  return profiles.filter((candidate): candidate is BrowserProfile => candidate !== undefined);
}

async function discoverFirefox(
  browser: BrowserCatalogEntry,
  root: string,
  fs: FileSystemPort,
  pathApi: PathApi,
  platform: DiscoveryPlatform,
): Promise<BrowserProfile[]> {
  const iniPath = pathApi.join(root, 'profiles.ini');
  const ini = await readFile(fs, iniPath);
  if (ini === undefined) {
    return [];
  }

  const parsedProfiles = parseFirefoxProfiles(ini);
  const candidates = await Promise.all(parsedProfiles.map(async (iniProfile) => {
    if (!iniProfile.path) {
      return undefined;
    }
    const profilePath = iniProfile.isRelative
      ? pathApi.join(root, iniProfile.path)
      : pathApi.normalize(iniProfile.path);
    const databasePath = pathApi.join(profilePath, 'places.sqlite');
    if (!(await exists(fs, databasePath))) {
      return undefined;
    }
    return profile(
      browser,
      iniProfile.path,
      iniProfile.name || iniProfile.path,
      databasePath,
      pathApi,
      platform,
    );
  }));
  return candidates.filter((candidate): candidate is BrowserProfile => candidate !== undefined);
}

function profile(
  browser: BrowserCatalogEntry,
  profileId: string,
  profileName: string,
  databasePath: string,
  pathApi: PathApi,
  platform: DiscoveryPlatform,
): BrowserProfile {
  const canonicalParent = canonicalPath(pathApi.dirname(databasePath), pathApi, platform);
  return {
    sourceKey: `${browser.browserId}:${createHash('sha256').update(canonicalParent).digest('hex').slice(0, 16)}`,
    browserId: browser.browserId,
    browserName: browser.browserName,
    profileId,
    profileName,
    databasePath: pathApi.normalize(databasePath),
    readerKind: browser.readerKind,
  };
}

function canonicalPath(value: string, pathApi: PathApi, platform: DiscoveryPlatform): string {
  const normalized = pathApi.normalize(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function comparePaths(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

async function exists(fs: FileSystemPort, filePath: string): Promise<boolean> {
  try {
    return await fs.exists(filePath);
  } catch {
    return false;
  }
}

async function readFile(fs: FileSystemPort, filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return undefined;
  }
}

async function readDir(fs: FileSystemPort, directoryPath: string): Promise<string[]> {
  try {
    return await fs.readDir(directoryPath);
  } catch {
    return [];
  }
}

interface FirefoxIniProfile {
  isRelative: boolean;
  name: string;
  path: string;
}

function parseFirefoxProfiles(ini: string): FirefoxIniProfile[] {
  const sections: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;
  for (const line of ini.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)]\s*$/.exec(line);
    if (section) {
      current = /^Profile\d+$/i.test(section[1]) ? {} : undefined;
      if (current) {
        sections.push(current);
      }
      continue;
    }
    const keyValue = /^\s*([^=;#][^=]*)=(.*)$/.exec(line);
    if (current && keyValue) {
      current[keyValue[1].trim().toLowerCase()] = keyValue[2].trim();
    }
  }
  return sections
    .filter((section) => section.path)
    .map((section) => ({
      isRelative: section.isrelative !== '0',
      name: section.name ?? '',
      path: section.path,
    }));
}
