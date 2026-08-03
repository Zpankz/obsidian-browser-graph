export type BrowserId =
  | 'safari'
  | 'firefox'
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'chromium'
  | 'vivaldi';

export type NotePeriod = 'day' | 'week' | 'month' | 'year';
export type OutputLayout = 'flat' | 'tiered';

export interface PluginSettings {
  enabledBrowsers: Record<BrowserId, boolean>;
  outputFolder: string;
  layout: OutputLayout;
  period: NotePeriod;
}

export interface ProfileCursor {
  visitedAtMs: number;
  sourceVisitId: string;
}

export interface PersistedData {
  version: 3;
  deviceIdentityHash: string;
  settings: PluginSettings;
  cursors: Record<string, ProfileCursor>;
}

export interface BrowserProfile {
  sourceKey: string;
  browserId: BrowserId;
  browserName: string;
  profileId: string;
  profileName: string;
  databasePath: string;
  readerKind: 'chromium' | 'firefox' | 'safari';
}

export interface NormalizedVisit
  extends Omit<BrowserProfile, 'databasePath' | 'readerKind'> {
  sourceVisitId: string;
  visitedAt: Date;
  title: string;
  url: string;
}

export interface ImportSummary {
  imported: number;
  alreadyPresent: number;
  skippedProfiles: number;
  failedProfiles: Array<{ sourceKey: string; message: string }>;
}

export interface VaultPort {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
  scanMarkdownFiles(
    visit: (markdown: string) => void,
    root?: string,
  ): Promise<void>;
}
