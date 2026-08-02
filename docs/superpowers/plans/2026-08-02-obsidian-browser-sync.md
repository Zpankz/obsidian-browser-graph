# Obsidian Browser Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a desktop-only Obsidian plugin that manually imports all visits from enabled local browser profiles into configurable, idempotent Markdown history notes.

**Architecture:** Browser-specific discovery and SQLite readers emit one normalized visit contract. A platform-independent import service applies cursor overlap, stable-ID deduplication, temporal grouping, vault-safe path planning, serialized append-only writes, and per-profile cursor commits. The Obsidian entry point and settings tab adapt that core to the desktop app, while the SQLite WASM asset keeps releases portable across macOS, Windows, and Linux.

**Tech Stack:** TypeScript 5.8+, Obsidian API, Node filesystem APIs, esbuild 0.25+, Vitest, sql.js 1.14.1, ESLint 9

## Global Constraints

- Target Obsidian desktop on macOS, Windows, and Linux; set `isDesktopOnly` to `true`.
- First-class sources are Safari, Firefox, and Chrome; known Chromium-compatible sources are Edge, Brave, Chromium, and Vivaldi.
- Discover and import all profiles for enabled browsers.
- Preserve every visit, including repeated URLs; never collapse by URL.
- Run only from the `Import browser history` command; do not add timers, startup hooks, network calls, or browser writes.
- Default output folder is `Browser History`, default layout is `tiered`, and default period is `month`.
- A profile cursor advances only after all note writes for that profile succeed.
- Hidden stable IDs in Markdown are the final idempotency authority.
- Release artifacts are `main.js`, `manifest.json`, `styles.css`, and `sql-wasm.wasm`.
- Use test-driven development: write and run each failing test before adding its production behavior.

---

## File Map

- `src/domain.ts`: shared browser, visit, state, settings, result, and port types.
- `src/settings.ts`: defaults, validation, and persisted-data migration.
- `src/output/periods.ts`: local-time period keys, ISO week calculations, and flat/tiered paths.
- `src/output/markdown.ts`: stable IDs, Markdown rendering, marker extraction, and note assembly.
- `src/platform/catalog.ts`: browser catalog and OS-specific installation roots.
- `src/platform/discovery.ts`: profile discovery using injected filesystem and home/platform values.
- `src/sql/sqlite.ts`: singleton sql.js initialization and read-only in-memory database adapter.
- `src/sql/snapshot.ts`: temporary snapshot lifecycle and guaranteed cleanup.
- `src/browsers/chromium.ts`: Chromium schema detection and visit mapping.
- `src/browsers/firefox.ts`: Firefox schema detection and visit mapping.
- `src/browsers/safari.ts`: Safari schema detection and visit mapping.
- `src/sync/importer.ts`: orchestration, deduplication, serialized note writes, and cursor commit rules.
- `src/obsidian-vault.ts`: Obsidian Vault implementation of the vault port.
- `src/settings-tab.ts`: settings controls, validation, and discovery status.
- `src/main.ts`: plugin lifecycle, command registration, persistence, and notices.
- `tests/helpers/`: fake filesystem/vault, sql.js fixture builder, and fixed-time utilities.
- `tests/**/*.test.ts`: focused behavior tests corresponding to the production modules.
- `manifest.json`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `esbuild.config.mjs`, `eslint.config.mjs`: toolchain and release configuration.
- `README.md`: installation, permissions, settings, output examples, and privacy behavior.

---

### Task 1: Project Scaffold, Domain Contracts, and Settings Migration

**Files:**
- Create: `package.json`
- Create: `manifest.json`
- Create: `versions.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `esbuild.config.mjs`
- Create: `eslint.config.mjs`
- Create: `styles.css`
- Create: `.gitignore`
- Create: `src/domain.ts`
- Create: `src/settings.ts`
- Create: `tests/settings.test.ts`

**Interfaces:**
- Produces: `PluginSettings`, `PersistedData`, `ProfileCursor`, `NormalizedVisit`, `BrowserProfile`, `ImportSummary`, `VaultPort`, `DEFAULT_SETTINGS`, and `migratePersistedData(raw)`.
- Consumes: no earlier task interfaces.

- [ ] **Step 1: Add the failing settings-default and migration tests**

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migratePersistedData } from '../src/settings';

describe('migratePersistedData', () => {
  it('uses the approved defaults for missing data', () => {
    expect(migratePersistedData(undefined)).toEqual({
      version: 1,
      settings: DEFAULT_SETTINGS,
      cursors: {},
    });
    expect(DEFAULT_SETTINGS.outputFolder).toBe('Browser History');
    expect(DEFAULT_SETTINGS.layout).toBe('tiered');
    expect(DEFAULT_SETTINGS.period).toBe('month');
  });

  it('sanitizes legacy and malformed persisted fields', () => {
    const result = migratePersistedData({
      settings: { outputFolder: '../outside', layout: 'wide', period: 'hour' },
      cursors: { firefox: { visitedAtMs: 'bad' } },
    });
    expect(result.settings.outputFolder).toBe('Browser History');
    expect(result.settings.layout).toBe('tiered');
    expect(result.settings.period).toBe('month');
    expect(result.cursors).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/settings.test.ts`

Expected: FAIL because `src/settings.ts` does not exist.

- [ ] **Step 3: Add the scaffold and minimal domain/settings implementation**

Use the official Obsidian sample plugin build shape. Set these scripts in `package.json`:

```json
{
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc --noEmit --skipLibCheck && node esbuild.config.mjs production",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "check": "npm run lint && npm test && npm run build"
  }
}
```

Install runtime dependencies `obsidian` and `sql.js@1.14.1`, and development dependencies `@types/node`, `@types/sql.js`, `typescript`, `esbuild`, `vitest`, `eslint`, `typescript-eslint`, `@eslint/js`, `eslint-plugin-obsidianmd`, and `globals`. Commit the generated `package-lock.json`.

Define the core types in `src/domain.ts`:

```ts
export type BrowserId = 'safari' | 'firefox' | 'chrome' | 'edge' | 'brave' | 'chromium' | 'vivaldi';
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
  version: 1;
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

export interface NormalizedVisit extends Omit<BrowserProfile, 'databasePath' | 'readerKind'> {
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
}
```

Implement `DEFAULT_SETTINGS`, `isSafeVaultFolder`, and `migratePersistedData`. Reject absolute paths, `..` segments, empty normalized paths, and destinations at or below `.obsidian`. Set Safari disabled off macOS later at runtime; persisted cross-platform defaults keep all first-class and known compatible IDs enabled.

Set `manifest.json` to ID `obsidian-browser-sync`, name `Browser Sync`, version `0.1.0`, minimum app version `1.0.0`, and `isDesktopOnly: true`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- tests/settings.test.ts`

Expected: 2 tests pass.

- [ ] **Step 5: Run typecheck/build and commit**

Run: `npm run build`

Expected: exit 0 and `main.js` is produced once a temporary empty `src/main.ts` exports nothing. Remove the temporary file before Task 6 only if Task 1 instead creates the final minimal plugin class.

```bash
git add package.json package-lock.json manifest.json versions.json tsconfig.json vitest.config.ts esbuild.config.mjs eslint.config.mjs styles.css .gitignore src/domain.ts src/settings.ts src/main.ts tests/settings.test.ts
git commit -m "build: scaffold browser sync plugin"
```

---

### Task 2: Period Planning, Vault-Safe Paths, and Markdown Idempotency

**Files:**
- Create: `src/output/periods.ts`
- Create: `src/output/markdown.ts`
- Create: `tests/output/periods.test.ts`
- Create: `tests/output/markdown.test.ts`

**Interfaces:**
- Consumes: `NormalizedVisit`, `NotePeriod`, `OutputLayout`, and `PluginSettings` from `src/domain.ts`.
- Produces: `periodFor(date, period)`, `destinationPath(settings, date)`, `stableVisitId(visit)`, `renderVisit(visit)`, `extractImportedIds(markdown)`, and `newNote(periodLabel, entries)`.

- [ ] **Step 1: Write failing period/path tests**

```ts
import { expect, it } from 'vitest';
import { destinationPath, periodFor } from '../../src/output/periods';

const local = (value: string) => new Date(`${value}T12:00:00`);

it('uses the approved default monthly tier', () => {
  expect(destinationPath({ outputFolder: 'Browser History', layout: 'tiered', period: 'month' }, local('2026-08-03')))
    .toBe('Browser History/2026/2026-08.md');
});

it('files a crossing ISO week by its Monday', () => {
  expect(periodFor(local('2026-01-01'), 'week').key).toBe('2026-W01');
  expect(destinationPath({ outputFolder: 'History', layout: 'tiered', period: 'day' }, local('2026-01-01')))
    .toBe('History/2025/2025-12/2026-W01/2026-01-01.md');
});

it('places all period filenames directly in flat mode', () => {
  expect(destinationPath({ outputFolder: 'History', layout: 'flat', period: 'week' }, local('2026-08-03')))
    .toBe('History/2026-W32.md');
});
```

- [ ] **Step 2: Run period tests and verify RED**

Run: `npm test -- tests/output/periods.test.ts`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement local calendar and ISO-week planning**

Implement an ISO week helper that normalizes a local date to local noon, moves to Thursday to determine the ISO week-year, calculates Monday, and formats zero-padded month/week/day components. `destinationPath` must use POSIX `/` separators because paths are Obsidian vault paths on every OS.

```ts
export interface PeriodDescriptor {
  key: string;
  label: string;
  isoMonday: Date;
}

export function destinationPath(
  settings: Pick<PluginSettings, 'outputFolder' | 'layout' | 'period'>,
  date: Date,
): string;
```

- [ ] **Step 4: Run period tests and verify GREEN**

Run: `npm test -- tests/output/periods.test.ts`

Expected: all period tests pass in the configured deterministic test timezone.

- [ ] **Step 5: Write failing Markdown identity and escaping tests**

```ts
import { expect, it } from 'vitest';
import { extractImportedIds, renderVisit, stableVisitId } from '../../src/output/markdown';
import { visit } from '../helpers/visits';

it('keeps repeated URL visits distinct and IDs deterministic', () => {
  const first = visit({ sourceVisitId: '10', url: 'https://example.com', visitedAt: new Date('2026-08-03T10:00:00Z') });
  const second = visit({ sourceVisitId: '11', url: 'https://example.com', visitedAt: new Date('2026-08-03T10:05:00Z') });
  expect(stableVisitId(first)).toBe(stableVisitId(first));
  expect(stableVisitId(first)).not.toBe(stableVisitId(second));
});

it('renders escaped text and a recoverable hidden marker', () => {
  const markdown = renderVisit(visit({ title: '[unsafe]\n# heading', url: 'https://example.com/a b' }));
  expect(markdown).not.toContain('\n# heading');
  expect(extractImportedIds(markdown)).toEqual(new Set([stableVisitId(visit({ title: '[unsafe]\n# heading', url: 'https://example.com/a b' }))]));
});
```

- [ ] **Step 6: Run Markdown tests and verify RED**

Run: `npm test -- tests/output/markdown.test.ts`

Expected: FAIL because the module and visit helper are missing.

- [ ] **Step 7: Implement stable IDs and appendable Markdown**

Use Node `createHash('sha256')`, joining identity fields with a NUL separator and truncating the hex digest to 24 characters. Replace control characters and line breaks in titles, escape `[` and `]`, percent-encode unsafe URL characters through `new URL(url).toString()`, and fall back to the URL when the title is empty. Markers must match only:

```ts
const MARKER = /<!-- obsidian-browser-sync:([a-z0-9-]+):([a-f0-9]{24}) -->/g;
```

`newNote` writes YAML keys `browser-sync: true` and `period: <label>`, then `# Browser history`, one blank line, and entries. `renderVisit` writes local `HH:mm:ss`, title link, browser/profile labels, and its marker on the next indented line.

- [ ] **Step 8: Run output tests and commit**

Run: `npm test -- tests/output`

Expected: all output tests pass.

```bash
git add src/output tests/output tests/helpers/visits.ts
git commit -m "feat: plan idempotent history notes"
```

---

### Task 3: Cross-Platform Browser and Profile Discovery

**Files:**
- Create: `src/platform/catalog.ts`
- Create: `src/platform/discovery.ts`
- Create: `tests/platform/discovery.test.ts`
- Create: `tests/helpers/fake-fs.ts`

**Interfaces:**
- Consumes: `BrowserId` and `BrowserProfile`.
- Produces: `FileSystemPort`, `DiscoveryContext`, `discoverProfiles(context)`, and `BROWSER_CATALOG`.

- [ ] **Step 1: Write failing discovery tests for all operating systems and profiles**

```ts
it.each([
  ['darwin', '/Users/alex/Library/Application Support/Google/Chrome'],
  ['win32', 'C:\\Users\\alex\\AppData\\Local\\Google\\Chrome\\User Data'],
  ['linux', '/home/alex/.config/google-chrome'],
])('discovers every Chrome profile on %s', async (platform, root) => {
  const fs = fakeFs([
    `${root}/Default/History`,
    `${root}/Profile 1/History`,
    `${root}/Profile 2/History`,
  ]);
  const profiles = await discoverProfiles(context({ platform, fs }));
  expect(profiles.filter((profile) => profile.browserId === 'chrome')).toHaveLength(3);
});

it('discovers Firefox profiles from profiles.ini', async () => {
  const fs = fakeFs([], {
    '/home/alex/.mozilla/firefox/profiles.ini': '[Profile0]\nName=Personal\nIsRelative=1\nPath=abc.default-release\n',
    '/home/alex/.mozilla/firefox/abc.default-release/places.sqlite': '',
  });
  expect((await discoverProfiles(context({ platform: 'linux', fs })))[0].profileName).toBe('Personal');
});

it('offers Safari only on macOS', async () => {
  expect(await discoverProfiles(context({ platform: 'win32', fs: fakeFs([]) }))).not.toContainEqual(expect.objectContaining({ browserId: 'safari' }));
});
```

- [ ] **Step 2: Run discovery tests and verify RED**

Run: `npm test -- tests/platform/discovery.test.ts`

Expected: FAIL because discovery is missing.

- [ ] **Step 3: Implement the browser catalog and injected discovery**

Define known roots for Chrome, Edge, Brave, Chromium, Vivaldi, Firefox, and Safari. Use `path.win32` for Windows filesystem paths and `path.posix` elsewhere. For Chromium roots, accept `Default`, `Profile *`, and other directories containing a `History` file; sort by canonical path. Parse Firefox INI sections without adding a dependency, respecting `IsRelative`. Safari returns one `History` profile at `~/Library/Safari/History.db`.

Stable source keys use `browserId + ':' + sha256(canonical database parent path).slice(0, 16)`. Profile display names come from Firefox INI names or Chromium directory names.

- [ ] **Step 4: Run discovery tests and verify GREEN**

Run: `npm test -- tests/platform/discovery.test.ts`

Expected: all macOS, Windows, Linux, multi-profile, missing-root, and deterministic-order tests pass.

- [ ] **Step 5: Commit discovery**

```bash
git add src/platform tests/platform tests/helpers/fake-fs.ts
git commit -m "feat: discover desktop browser profiles"
```

---

### Task 4: SQLite Runtime, Temporary Snapshots, and Browser Readers

**Files:**
- Create: `src/sql/sqlite.ts`
- Create: `src/sql/snapshot.ts`
- Create: `src/browsers/reader.ts`
- Create: `src/browsers/chromium.ts`
- Create: `src/browsers/firefox.ts`
- Create: `src/browsers/safari.ts`
- Create: `tests/sql/snapshot.test.ts`
- Create: `tests/browsers/chromium.test.ts`
- Create: `tests/browsers/firefox.test.ts`
- Create: `tests/browsers/safari.test.ts`
- Create: `tests/helpers/sqlite-fixture.ts`

**Interfaces:**
- Consumes: `BrowserProfile`, `NormalizedVisit`, and `ProfileCursor`.
- Produces: `SqliteDatabase`, `SqliteFactory`, `withDatabaseSnapshot(path, operation)`, `BrowserHistoryReader`, `ChromiumReader`, `FirefoxReader`, and `SafariReader`.

- [ ] **Step 1: Write the failing temporary-snapshot lifecycle test**

```ts
it('always removes its isolated snapshot after the callback fails', async () => {
  const temp = fakeTempFiles('/tmp/browser-sync-run');
  await expect(withDatabaseSnapshot('/browser/History', temp, async (snapshot) => {
    expect(snapshot).toBe('/tmp/browser-sync-run/History');
    throw new Error('reader failed');
  })).rejects.toThrow('reader failed');
  expect(temp.removed).toEqual(['/tmp/browser-sync-run']);
});
```

- [ ] **Step 2: Run the snapshot test and verify RED**

Run: `npm test -- tests/sql/snapshot.test.ts`

Expected: FAIL because snapshot support is missing.

- [ ] **Step 3: Implement WASM initialization and snapshot cleanup**

Initialize `sql.js` once and locate `sql-wasm.wasm` relative to the installed plugin directory supplied by `src/main.ts`. Wrap the resulting database behind:

```ts
export interface SqliteDatabase {
  all<T extends Record<string, unknown>>(sql: string, params?: Record<string, string | number>): T[];
  hasTable(name: string): boolean;
  close(): void;
}
```

`withDatabaseSnapshot` must create a unique `mkdtemp` directory, copy the main database, call the operation, and recursively remove only that exact temporary directory in `finally`.

- [ ] **Step 4: Run the snapshot test and verify GREEN**

Run: `npm test -- tests/sql/snapshot.test.ts`

Expected: snapshot cleanup tests pass for success, copy failure, and callback failure.

- [ ] **Step 5: Write failing reader tests with synthetic SQLite databases**

For each schema, create the minimum real tables and rows via `tests/helpers/sqlite-fixture.ts`. Assert timestamp conversion, all visits for a repeated URL, cursor boundary overlap, browser/profile metadata, empty title behavior, and a clear schema error. Representative Chromium assertion:

```ts
it('maps every Chromium visit instead of collapsing repeated URLs', async () => {
  const db = await chromiumFixture([
    { id: 7, urlId: 1, visitTime: chromiumMicros('2026-08-03T10:00:00Z') },
    { id: 8, urlId: 1, visitTime: chromiumMicros('2026-08-03T10:05:00Z') },
  ]);
  const visits = new ChromiumReader().read(db, chromeProfile(), undefined);
  expect(visits.map((item) => item.sourceVisitId)).toEqual(['7', '8']);
  expect(visits.map((item) => item.url)).toEqual(['https://example.com', 'https://example.com']);
});
```

Use these epoch conversions in fixtures and production:

```ts
const CHROMIUM_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000;
const SAFARI_EPOCH_OFFSET_SECONDS = 978_307_200;
// Firefox visit_date is Unix microseconds.
```

- [ ] **Step 6: Run reader tests and verify RED**

Run: `npm test -- tests/browsers`

Expected: FAIL because readers are missing.

- [ ] **Step 7: Implement schema validation and the three readers**

Define:

```ts
export interface BrowserHistoryReader {
  read(db: SqliteDatabase, profile: BrowserProfile, cursor?: ProfileCursor): NormalizedVisit[];
}
```

Chromium joins `visits` to `urls`, Firefox joins `moz_historyvisits` to `moz_places`, and Safari joins `history_visits` to `history_items`. Query from `cursor.visitedAtMs - 120_000` milliseconds to provide a two-minute overlap. Sort by `visitedAt`, then numeric source ID when possible, otherwise lexical source ID. Reject missing required tables or columns with `Unsupported <browser> history schema`.

- [ ] **Step 8: Run reader tests and verify GREEN**

Run: `npm test -- tests/browsers tests/sql`

Expected: all snapshot and reader tests pass.

- [ ] **Step 9: Copy and verify the production WASM asset, then commit**

Add an esbuild production step that copies `node_modules/sql.js/dist/sql-wasm.wasm` to the project root beside `main.js`. Do not commit generated `main.js`; do commit the WASM only if the repository's release policy chooses source-controlled artifacts. For this repository, ignore both generated files and verify them during build.

```bash
git add src/sql src/browsers tests/sql tests/browsers tests/helpers/sqlite-fixture.ts esbuild.config.mjs .gitignore
git commit -m "feat: read browser history databases"
```

---

### Task 5: Transactional Import Orchestration and Recovery

**Files:**
- Create: `src/sync/importer.ts`
- Create: `tests/sync/importer.test.ts`
- Create: `tests/helpers/fake-vault.ts`

**Interfaces:**
- Consumes: discovery, snapshot, readers, output planner/renderer, `PersistedData`, and `VaultPort`.
- Produces: `ImportDependencies`, `ImportRequest`, `runImport(request, dependencies)`, and `ImportAlreadyRunningError`.

- [ ] **Step 1: Write failing first-run and repeat-run tests**

```ts
it('imports every visit once and advances each successful profile cursor', async () => {
  const vault = fakeVault();
  const state = persisted();
  const first = await runImport(request(state), deps({ vault, visits: [visit({ sourceVisitId: '1' }), visit({ sourceVisitId: '2' })] }));
  expect(first.imported).toBe(2);
  expect(state.cursors['chrome:profile']).toEqual(expect.objectContaining({ sourceVisitId: '2' }));

  const second = await runImport(request(state), deps({ vault, visits: [visit({ sourceVisitId: '1' }), visit({ sourceVisitId: '2' })] }));
  expect(second.imported).toBe(0);
  expect(second.alreadyPresent).toBe(2);
  expect(vault.readText('Browser History/2026/2026-08.md').match(/obsidian-browser-sync/g)).toHaveLength(2);
});
```

- [ ] **Step 2: Run importer tests and verify RED**

Run: `npm test -- tests/sync/importer.test.ts`

Expected: FAIL because the importer is missing.

- [ ] **Step 3: Implement grouping, serialized writes, and cursor commits**

Define dependencies as injected functions so tests use no real browser data:

```ts
export interface ImportDependencies {
  discover: () => Promise<BrowserProfile[]>;
  readVisits: (profile: BrowserProfile, cursor?: ProfileCursor) => Promise<NormalizedVisit[]>;
  vault: VaultPort;
  saveData: (data: PersistedData) => Promise<void>;
}
```

Filter profiles by browser toggle. Process profile reads independently. Build one global map of destination path to sorted candidate entries, read each note once, suppress existing marker IDs, and serialize writes per path. Track which profile owns each candidate. Only update and persist a profile cursor after all its candidate paths succeed. Use the newest `(visitedAtMs, sourceVisitId)` pair as its cursor.

- [ ] **Step 4: Add failing interruption and state-recovery tests**

```ts
it('does not advance a cursor when one planned note write fails', async () => {
  const state = persisted();
  const vault = fakeVault({ failAppend: 'Browser History/2026/2026-09.md' });
  const result = await runImport(request(state), deps({ vault, visits: visitsAcrossAugustAndSeptember() }));
  expect(state.cursors['chrome:profile']).toBeUndefined();
  expect(result.failedProfiles).toHaveLength(1);
});

it('recovers from missing cursor state by reading hidden markers', async () => {
  const vault = fakeVaultWithRenderedVisit(visit({ sourceVisitId: '1' }));
  const state = persisted({ cursors: {} });
  const result = await runImport(request(state), deps({ vault, visits: [visit({ sourceVisitId: '1' }), visit({ sourceVisitId: '2' })] }));
  expect(result.imported).toBe(1);
  expect(result.alreadyPresent).toBe(1);
});
```

- [ ] **Step 5: Run recovery tests and verify RED, then implement minimal fixes**

Run: `npm test -- tests/sync/importer.test.ts`

Expected before fixes: the two new tests fail for cursor advancement and duplicate recovery. Implement per-profile path success tracking and existing-marker scanning, then rerun until all importer tests pass.

- [ ] **Step 6: Add and pass concurrency and partial-failure tests**

Test that a second call while a shared run guard is active rejects with `ImportAlreadyRunningError`; a missing browser is skipped; one corrupt profile does not prevent another profile from importing; and two profiles targeting the same note retain both entries in stable chronological order.

Run: `npm test -- tests/sync/importer.test.ts`

Expected: all importer tests pass.

- [ ] **Step 7: Commit orchestration**

```bash
git add src/sync tests/sync tests/helpers/fake-vault.ts
git commit -m "feat: import history idempotently"
```

---

### Task 6: Obsidian Vault Adapter, Settings UI, and Manual Command

**Files:**
- Create: `src/obsidian-vault.ts`
- Create: `src/settings-tab.ts`
- Replace: `src/main.ts`
- Create: `tests/obsidian-vault.test.ts`
- Create: `tests/main.test.ts`

**Interfaces:**
- Consumes: all core interfaces and `runImport`.
- Produces: `ObsidianVaultPort`, `BrowserSyncSettingTab`, and the default `BrowserSyncPlugin` class.

- [ ] **Step 1: Write failing vault-adapter tests**

Use a minimal Obsidian API mock to verify recursive folder creation, create versus append behavior, normalized vault-relative paths, and refusal to write at or below `.obsidian`.

```ts
it('creates missing parent folders before a note', async () => {
  const api = fakeObsidianVault();
  const vault = new ObsidianVaultPort(api);
  await vault.ensureFolder('Browser History/2026');
  expect(api.createdFolders).toEqual(['Browser History', 'Browser History/2026']);
});
```

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `npm test -- tests/obsidian-vault.test.ts`

Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Implement the Obsidian vault adapter and verify GREEN**

Use `normalizePath`, `Vault.getAbstractFileByPath`, `Vault.createFolder`, `Vault.create`, `Vault.read`, and `Vault.append`. Handle the race where another operation creates a folder between existence check and creation by rechecking before propagating the error.

Run: `npm test -- tests/obsidian-vault.test.ts`

Expected: all adapter tests pass.

- [ ] **Step 4: Write failing plugin command and persistence tests**

```ts
it('registers exactly one manual import command and no startup import', async () => {
  const plugin = pluginHarness();
  await plugin.onload();
  expect(plugin.commands.map((command) => command.id)).toEqual(['import-browser-history']);
  expect(plugin.runImportCalls).toBe(0);
  await plugin.commands[0].callback();
  expect(plugin.runImportCalls).toBe(1);
});
```

Also assert notices summarize imported, already-present, skipped, and failed counts without visited URLs.

- [ ] **Step 5: Run plugin tests and verify RED**

Run: `npm test -- tests/main.test.ts`

Expected: FAIL until the final plugin class exists.

- [ ] **Step 6: Implement the plugin entry point**

On load: migrate `loadData()`, create a settings tab, initialize sql.js with the installed plugin directory, and register only:

```ts
this.addCommand({
  id: 'import-browser-history',
  name: 'Import browser history',
  callback: () => this.importBrowserHistory(),
});
```

The callback validates settings, discovers enabled profiles, selects the reader by `readerKind`, runs the importer, saves state after cursor commits, and shows actionable notices. Map `EACCES`/`EPERM` for Safari on macOS to Full Disk Access guidance. Do not log full URLs.

- [ ] **Step 7: Implement the settings tab**

Render separate toggles for Safari, Firefox, Chrome, Edge, Brave, Chromium, and Vivaldi; an output-folder text field; dropdowns for layout and period; and a read-only detected-profile/status section. Disable Safari's toggle outside macOS. Validate on change and save through one plugin method. Use only Obsidian components (`Setting`, `PluginSettingTab`) and a small CSS class for status rows.

- [ ] **Step 8: Run focused and full tests, then commit**

Run: `npm test -- tests/main.test.ts tests/obsidian-vault.test.ts`

Expected: all UI-adapter and command tests pass.

Run: `npm test`

Expected: the complete suite passes.

```bash
git add src/main.ts src/settings-tab.ts src/obsidian-vault.ts tests/main.test.ts tests/obsidian-vault.test.ts styles.css
git commit -m "feat: expose browser import in Obsidian"
```

---

### Task 7: Documentation, Release Verification, and Cross-Platform Acceptance

**Files:**
- Create: `README.md`
- Modify: `package.json`
- Modify: `esbuild.config.mjs`
- Modify: `manifest.json`
- Create: `tests/release.test.ts`

**Interfaces:**
- Consumes: final plugin behavior and build artifacts.
- Produces: documented installation/permissions workflow and a verifiable release bundle.

- [ ] **Step 1: Write a failing release-artifact test**

```ts
it('builds the complete desktop-only release', async () => {
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  expect(manifest.id).toBe('obsidian-browser-sync');
  expect(manifest.isDesktopOnly).toBe(true);
  for (const artifact of ['main.js', 'manifest.json', 'styles.css', 'sql-wasm.wasm']) {
    expect((await stat(artifact)).size).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: Run release test without building and verify RED**

Run: `npm test -- tests/release.test.ts`

Expected: FAIL because generated `main.js` and `sql-wasm.wasm` are absent from a clean checkout.

- [ ] **Step 3: Finalize the production build**

Make `npm run build` typecheck, bundle/minify `src/main.ts` as CommonJS targeting ES2021 with `obsidian`, Electron, CodeMirror, Lezer, and Node built-ins external, then copy the production WASM asset. Ensure the WASM runtime resolves the file inside the installed plugin directory rather than the development working directory.

- [ ] **Step 4: Write user documentation**

Document:

- Desktop-only OS and browser support matrix.
- Manual command usage.
- All settings and the default `Browser History/2026/2026-08.md` example.
- Flat and tiered path examples, including ISO-week boundary behavior.
- All-profile behavior and repeated visits.
- Idempotency markers and machine-specific cursor state.
- Safari Full Disk Access steps and browser-lock/retry guidance.
- Local-only privacy model and absence of network/browser writes.
- Source installation and release installation instructions.
- A recommendation for Git-controlled vaults: ignore installed plugin artifacts or accept the approximately 660 kB WASM blob; generated history is Markdown.

- [ ] **Step 5: Run the full verification gate**

Run: `npm run lint`

Expected: exit 0 with no warnings.

Run: `npm test`

Expected: all tests pass with zero failures.

Run: `npm run build`

Expected: exit 0 and all four release artifacts exist.

Run: `npm test -- tests/release.test.ts`

Expected: release test passes after the fresh build.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Perform acceptance review against the design spec**

Read `docs/superpowers/specs/2026-08-02-obsidian-browser-sync-design.md` line by line and check each acceptance criterion against a test or inspected artifact. Record any uncovered criterion as a new failing test and implementation cycle before proceeding.

- [ ] **Step 7: Commit the verified release**

```bash
git add README.md package.json package-lock.json esbuild.config.mjs manifest.json tests/release.test.ts
git commit -m "docs: prepare browser sync release"
```

---

## Final Verification

After all task commits, run fresh commands from the repository root:

```bash
npm ci
npm run lint
npm test
npm run build
npm test -- tests/release.test.ts
git status --short
```

Expected: dependency installation exits 0; lint has no warnings; all tests pass; build exits 0; the release test confirms all four artifacts; Git status shows only intentionally ignored generated artifacts or is clean.
