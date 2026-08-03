import {
  PluginSettingTab,
  type App,
  type Plugin,
  type Setting,
  type SettingDefinitionItem,
  type SettingGroup,
} from 'obsidian';
import type {
  BrowserId,
  BrowserProfile,
  NotePeriod,
  OutputLayout,
  PluginSettings,
} from './domain';
import { BROWSER_CATALOG, type DiscoveryPlatform } from './platform/catalog';
import { isSafeVaultFolder } from './settings';

export interface DetectedProfileStatus {
  profile: BrowserProfile;
  status: string;
}

export type PluginSettingField =
  | 'outputFolder'
  | 'layout'
  | 'period'
  | `enabledBrowsers.${BrowserId}`;

export interface BrowserSyncSettingsHost extends Plugin {
  data: { settings: PluginSettings };
  platform: DiscoveryPlatform;
  updateSettings(
    settings: PluginSettings,
    changedFields: readonly PluginSettingField[],
  ): Promise<void>;
  detectedProfileStatuses(): Promise<DetectedProfileStatus[]>;
}

const browserDescriptions: Record<BrowserId, string> = {
  safari: 'Import every detected Safari profile.',
  firefox: 'Import every detected Firefox profile.',
  chrome: 'Import every detected Google Chrome profile.',
  edge: 'Import every detected Microsoft Edge profile.',
  brave: 'Import every detected Brave profile.',
  chromium: 'Import every detected Chromium profile.',
  vivaldi: 'Import every detected Vivaldi profile.',
};

const saveError = 'Could not save this setting. Check that the vault is writable, then try again.';
const outputLayouts: readonly OutputLayout[] = ['flat', 'tiered'];
const notePeriods: readonly NotePeriod[] = ['day', 'week', 'month', 'year'];

export class BrowserSyncSettingTab extends PluginSettingTab {
  private statusRenderSequence = 0;

  constructor(
    app: App,
    private readonly browserSyncPlugin: BrowserSyncSettingsHost,
  ) {
    super(app, browserSyncPlugin);
  }

  getSettingDefinitions(): SettingDefinitionItem<PluginSettingField>[] {
    return [
      {
        type: 'group',
        heading: 'Browsers',
        items: BROWSER_CATALOG.map((browser) => {
          const unavailable = browser.browserId === 'safari'
            && this.browserSyncPlugin.platform !== 'darwin';
          return {
            name: browser.browserName,
            desc: unavailable
              ? 'Safari history is available only on macOS.'
              : browserDescriptions[browser.browserId],
            control: {
              type: 'toggle',
              key: `enabledBrowsers.${browser.browserId}` as const,
              disabled: unavailable,
            },
          };
        }),
      },
      {
        name: 'Output folder',
        desc: 'Vault-relative folder where browser history notes are stored.',
        control: {
          type: 'folder',
          key: 'outputFolder',
          placeholder: 'Browser History',
          filter: (folder) => isSafeVaultFolder(folder.path, this.app.vault.configDir),
          validate: (value) => isSafeVaultFolder(value, this.app.vault.configDir)
            ? undefined
            : `Enter a portable vault-relative folder outside ${this.app.vault.configDir}, without reserved path names.`,
        },
      },
      {
        name: 'Layout',
        desc: 'Store notes directly in the output folder or in year folders.',
        control: {
          type: 'dropdown',
          key: 'layout',
          options: { flat: 'Flat', tiered: 'Tiered' },
        },
      },
      {
        name: 'Note period',
        desc: 'Choose how imported visits are grouped into notes.',
        control: {
          type: 'dropdown',
          key: 'period',
          options: {
            day: 'Day',
            week: 'ISO week',
            month: 'Month',
            year: 'Year',
          },
        },
      },
      {
        type: 'group',
        heading: 'Detected profiles',
        items: [{
          name: 'Detection status',
          searchable: false,
          render: (setting, group) => this.renderProfileStatuses(setting, group),
        }],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    if (key === 'outputFolder' || key === 'layout' || key === 'period') {
      return this.browserSyncPlugin.data.settings[key];
    }
    const browserId = browserIdFromField(key);
    return browserId === undefined
      ? undefined
      : this.browserSyncPlugin.data.settings.enabledBrowsers[browserId];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.browserSyncPlugin.data.settings;
    let updated: PluginSettings;
    let field: PluginSettingField;

    if (key === 'outputFolder' && typeof value === 'string') {
      if (!isSafeVaultFolder(value, this.app.vault.configDir)) {
        throw new Error('The output folder is not a safe vault-relative path.');
      }
      updated = { ...settings, outputFolder: value };
      field = key;
    } else if (key === 'layout' && isPermittedValue(value, outputLayouts)) {
      updated = { ...settings, layout: value };
      field = key;
    } else if (key === 'period' && isPermittedValue(value, notePeriods)) {
      updated = { ...settings, period: value };
      field = key;
    } else {
      const browserId = browserIdFromField(key);
      if (browserId === undefined || typeof value !== 'boolean') {
        throw new TypeError(`Unsupported Browser Sync setting: ${key}`);
      }
      updated = {
        ...settings,
        enabledBrowsers: { ...settings.enabledBrowsers, [browserId]: value },
      };
      field = `enabledBrowsers.${browserId}`;
    }

    try {
      await this.browserSyncPlugin.updateSettings(updated, [field]);
    } catch {
      throw new Error(saveError);
    }
  }

  override hide(): void {
    this.statusRenderSequence += 1;
    super.hide();
  }

  private renderProfileStatuses(setting: Setting, group: SettingGroup): void {
    const sequence = ++this.statusRenderSequence;
    this.configureStatusRow(setting, 'Detection status', 'Checking local browser profiles…');
    void this.browserSyncPlugin.detectedProfileStatuses().then(
      (statuses) => {
        if (sequence !== this.statusRenderSequence) {
          return;
        }
        const rows = profileStatusRows(
          statuses,
          this.browserSyncPlugin.platform,
        );
        const [first, ...remaining] = rows;
        this.configureStatusRow(setting, first.name, first.status);
        for (const row of remaining) {
          group.addSetting((additionalSetting) => {
            this.configureStatusRow(additionalSetting, row.name, row.status);
          });
        }
      },
      () => {
        if (sequence === this.statusRenderSequence) {
          this.configureStatusRow(
            setting,
            'Detection status',
            'Could not check local browser profiles',
          );
        }
      },
    );
  }

  private configureStatusRow(setting: Setting, name: string, status: string): void {
    setting
      .setName(name)
      .setDesc(status)
      .setClass('browser-sync-status-row');
  }
}

function browserIdFromField(field: string): BrowserId | undefined {
  return BROWSER_CATALOG.find(
    ({ browserId }) => field === `enabledBrowsers.${browserId}`,
  )?.browserId;
}

function isPermittedValue<T extends string>(
  value: unknown,
  permitted: readonly T[],
): value is T {
  return typeof value === 'string' && permitted.some((candidate) => candidate === value);
}

function profileStatusRows(
  statuses: DetectedProfileStatus[],
  platform: DiscoveryPlatform,
): Array<{ name: string; status: string }> {
  const byBrowser = new Map<BrowserId, DetectedProfileStatus[]>();
  for (const status of statuses) {
    const browserStatuses = byBrowser.get(status.profile.browserId) ?? [];
    browserStatuses.push(status);
    byBrowser.set(status.profile.browserId, browserStatuses);
  }

  return BROWSER_CATALOG.flatMap((browser) => {
    const browserStatuses = byBrowser.get(browser.browserId) ?? [];
    if (browserStatuses.length === 0) {
      const unavailable = browser.browserId === 'safari' && platform !== 'darwin';
      return [{
        name: browser.browserName,
        status: unavailable ? 'Unavailable on this platform' : 'Not detected',
      }];
    }
    return browserStatuses.map(({ profile, status }) => ({
      name: `${profile.browserName} — ${profile.profileName}`,
      status,
    }));
  });
}
