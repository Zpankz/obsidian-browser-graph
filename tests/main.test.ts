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
  text?: ComponentRecord<string> & {
    inputEl: { value: string };
    placeholder?: string;
  };
  dropdown?: ComponentRecord<string> & { options: Record<string, string> };
}

const obsidianMock = vi.hoisted(() => ({
  records: [] as SettingRecord[],
  suggests: [] as unknown[],
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

    display() {
      const tab = this as unknown as {
        app: { vault: { getAllLoadedFiles(): unknown[] } };
        getControlValue(key: string): unknown;
        setControlValue(key: string, next: unknown): Promise<void>;
      };
      const definitions = (this as unknown as {
        getSettingDefinitions(): Array<Record<string, unknown>>;
      }).getSettingDefinitions();
      const renderItems = (items: Array<Record<string, unknown>>) => {
        for (const item of items) {
          if (item.type === 'group') {
            renderItems(item.items as Array<Record<string, unknown>>);
            continue;
          }
          const setting = new Setting(this.containerEl)
            .setName(item.name as string);
          if (typeof item.desc === 'string') {
            setting.setDesc(item.desc);
          }
          if (typeof item.render === 'function') {
            item.render(setting, {
              listEl: this.containerEl,
              addSetting: (callback: (row: Setting) => void) => {
                callback(new Setting(this.containerEl));
              },
            });
            continue;
          }
          const control = item.control as Record<string, unknown>;
          const save = async (value: unknown) => {
            const validation = typeof control.validate === 'function'
              ? await control.validate(value)
              : undefined;
            if (typeof validation === 'string' && validation.length > 0) {
              setting.setErrorMessage(validation);
              return;
            }
            try {
              await (this as unknown as {
                setControlValue(key: string, next: unknown): Promise<void>;
              }).setControlValue(control.key as string, value);
              setting.setErrorMessage(null);
            } catch (error) {
              setting.setErrorMessage(error instanceof Error ? error.message : String(error));
              const current = (this as unknown as {
                getControlValue(key: string): unknown;
              }).getControlValue(control.key as string);
              component?.setValue(current);
            }
          };
          let component: { setValue(value: unknown): unknown } | undefined;
          if (control.type === 'toggle') {
            setting.setDisabled(Boolean(control.disabled));
            setting.addToggle((toggle) => {
              const typedToggle = toggle as {
                setValue(value: unknown): typeof typedToggle;
                setDisabled(value: boolean): typeof typedToggle;
                onChange(callback: (value: unknown) => Promise<void>): typeof typedToggle;
              };
              component = typedToggle;
              typedToggle
                .setValue(tab.getControlValue(control.key as string))
                .setDisabled(Boolean(control.disabled))
                .onChange(save);
            });
          } else if (control.type === 'dropdown') {
            setting.addDropdown((dropdown) => {
              const typedDropdown = dropdown as {
                addOptions(options: Record<string, string>): typeof typedDropdown;
                setValue(value: unknown): typeof typedDropdown;
                onChange(callback: (value: unknown) => Promise<void>): typeof typedDropdown;
              };
              component = typedDropdown;
              typedDropdown
                .addOptions(control.options as Record<string, string>)
                .setValue(tab.getControlValue(control.key as string))
                .onChange(save);
            });
          } else if (control.type === 'folder' || control.type === 'text') {
            setting.addText((text) => {
              const typedText = text as {
                setPlaceholder(value: unknown): typeof typedText;
                setValue(value: unknown): typeof typedText;
                onChange(callback: (value: unknown) => Promise<void>): typeof typedText;
              };
              component = typedText;
              typedText
                .setPlaceholder(control.placeholder)
                .setValue(tab.getControlValue(control.key as string))
                .onChange(save);
              if (control.type === 'folder') {
                obsidianMock.suggests.push({
                  getSuggestions: (query: string) => tab.app.vault
                    .getAllLoadedFiles()
                    .filter((folder: unknown) => (control.filter as (value: unknown) => boolean)(folder))
                    .map((folder: { path: string }) => folder.path)
                    .filter((path: string) => path.toLowerCase().includes(query.toLowerCase()))
                    .sort((left: string, right: string) => left.localeCompare(right)),
                  selectSuggestion: (value: string) => {
                    typedText.setValue(value);
                    void save(value);
                  },
                });
              }
            });
          }
        }
      };
      renderItems(definitions);
    }
  }

  class AbstractInputSuggest {
    constructor(
      public app: unknown,
      public inputEl: { value: string },
    ) {
      obsidianMock.suggests.push(this);
    }

    setValue(value: string) {
      this.inputEl.value = value;
    }

    close() {}
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
      const inputEl = { value: '' };
      const record: ComponentRecord<string> & {
        inputEl: { value: string };
        placeholder?: string;
      } = {
        disabled: false,
        inputEl,
        value: '',
      };
      this.record.text = record;
      callback({
        inputEl,
        setValue(value: string) {
          record.value = value;
          inputEl.value = value;
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

  class TFile {
    constructor(public path = '') {}
  }
  class TFolder {
    constructor(public path = '') {}
  }

  return {
    AbstractInputSuggest,
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
import { TFolder } from 'obsidian';
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
import { DEFAULT_SETTINGS, hashDeviceIdentityToken } from '../src/settings';
import { runImport } from '../src/sync/importer';
import type { ConversionSummary } from '../src/sync/converter';
import { BrowserSyncOperationAlreadyRunningError } from '../src/sync/operation-guard';
import { fakeVault, fakeVaultWithRenderedVisit } from './helpers/fake-vault';
import { visit } from './helpers/visits';

const emptySummary: ImportSummary = {
  imported: 0,
  alreadyPresent: 0,
  skippedProfiles: 0,
  failedProfiles: [],
};
const emptyConversionSummary: ConversionSummary = {
  converted: 0,
  alreadyCurrent: 0,
  retained: 0,
  skippedReplacement: 0,
  failed: [],
};
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const DEVICE_A = hashDeviceIdentityToken(TOKEN_A);
const DEVICE_B = hashDeviceIdentityToken(TOKEN_B);

function deviceIdentity(token: string) {
  return {
    read: () => token,
    write: vi.fn(),
  };
}

function clonedDefaults(): PersistedData {
  return {
    version: 3,
    deviceIdentityHash: DEVICE_A,
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
    deviceIdentity: deviceIdentity(TOKEN_A),
    vault: fakeVault(),
    discover: vi.fn(async () => []),
    readVisits: vi.fn(async () => []),
    runImporter: vi.fn(async () => emptySummary),
    runConverter: vi.fn(async () => emptyConversionSummary),
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
    vaultFolders: string[] = [],
  ) {
    super({
      vault: {
        configDir: '.obsidian',
        getAllLoadedFiles: () => vaultFolders.map((folder) => new TFolder(folder)),
      },
    } as unknown as App, { id: 'browser-history-sync' } as PluginManifest);
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
    obsidianMock.suggests.length = 0;
  });

  it('registers manual import, rebuild, and conversion commands without importing on startup', async () => {
    const fakeRuntime = runtime({
      vault: fakeVault({ files: { 'Browser History/.keep': '' } }),
    });
    const plugin = new PluginHarness(undefined, fakeRuntime);

    await plugin.onload();

    expect(plugin.commands.map((command) => command.id))
      .toEqual([
        'import-browser-history',
        'rebuild-browser-history-output',
        'convert-browser-history-exports',
      ]);
    expect(plugin.commands[0].name).toBe('Import browser history');
    expect(plugin.commands[1].name).toBe('Rebuild browser history output');
    expect(plugin.commands[2].name).toBe('Convert existing browser history exports');
    expect(fakeRuntime.runImporter).not.toHaveBeenCalled();
    expect(fakeRuntime.runConverter).not.toHaveBeenCalled();
    expect(fakeRuntime.discover).not.toHaveBeenCalled();
    expect(plugin.settingTabs).toHaveLength(1);
    expect(plugin.settingTabs[0]).toBeInstanceOf(BrowserSyncSettingTab);

    await plugin.commands[0].callback?.();

    expect(fakeRuntime.runImporter).toHaveBeenCalledOnce();

    await plugin.commands[1].callback?.();

    expect(fakeRuntime.runImporter).toHaveBeenLastCalledWith(
      expect.objectContaining({ rebuild: true }),
      expect.any(Object),
    );

    const originalSettingsSnapshot = structuredClone(plugin.data.settings);
    await plugin.commands[2].callback?.();

    expect(fakeRuntime.runConverter).toHaveBeenCalledWith(
      { settings: originalSettingsSnapshot },
      { vault: fakeRuntime.vault },
    );
  });

  it('automatically requests a rebuild when the active output folder is missing', async () => {
    const vault = fakeVault();
    const runImporter = vi.fn(async () => emptySummary);
    const plugin = new PluginHarness(undefined, runtime({ vault, runImporter }));
    await plugin.onload();

    await plugin.importBrowserHistory();

    expect(runImporter).toHaveBeenCalledWith(
      expect.objectContaining({ rebuild: true }),
      expect.any(Object),
    );
  });

  it('keeps an incremental import when the active output folder still exists', async () => {
    const vault = fakeVault({
      files: { 'Browser History/existing.md': '# Existing output' },
    });
    const runImporter = vi.fn(async () => emptySummary);
    const plugin = new PluginHarness(undefined, runtime({ vault, runImporter }));
    await plugin.onload();

    await plugin.importBrowserHistory();

    expect(runImporter).toHaveBeenCalledWith(
      expect.not.objectContaining({ rebuild: true }),
      expect.any(Object),
    );
  });

  it('captures command settings before deferred folder preparation', async () => {
    const folderReady = deferred();
    const vault = fakeVault();
    vault.ensureFolder = vi.fn(async () => {
      await folderReady.promise;
    });
    const runImporter = vi.fn(async () => emptySummary);
    const plugin = new PluginHarness(undefined, runtime({ vault, runImporter }));
    await plugin.onload();
    const original = structuredClone(plugin.data.settings);

    const importing = plugin.importBrowserHistory();
    await vi.waitFor(() => expect(vault.ensureFolder).toHaveBeenCalledWith(
      original.outputFolder,
    ));
    plugin.data.settings.enabledBrowsers.chrome = false;
    plugin.data.settings.enabledBrowsers.firefox = false;
    plugin.data.settings.outputFolder = 'Changed History';
    plugin.data.settings.layout = 'flat';
    plugin.data.settings.period = 'day';
    folderReady.resolve();
    await importing;

    expect(runImporter).toHaveBeenCalledWith(
      expect.objectContaining({ settings: original }),
      expect.any(Object),
    );
  });

  it('captures conversion settings before deferred folder existence checks', async () => {
    const existsReady = deferred();
    const vault = fakeVault();
    vault.ensureFolder = vi.fn(async () => {});
    vault.exists = vi.fn(async () => {
      await existsReady.promise;
      return true;
    });
    const runConverter = vi.fn(async () => emptyConversionSummary);
    const plugin = new PluginHarness(undefined, runtime({ vault, runConverter }));
    await plugin.onload();
    const original = structuredClone(plugin.data.settings);

    const converting = plugin.convertBrowserHistoryExports();
    await vi.waitFor(() => expect(vault.exists).toHaveBeenCalledWith(
      original.outputFolder,
    ));
    plugin.data.settings.enabledBrowsers.chrome = false;
    plugin.data.settings.outputFolder = 'Changed History';
    plugin.data.settings.outputFormat = 'json';
    plugin.data.settings.formatConversionBehavior = 'replace';
    existsReady.resolve();
    await converting;

    expect(runConverter).toHaveBeenCalledWith(
      { settings: original },
      { vault },
    );
    expect(vault.ensureFolder).not.toHaveBeenCalled();
  });

  it('does not convert or create a missing configured output folder', async () => {
    const notice = vi.fn();
    const vault = fakeVault();
    vault.ensureFolder = vi.fn(async () => {});
    const runConverter = vi.fn(async () => emptyConversionSummary);
    const plugin = new PluginHarness(undefined, runtime({
      vault,
      notice,
      runConverter,
    }));
    await plugin.onload();

    await plugin.convertBrowserHistoryExports();

    expect(vault.ensureFolder).not.toHaveBeenCalled();
    expect(runConverter).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(
      'Browser history conversion could not start. The configured output folder does not exist.',
    );
  });

  it('reports a conversion completion without changing cursor state', async () => {
    const notice = vi.fn();
    const vault = fakeVault({ files: { 'Browser History/.keep': '' } });
    const plugin = new PluginHarness({
      ...clonedDefaults(),
      cursors: {
        'chrome:default': {
          visitedAtMs: Date.parse('2026-08-03T12:00:00Z'),
          sourceVisitId: '42',
        },
      },
    }, runtime({
      vault,
      notice,
      runConverter: vi.fn(async () => ({
        converted: 2,
        alreadyCurrent: 1,
        retained: 2,
        skippedReplacement: 1,
        failed: [],
      })),
    }));
    await plugin.onload();
    const cursors = structuredClone(plugin.data.cursors);

    await plugin.convertBrowserHistoryExports();

    expect(notice).toHaveBeenCalledWith(
      'Browser history conversion complete: 2 converted, 1 already current, 2 originals retained, 1 replacement skipped, 0 failed.',
    );
    expect(plugin.data.cursors).toEqual(cursors);
    expect(plugin.saved).toHaveLength(0);
  });

  it('reports partial conversion failures without exposing history content', async () => {
    const secret = 'https://private.example/visited';
    const notice = vi.fn();
    const vault = fakeVault({ files: { 'Browser History/.keep': '' } });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = new PluginHarness(undefined, runtime({
      vault,
      notice,
      runConverter: vi.fn(async () => ({
        converted: 1,
        alreadyCurrent: 2,
        retained: 3,
        skippedReplacement: 4,
        failed: [{ path: `Browser History/${secret}.json`, category: 'write' }],
      })),
    }));
    await plugin.onload();

    await plugin.convertBrowserHistoryExports();

    expect(notice).toHaveBeenCalledWith(
      'Browser history conversion complete: 1 converted, 2 already current, 3 originals retained, 4 replacement skipped, 1 failed.',
    );
    expect(notice).toHaveBeenCalledWith(
      'Some browser history exports could not be converted. Check the output folder and console for details.',
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret);
    consoleError.mockRestore();
  });

  it('reports when another Browser Sync operation is already running', async () => {
    const notice = vi.fn();
    const vault = fakeVault({ files: { 'Browser History/.keep': '' } });
    const plugin = new PluginHarness(undefined, runtime({
      vault,
      notice,
      runConverter: vi.fn(async () => {
        throw new BrowserSyncOperationAlreadyRunningError();
      }),
    }));
    await plugin.onload();

    await plugin.convertBrowserHistoryExports();

    expect(notice).toHaveBeenCalledWith('A Browser Sync operation is already running.');
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

  it('rescans a same-path profile when state was copied from another device', async () => {
    const samePathProfile: BrowserProfile = {
      sourceKey: 'chrome:same-path',
      browserId: 'chrome',
      browserName: 'Google Chrome',
      profileId: 'Default',
      profileName: 'Personal',
      databasePath: '/same/home/.config/google-chrome/Default/History',
      readerKind: 'chromium',
    };
    const existing = visit({
      sourceKey: samePathProfile.sourceKey,
      browserId: samePathProfile.browserId,
      browserName: samePathProfile.browserName,
      profileId: samePathProfile.profileId,
      profileName: samePathProfile.profileName,
      sourceVisitId: '1',
    });
    const newer = visit({
      sourceKey: samePathProfile.sourceKey,
      browserId: samePathProfile.browserId,
      browserName: samePathProfile.browserName,
      profileId: samePathProfile.profileId,
      profileName: samePathProfile.profileName,
      sourceVisitId: '2',
      visitedAt: new Date('2026-08-03T13:00:00Z'),
    });
    const vault = fakeVaultWithRenderedVisit(existing);
    const readVisits = vi.fn(async () => [existing, newer]);
    const plugin = new PluginHarness({
      version: 3,
      deviceIdentityHash: DEVICE_A,
      settings: clonedDefaults().settings,
      cursors: {
        [samePathProfile.sourceKey]: {
          visitedAtMs: Date.parse('2026-08-04T00:00:00Z'),
          sourceVisitId: '99',
        },
      },
    }, runtime({
      deviceIdentity: deviceIdentity(TOKEN_B),
      vault,
      discover: vi.fn(async () => [samePathProfile]),
      readVisits,
      runImporter: runImport,
    }));

    await plugin.onload();
    expect(plugin.data.cursors).toEqual({});

    await plugin.importBrowserHistory();

    expect(readVisits).toHaveBeenCalledWith(samePathProfile, undefined);
    expect(vault.readText('Browser History/2026/2026-08.md')
      .match(/obsidian-browser-sync/g)).toHaveLength(2);
    expect(plugin.saved.at(-1)).toMatchObject({
      version: 3,
      deviceIdentityHash: DEVICE_B,
      cursors: {
        [samePathProfile.sourceKey]: { sourceVisitId: '2' },
      },
    });
    expect(JSON.stringify(plugin.saved)).not.toContain(TOKEN_B);
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

  it('preserves committed format settings in cursor persistence snapshots', async () => {
    const runImporter = vi.fn(async (
      request: Parameters<BrowserSyncRuntime['runImporter']>[0],
      dependencies: Parameters<BrowserSyncRuntime['runImporter']>[1],
    ) => {
      request.data.cursors['chrome:default'] = {
        visitedAtMs: Date.parse('2026-08-03T12:00:00Z'),
        sourceVisitId: '42',
      };
      await dependencies.saveData(request.data);
      return emptySummary;
    });
    const plugin = new PluginHarness(undefined, runtime({ runImporter }));
    await plugin.onload();

    const formatSettings: PluginSettings = {
      ...plugin.data.settings,
      enabledBrowsers: { ...plugin.data.settings.enabledBrowsers },
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    };
    await plugin.updateSettings(formatSettings, [
      'outputFormat',
      'formatConversionBehavior',
    ]);
    await plugin.importBrowserHistory();

    expect(plugin.saved.at(-1)).toMatchObject({
      settings: {
        outputFormat: 'json',
        formatConversionBehavior: 'replace',
      },
      cursors: {
        'chrome:default': { sourceVisitId: '42' },
      },
    });
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

  it('warns when a sensitive temporary database snapshot may remain', async () => {
    const notice = vi.fn();
    const plugin = new PluginHarness(undefined, runtime({
      notice,
      runImporter: vi.fn(async () => ({
        ...emptySummary,
        failedProfiles: [{
          sourceKey: 'chrome:profile',
          message: 'Cleanup failed for sensitive temporary database snapshot /private/tmp/run. The snapshot may remain.',
        }],
      })),
    }));
    await plugin.onload();

    await plugin.importBrowserHistory();

    expect(notice.mock.calls.flat().join('\n')).toMatch(
      /sensitive temporary database snapshot may remain/i,
    );
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
    obsidianMock.suggests.length = 0;
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
    expect(setting('File name template').text?.value).toBe('{period}');
    expect(setting('Export format').dropdown).toMatchObject({
      value: 'markdown',
      options: { markdown: 'Markdown', csv: 'CSV', json: 'JSON' },
    });
    expect(setting('Format conversion behavior').dropdown).toMatchObject({
      value: 'keep',
      options: { keep: 'Keep original files', replace: 'Replace original files' },
    });
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

  it('validates and saves a custom file name template', async () => {
    const plugin = new PluginHarness(undefined, runtime());
    await plugin.onload();
    plugin.settingTabs[0].display();
    const template = setting('File name template');

    await template.text?.onChange?.('same-name');
    expect(template.error).toContain('{period}');
    expect(plugin.saved).toHaveLength(0);

    await template.text?.onChange?.('Browser history - {period}');
    expect(template.error).toBeNull();
    expect(plugin.saved.at(-1)?.settings.fileNameTemplate)
      .toBe('Browser history - {period}');
  });

  it('saves selected export and conversion settings', async () => {
    const plugin = new PluginHarness(undefined, runtime());
    await plugin.onload();
    plugin.settingTabs[0].display();

    await setting('Export format').dropdown?.onChange?.('json');
    await setting('Format conversion behavior').dropdown?.onChange?.('replace');

    expect(plugin.data.settings).toMatchObject({
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    });
    expect(plugin.saved.at(-1)?.settings).toMatchObject({
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    });
  });

  it('does not erase a trailing separator while typing a nested output folder', async () => {
    const plugin = new PluginHarness(undefined, runtime());
    await plugin.onload();
    plugin.settingTabs[0].display();
    const output = setting('Output folder');

    if (output.text) {
      output.text.inputEl.value = 'Projects/';
    }
    await output.text?.onChange?.('Projects/');

    expect(output.text?.inputEl.value).toBe('Projects/');
    expect(plugin.saved.at(-1)?.settings.outputFolder).toBe('Projects');

    if (output.text) {
      output.text.inputEl.value = 'Projects/Research';
    }
    await output.text?.onChange?.('Projects/Research');

    expect(output.text?.inputEl.value).toBe('Projects/Research');
    expect(plugin.saved.at(-1)?.settings.outputFolder).toBe('Projects/Research');
  });

  it('suggests safe vault folders and saves a selected suggestion', async () => {
    const plugin = new PluginHarness(
      undefined,
      runtime(),
      async () => {},
      ['Projects', 'History/2026', '.obsidian', 'CON', 'Archive'],
    );
    await plugin.onload();
    plugin.settingTabs[0].display();

    expect(obsidianMock.suggests).toHaveLength(1);
    const suggest = obsidianMock.suggests[0] as {
      getSuggestions(query: string): string[];
      selectSuggestion(value: string): void;
    };
    expect(suggest.getSuggestions('')).toEqual([
      'Archive',
      'History/2026',
      'Projects',
    ]);
    expect(suggest.getSuggestions('hist')).toEqual(['History/2026']);

    suggest.selectSuggestion('Projects');

    await vi.waitFor(() => {
      expect(plugin.saved.at(-1)?.settings.outputFolder).toBe('Projects');
    });
    expect(setting('Output folder').text?.value).toBe('Projects');
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
