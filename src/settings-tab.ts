import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import type {
  BrowserId,
  BrowserProfile,
  NotePeriod,
  OutputLayout,
  PluginSettings,
} from './domain';
import { BROWSER_CATALOG } from './platform/catalog';
import type { DiscoveryPlatform } from './platform/catalog';
import { isSafeVaultFolder } from './settings';

export interface DetectedProfileStatus {
  profile: BrowserProfile;
  status: string;
}

export interface BrowserSyncSettingsHost extends Plugin {
  data: { settings: PluginSettings };
  platform: DiscoveryPlatform;
  updateSettings(settings: PluginSettings): Promise<void>;
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

export class BrowserSyncSettingTab extends PluginSettingTab {
  private displaySequence = 0;

  constructor(
    app: App,
    private readonly browserSyncPlugin: BrowserSyncSettingsHost,
  ) {
    super(app, browserSyncPlugin);
  }

  display(): void {
    const displaySequence = ++this.displaySequence;
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Browsers')
      .setDesc('Choose which locally detected browser profiles to import.')
      .setHeading();

    for (const browser of BROWSER_CATALOG) {
      const unavailable = browser.browserId === 'safari'
        && this.browserSyncPlugin.platform !== 'darwin';
      const row = new Setting(containerEl)
        .setName(browser.browserName)
        .setDesc(unavailable
          ? 'Safari history is available only on macOS.'
          : browserDescriptions[browser.browserId])
        .setDisabled(unavailable);
      row.addToggle((toggle) => toggle
        .setValue(this.browserSyncPlugin.data.settings.enabledBrowsers[browser.browserId])
        .setDisabled(unavailable)
        .onChange(async (enabled) => {
          await this.browserSyncPlugin.updateSettings({
            ...this.browserSyncPlugin.data.settings,
            enabledBrowsers: {
              ...this.browserSyncPlugin.data.settings.enabledBrowsers,
              [browser.browserId]: enabled,
            },
          });
        }));
    }

    const outputFolder = new Setting(containerEl)
      .setName('Output folder')
      .setDesc('Vault-relative folder where browser history notes are stored.');
    outputFolder.addText((text) => text
      .setPlaceholder('Browser History')
      .setValue(this.browserSyncPlugin.data.settings.outputFolder)
      .onChange(async (value) => {
        if (!isSafeVaultFolder(value)) {
          outputFolder.setErrorMessage(
            'Enter a vault-relative folder outside .obsidian, without parent traversal.',
          );
          return;
        }
        outputFolder.setErrorMessage(null);
        await this.browserSyncPlugin.updateSettings({
          ...this.browserSyncPlugin.data.settings,
          outputFolder: value,
        });
      }));

    new Setting(containerEl)
      .setName('Layout')
      .setDesc('Store notes directly in the output folder or in year folders.')
      .addDropdown((dropdown) => dropdown
        .addOptions({ flat: 'Flat', tiered: 'Tiered' })
        .setValue(this.browserSyncPlugin.data.settings.layout)
        .onChange(async (value) => {
          await this.browserSyncPlugin.updateSettings({
            ...this.browserSyncPlugin.data.settings,
            layout: value as OutputLayout,
          });
        }));

    new Setting(containerEl)
      .setName('Note period')
      .setDesc('Choose how imported visits are grouped into notes.')
      .addDropdown((dropdown) => dropdown
        .addOptions({
          day: 'Day',
          week: 'ISO week',
          month: 'Month',
          year: 'Year',
        })
        .setValue(this.browserSyncPlugin.data.settings.period)
        .onChange(async (value) => {
          await this.browserSyncPlugin.updateSettings({
            ...this.browserSyncPlugin.data.settings,
            period: value as NotePeriod,
          });
        }));

    new Setting(containerEl)
      .setName('Detected profiles')
      .setDesc('Read-only availability and permission status for local profiles.')
      .setHeading();

    void this.renderProfileStatuses(displaySequence);
  }

  private async renderProfileStatuses(displaySequence: number): Promise<void> {
    try {
      const statuses = await this.browserSyncPlugin.detectedProfileStatuses();
      if (displaySequence !== this.displaySequence) {
        return;
      }

      const byBrowser = new Map<BrowserId, DetectedProfileStatus[]>();
      for (const status of statuses) {
        const browserStatuses = byBrowser.get(status.profile.browserId) ?? [];
        browserStatuses.push(status);
        byBrowser.set(status.profile.browserId, browserStatuses);
      }

      for (const browser of BROWSER_CATALOG) {
        const browserStatuses = byBrowser.get(browser.browserId) ?? [];
        if (browserStatuses.length === 0) {
          const unavailable = browser.browserId === 'safari'
            && this.browserSyncPlugin.platform !== 'darwin';
          this.statusRow(
            browser.browserName,
            unavailable ? 'Unavailable on this platform' : 'Not detected',
          );
          continue;
        }
        for (const { profile, status } of browserStatuses) {
          this.statusRow(`${profile.browserName} — ${profile.profileName}`, status);
        }
      }
    } catch {
      if (displaySequence === this.displaySequence) {
        this.statusRow('Detection status', 'Could not check local browser profiles');
      }
    }
  }

  private statusRow(name: string, status: string): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(status)
      .setClass('browser-sync-status-row');
  }
}
