import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

interface ComponentRecord<T> {
  disabled: boolean;
  value: T;
  onChange?: (value: T) => Promise<void> | void;
}

interface SettingRecord {
  name?: string;
  description?: string;
  className?: string;
  disabled: boolean;
  error?: string | null;
  toggle?: ComponentRecord<boolean>;
  text?: ComponentRecord<string> & { placeholder?: string };
  dropdown?: ComponentRecord<string> & { options: Record<string, string> };
}

const obsidianMock = vi.hoisted(() => ({
  records: [] as SettingRecord[],
}));

vi.mock('obsidian', () => {
  class Plugin {
    constructor(
      public app: unknown,
      public manifest: unknown,
    ) {}
  }

  class PluginSettingTab {
    containerEl: { empty(): void };

    constructor(
      public app: unknown,
      public plugin: unknown,
    ) {
      this.containerEl = { empty() {} };
    }
  }

  class Setting {
    private readonly record: SettingRecord = { disabled: false };

    constructor(container: unknown) {
      void container;
      obsidianMock.records.push(this.record);
    }

    setName(name: string) {
      this.record.name = name;
      return this;
    }

    setDesc(description: string) {
      this.record.description = description;
      return this;
    }

    setClass(className: string) {
      this.record.className = className;
      return this;
    }

    setHeading() {
      return this;
    }

    setDisabled(disabled: boolean) {
      this.record.disabled = disabled;
      return this;
    }

    setErrorMessage(error: string | null) {
      this.record.error = error;
      return this;
    }

    addToggle(callback: (component: unknown) => void) {
      const record: ComponentRecord<boolean> = { disabled: false, value: false };
      this.record.toggle = record;
      callback({
        setValue(value: boolean) {
          record.value = value;
          return this;
        },
        setDisabled(disabled: boolean) {
          record.disabled = disabled;
          return this;
        },
        onChange(onChange: (value: boolean) => Promise<void> | void) {
          record.onChange = onChange;
          return this;
        },
      });
      return this;
    }

    addText(callback: (component: unknown) => void) {
      const record: ComponentRecord<string> & { placeholder?: string } = {
        disabled: false,
        value: '',
      };
      this.record.text = record;
      callback({
        setValue(value: string) {
          record.value = value;
          return this;
        },
        setPlaceholder(placeholder: string) {
          record.placeholder = placeholder;
          return this;
        },
        onChange(onChange: (value: string) => Promise<void> | void) {
          record.onChange = onChange;
          return this;
        },
      });
      return this;
    }

    addDropdown(callback: (component: unknown) => void) {
      const record: ComponentRecord<string> & { options: Record<string, string> } = {
        disabled: false,
        options: {},
        value: '',
      };
      this.record.dropdown = record;
      callback({
        addOptions(options: Record<string, string>) {
          Object.assign(record.options, options);
          return this;
        },
        setValue(value: string) {
          record.value = value;
          return this;
        },
        onChange(onChange: (value: string) => Promise<void> | void) {
          record.onChange = onChange;
          return this;
        },
      });
      return this;
    }
  }

  class TFile {}
  class TFolder {}

  return {
    FileSystemAdapter: class {},
    Notice: class {},
    Platform: { isMacOS: false },
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
    normalizePath: (value: string) => value,
  };
});

import type {
  App,
  Command,
  PluginManifest,
  PluginSettingTab,
} from 'obsidian';
import { ChromiumReader } from '../src/browsers/chromium';
import { FirefoxReader } from '../src/browsers/firefox';
import { SafariReader } from '../src/browsers/safari';
import type {
  BrowserProfile,
  ImportSummary,
  PersistedData,
  PluginSettings,
} from '../src/domain';
import BrowserSyncPlugin, {
  readerFor,
  type BrowserSyncRuntime,
} from '../src/main';
import { BrowserSyncSettingTab } from '../src/settings-tab';
import { DEFAULT_SETTINGS } from '../src/settings';
import { runImport } from '../src/sync/importer';
import { fakeVault } from './helpers/fake-vault';
import { visit } from './helpers/visits';

const emptySummary: ImportSummary = {
  imported: 0,
  alreadyPresent: 0,
  skippedProfiles: 0,
  failedProfiles: [],
};

function clonedDefaults(): PersistedData {
  return {
    version: 1,
    settings: {
      ...DEFAULT_SETTINGS,
      enabledBrowsers: { ...DEFAULT_SETTINGS.enabledBrowsers },
    },
    cursors: {},
  };
}

function runtime(
  overrides: Partial<BrowserSyncRuntime> = {},
): BrowserSyncRuntime {
  return {
    platform: 'linux',
    vault: fakeVault(),
    discover: vi.fn(async () => []),
    readVisits: vi.fn(async () => []),
    runImporter: vi.fn(async () => emptySummary),
    notice: vi.fn(),
    ...overrides,
  };
}

class PluginHarness extends BrowserSyncPlugin {
  readonly commands: Command[] = [];
  readonly settingTabs: PluginSettingTab[] = [];
  readonly saved: PersistedData[] = [];
  readonly persisted: PersistedData[] = [];

  constructor(
    private readonly loaded: unknown,
    private readonly fakeRuntime: BrowserSyncRuntime,
    private readonly persist: (
      data: PersistedData,
      callIndex: number,
    ) => Promise<void> = async () => {},
  ) {
    super({ vault: {} } as App, { id: 'obsidian-browser-sync' } as PluginManifest);
  }

  override async loadData(): Promise<unknown> {
    return this.loaded;
  }

  override async saveData(data: PersistedData): Promise<void> {
    const snapshot = structuredClone(data);
    this.saved.push(snapshot);
    await this.persist(snapshot, this.saved.length - 1);
    this.persisted.push(snapshot);
  }

  override addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }

  override addSettingTab(settingTab: PluginSettingTab): void {
    this.settingTabs.push(settingTab);
  }

  protected override createRuntime(): BrowserSyncRuntime {
    return this.fakeRuntime;
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setting(name: string): SettingRecord {
  const record = obsidianMock.records.find((candidate) => candidate.name === name);
  if (!record) {
    throw new Error(`Missing setting: ${name}`);
  }
  return record;
}

describe('BrowserSyncPlugin', () => {
  beforeEach(() => {
    obsidianMock.records.length = 0;
  });

  it('registers exactly one manual import command and no startup import', async () => {
    const fakeRuntime = runtime();
    const plugin = new PluginHarness(undefined, fakeRuntime);

    await plugin.onload();

    expect(plugin.commands.map((command) => command.id))
      .toEqual(['import-browser-history']);
    expect(plugin.commands[0].name).toBe('Import browser history');
    expect(fakeRuntime.runImporter).not.toHaveBeenCalled();
    expect(fakeRuntime.discover).not.toHaveBeenCalled();
    expect(plugin.settingTabs).toHaveLength(1);
    expect(plugin.settingTabs[0]).toBeInstanceOf(BrowserSyncSettingTab);

    await plugin.commands[0].callback?.();

    expect(fakeRuntime.runImporter).toHaveBeenCalledOnce();
  });

  it('migrates loaded data and persists settings through one validated method', async () => {
    const plugin = new PluginHarness({
      settings: { outputFolder: '../private', layout: 'wide' },
      cursors: { invalid: { visitedAtMs: 'yesterday' } },
    }, runtime());
    await plugin.onload();

    expect(plugin.data).toEqual(clonedDefaults());

    const settings: PluginSettings = {
      ...plugin.data.settings,
      enabledBrowsers: { ...plugin.data.settings.enabledBrowsers, edge: false },
      outputFolder: 'Imported History',
      layout: 'flat',
      period: 'week',
    };
    await plugin.updateSettings(settings, [
      'enabledBrowsers.edge',
      'outputFolder',
      'layout',
      'period',
    ]);

    expect(plugin.data.settings).toEqual(settings);
    expect(plugin.saved.at(-1)?.settings).toEqual(settings);
    await expect(plugin.updateSettings(
      { ...settings, outputFolder: '.obsidian/data' },
      ['outputFolder'],
    ))
      .rejects.toThrow('vault-relative');
    expect(plugin.saved).toHaveLength(1);
  });

  it('serializes overlapping saves and keeps a later success after an earlier failure', async () => {
    const firstSave = deferred();
    const plugin = new PluginHarness(undefined, runtime(), async (_data, index) => {
      if (index === 0) {
        await firstSave.promise;
      }
    });
    await plugin.onload();
    const firstSettings: PluginSettings = {
      ...plugin.data.settings,
      enabledBrowsers: { ...plugin.data.settings.enabledBrowsers },
      layout: 'flat',
    };
    const secondSettings: PluginSettings = {
      ...plugin.data.settings,
      enabledBrowsers: { ...plugin.data.settings.enabledBrowsers },
      period: 'week',
    };

    const first = plugin.updateSettings(firstSettings, ['layout']);
    const second = plugin.updateSettings(secondSettings, ['period']);
    await vi.waitFor(() => expect(plugin.saved).toHaveLength(1));

    firstSave.reject(new Error('Disk full'));
    await expect(first).rejects.toThrow('Disk full');
    await expect(second).resolves.toBeUndefined();

    expect(plugin.saved).toHaveLength(2);
    expect(plugin.saved[1].settings).toMatchObject({
      layout: 'tiered',
      period: 'week',
    });
    expect(plugin.data.settings).toMatchObject({
      layout: 'tiered',
      period: 'week',
    });
  });

  it('eliminates out-of-order persistence and composes successful changes', async () => {
    const firstSave = deferred();
    const plugin = new PluginHarness(undefined, runtime(), async (_data, index) => {
      if (index === 0) {
        await firstSave.promise;
      }
    });
    await plugin.onload();
    const firstSettings: PluginSettings = {
      ...plugin.data.settings,
      enabledBrowsers: { ...plugin.data.settings.enabledBrowsers },
      layout: 'flat',
    };
    const secondSettings: PluginSettings = {
      ...plugin.data.settings,
      enabledBrowsers: { ...plugin.data.settings.enabledBrowsers },
      period: 'week',
    };

    const first = plugin.updateSettings(firstSettings, ['layout']);
    const second = plugin.updateSettings(secondSettings, ['period']);
    await vi.waitFor(() => expect(plugin.saved).toHaveLength(1));
    expect(plugin.saved[0].settings).toMatchObject({
      layout: 'flat',
      period: 'month',
    });

    firstSave.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();

    expect(plugin.saved).toHaveLength(2);
    expect(plugin.saved[1].settings).toMatchObject({
      layout: 'flat',
      period: 'week',
    });
    expect(plugin.data.settings).toMatchObject({
      layout: 'flat',
      period: 'week',
    });
  });

  it('uses the last same-field submission when a pending value is reverted', async () => {
    const firstSave = deferred();
    const plugin = new PluginHarness(undefined, runtime(), async (_data, index) => {
      if (index === 0) {
        await firstSave.promise;
      }
    });
    await plugin.onload();
    const original = plugin.data.settings.layout;
    const changed: PluginSettings = {
      ...plugin.data.settings,
      enabledBrowsers: { ...plugin.data.settings.enabledBrowsers },
      layout: 'flat',
    };
    const reverted: PluginSettings = {
      ...plugin.data.settings,
      enabledBrowsers: { ...plugin.data.settings.enabledBrowsers },
      layout: original,
    };

    const first = plugin.updateSettings(changed, ['layout']);
    const second = plugin.updateSettings(reverted, ['layout']);
    await vi.waitFor(() => expect(plugin.saved).toHaveLength(1));

    firstSave.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();

    expect(plugin.saved).toHaveLength(2);
    expect(plugin.saved[1].settings.layout).toBe(original);
    expect(plugin.persisted.at(-1)?.settings.layout).toBe(original);
    expect(plugin.data.settings.layout).toBe(original);
  });

  it('never persists a tentative cursor through a queued settings save', async () => {
    const firstSave = deferred();
    const profile: BrowserProfile = {
      sourceKey: 'chrome:tentative',
      browserId: 'chrome',
      browserName: 'Google Chrome',
      profileId: 'Default',
      profileName: 'Default',
      databasePath: '/synthetic/History',
      readerKind: 'chromium',
    };
    const vault = fakeVault();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = new PluginHarness(
      undefined,
      runtime({
        vault,
        discover: vi.fn(async () => [profile]),
        readVisits: vi.fn(async () => [visit({
          sourceKey: profile.sourceKey,
          browserId: profile.browserId,
          browserName: profile.browserName,
          profileId: profile.profileId,
          profileName: profile.profileName,
          sourceVisitId: '9',
        })]),
        runImporter: runImport,
      }),
      async (_data, index) => {
        if (index === 0) {
          await firstSave.promise;
        }
        if (index === 2) {
          throw new Error('Cursor persistence failed');
        }
      },
    );
    await plugin.onload();
    const layout: PluginSettings = {
      ...plugin.data.settings,
      enabledBrowsers: { ...plugin.data.settings.enabledBrowsers },
      layout: 'flat',
    };
    const period: PluginSettings = {
      ...plugin.data.settings,
      enabledBrowsers: { ...plugin.data.settings.enabledBrowsers },
      period: 'week',
    };

    const firstSettingsSave = plugin.updateSettings(layout, ['layout']);
    const secondSettingsSave = plugin.updateSettings(period, ['period']);
    const importing = plugin.importBrowserHistory();
    await vi.waitFor(() => {
      expect(plugin.data.cursors[profile.sourceKey]?.sourceVisitId).toBe('9');
    });

    firstSave.resolve();
    await expect(firstSettingsSave).resolves.toBeUndefined();
    await expect(secondSettingsSave).resolves.toBeUndefined();
    await expect(importing).resolves.toBeUndefined();

    expect(plugin.saved).toHaveLength(3);
    expect(plugin.persisted).toHaveLength(2);
    expect(plugin.persisted.every(
      (payload) => payload.cursors[profile.sourceKey] === undefined,
    )).toBe(true);
    expect(plugin.data.cursors[profile.sourceKey]).toBeUndefined();
    consoleError.mockRestore();
  });

  it('summarizes every outcome without exposing visited URLs', async () => {
    const secretUrl = 'https://private.example/visited';
    const notice = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakeRuntime = runtime({
      notice,
      runImporter: vi.fn(async () => ({
        imported: 4,
        alreadyPresent: 3,
        skippedProfiles: 2,
        failedProfiles: [{
          sourceKey: 'chrome:profile',
          message: `Database error while reading ${secretUrl}`,
        }],
      })),
    });
    const plugin = new PluginHarness(undefined, fakeRuntime);
    await plugin.onload();

    await plugin.importBrowserHistory();

    const notices = notice.mock.calls.flat().join('\n');
    expect(notices).toContain('4 imported');
    expect(notices).toContain('3 already present');
    expect(notices).toContain('2 skipped');
    expect(notices).toContain('1 failed');
    expect(notices).not.toContain(secretUrl);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secretUrl);
    consoleError.mockRestore();
  });

  it.each(['EACCES', 'EPERM'])('%s Safari failures explain Full Disk Access', async (code) => {
    const secretUrl = 'https://private.example/visited';
    const notice = vi.fn();
    const plugin = new PluginHarness(undefined, runtime({
      platform: 'darwin',
      notice,
      runImporter: vi.fn(async () => ({
        ...emptySummary,
        failedProfiles: [{
          sourceKey: 'safari:profile',
          message: `${code}: denied while reading ${secretUrl}`,
        }],
      })),
    }));
    await plugin.onload();

    await plugin.importBrowserHistory();

    const notices = notice.mock.calls.flat().join('\n');
    expect(notices).toContain('Full Disk Access');
    expect(notices).toContain('System Settings');
    expect(notices).not.toContain(secretUrl);
  });

  it('selects a browser reader from readerKind', () => {
    expect(readerFor('chromium')).toBeInstanceOf(ChromiumReader);
    expect(readerFor('firefox')).toBeInstanceOf(FirefoxReader);
    expect(readerFor('safari')).toBeInstanceOf(SafariReader);
  });

  it('reports detected Safari permission status before an import', async () => {
    const safari: BrowserProfile = {
      sourceKey: 'safari:history',
      browserId: 'safari',
      browserName: 'Safari',
      profileId: 'History',
      profileName: 'History',
      databasePath: '/synthetic/History.db',
      readerKind: 'safari',
    };
    const plugin = new PluginHarness(undefined, runtime({
      platform: 'darwin',
      discover: vi.fn(async () => [safari]),
      permissionDenied: (profile) => profile.sourceKey === safari.sourceKey,
    }));
    await plugin.onload();

    await expect(plugin.detectedProfileStatuses()).resolves.toEqual([{
      profile: safari,
      status: 'Permission denied — grant Obsidian Full Disk Access',
    }]);
  });
});

describe('BrowserSyncSettingTab', () => {
  beforeEach(() => {
    obsidianMock.records.length = 0;
  });

  it('renders every browser, output choice, and detected profile status', async () => {
    const detected: BrowserProfile = {
      sourceKey: 'chrome:default',
      browserId: 'chrome',
      browserName: 'Google Chrome',
      profileId: 'Default',
      profileName: 'Personal',
      databasePath: '/synthetic/History',
      readerKind: 'chromium',
    };
    const plugin = new PluginHarness(undefined, runtime({
      discover: vi.fn(async () => [detected]),
    }));
    await plugin.onload();

    plugin.settingTabs[0].display();
    await vi.waitFor(() => {
      expect(obsidianMock.records.some((record) => record.name === 'Google Chrome — Personal'))
        .toBe(true);
    });

    expect(obsidianMock.records.filter((record) => record.toggle).map((record) => record.name))
      .toEqual([
        'Safari',
        'Firefox',
        'Google Chrome',
        'Microsoft Edge',
        'Brave',
        'Chromium',
        'Vivaldi',
      ]);
    expect(setting('Safari').disabled).toBe(true);
    expect(setting('Safari').toggle?.disabled).toBe(true);
    expect(setting('Output folder').text?.value).toBe('Browser History');
    expect(setting('Layout').dropdown?.options).toEqual({
      flat: 'Flat',
      tiered: 'Tiered',
    });
    expect(setting('Note period').dropdown?.options).toEqual({
      day: 'Day',
      week: 'ISO week',
      month: 'Month',
      year: 'Year',
    });
    expect(setting('Google Chrome — Personal').description).toBe('Ready');
    expect(setting('Google Chrome — Personal').className)
      .toBe('browser-sync-status-row');
  });

  it('validates output-folder changes before saving', async () => {
    const plugin = new PluginHarness(undefined, runtime());
    await plugin.onload();
    plugin.settingTabs[0].display();
    const output = setting('Output folder');

    await output.text?.onChange?.('../outside');

    expect(output.error).toContain('vault-relative');
    expect(plugin.saved).toHaveLength(0);

    await output.text?.onChange?.('History/Imported');

    expect(output.error).toBeNull();
    expect(plugin.saved.at(-1)?.settings.outputFolder).toBe('History/Imported');
  });

  it('restores a control and reports an actionable error when saving fails', async () => {
    const plugin = new PluginHarness(
      undefined,
      runtime(),
      async () => Promise.reject(new Error('Vault is read-only')),
    );
    await plugin.onload();
    plugin.settingTabs[0].display();
    const output = setting('Output folder');
    if (output.text) {
      output.text.value = 'Unsaved History';
    }

    await expect(output.text?.onChange?.('Unsaved History'))
      .resolves.toBeUndefined();

    expect(plugin.data.settings.outputFolder).toBe('Browser History');
    expect(output.text?.value).toBe('Browser History');
    expect(output.error).toContain('Could not save');
    expect(output.error).toContain('try again');
  });
});

describe('Obsidian compatibility metadata', () => {
  it('declares the minimum version required by the settings and vault APIs', async () => {
    const [manifest, versions] = await Promise.all([
      readFile(new URL('../manifest.json', import.meta.url), 'utf8').then(JSON.parse),
      readFile(new URL('../versions.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);

    expect(manifest.minAppVersion).toBe('1.13.0');
    expect(versions[manifest.version]).toBe('1.13.0');
  });
});
