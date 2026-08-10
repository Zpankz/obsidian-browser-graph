# Multi-format Browser History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Markdown, CSV, and JSON browser-history exports plus a safe command that converts existing managed exports to the selected format without resetting browser cursors.

**Architecture:** Introduce one canonical browser-history document model and focused codecs for each format. The importer and converter share codec lookup, record reconciliation, managed-ID indexing, and vault operations; `data.json` remains device-specific incremental state independent of output format.

**Tech Stack:** TypeScript 6, Obsidian 1.13 APIs, Vitest 4, ESLint, esbuild, Node.js standard library only.

## Global Constraints

- Keep persisted data at version 3 and retain valid same-device cursors when adding settings defaults.
- Add no runtime dependency and make no network request.
- Default `outputFormat` to `markdown` and `formatConversionBehavior` to `keep`.
- Preserve the attached JSON schema version 1, including optional `original_title` and optional nested `sync`.
- Never fabricate IDs for legacy records.
- Preserve chronological order and repeated visits.
- Apply the current Markdown-safe control-character and whitespace normalization once when forming canonical title/browser/profile text; format escaping happens only inside codecs.
- Move replace-mode sources through Obsidian trash only after the destination writes and validates successfully.
- Retain Markdown sources containing unrecognized user content in replace mode.
- Treat browser-history content as untrusted and never log titles or URLs.
- Keep normal import ID indexing vault-wide and rebuild indexing limited to the active output folder.

---

## File structure

- Create `src/output/document.ts`: canonical document/record types, normalized-visit adapter, record comparison, fingerprinting, and reconciliation.
- Create `src/output/codec.ts`: codec interface, registry, format/extension lookup, managed parse result.
- Create `src/output/json.ts`: schema-version-1 JSON parser and serializer.
- Create `src/output/csv.ts`: fixed-schema RFC 4180 parser/serializer and reversible spreadsheet safety encoding.
- Modify `src/output/markdown.ts`: retain rendering and marker extraction; add strict canonical parsing and managed-content detection.
- Modify `src/output/file-name.ts`: format-aware extension generation.
- Modify `src/output/periods.ts`: pass selected output format into destination path generation.
- Modify `src/domain.ts`: settings types, conversion summary, and generalized vault port.
- Modify `src/settings.ts` and `src/settings-tab.ts`: defaults, migration, validation, persistence patches, and dropdowns.
- Modify `src/obsidian-vault.ts` and `tests/helpers/fake-vault.ts`: scan supported files, replace content, and trash sources.
- Modify `src/sync/importer.ts`: canonical records, codec-selected output, and cross-format ID indexing.
- Create `src/sync/converter.ts`: conversion discovery, grouping, merge, validation, keep/replace behavior, and summary.
- Create `src/sync/operation-guard.ts`: one exclusive guard shared by import, rebuild, and conversion.
- Modify `src/main.ts`: command registration, runtime dependency wiring, settings snapshots, notices, and error categorization.
- Add focused tests under `tests/output/`, `tests/sync/`, and existing settings/main/vault suites.
- Create `tests/helpers/history-documents.ts`: synthetic canonical document/record builders with no real browsing data.
- Modify `README.md`: formats, schemas, commands, cursor semantics, safety, and legacy limitations.

---

### Task 1: Canonical document model and JSON codec

**Files:**
- Create: `src/output/document.ts`
- Create: `src/output/json.ts`
- Create: `tests/helpers/history-documents.ts`
- Test: `tests/output/document.test.ts`
- Test: `tests/output/json.test.ts`

**Interfaces:**
- Produces: `HistorySourceFormat`, `VisitRepresentation`, `BrowserHistorySync`, `BrowserHistoryRecord`, `BrowserHistoryDocument`, `ManagedDocumentParse`, `recordFromVisit(visit)`, `compareHistoryRecords(left, right)`, `reconcileRecords(documents)`, `parseJsonDocument(content)`, and `serializeJsonDocument(document)`.
- Consumes: existing `NormalizedVisit`, `formatLocalIsoTimestamp()`, and `stableVisitId()`.

- [ ] **Step 1: Write failing canonical-model tests**

```ts
import { expect, it } from 'vitest';
import {
  recordFromVisit,
  reconcileRecords,
} from '../../src/output/document';
import { stableVisitId } from '../../src/output/markdown';
import { visit } from '../helpers/visits';

it('maps a normalized visit to an unescaped canonical record with sync metadata', () => {
  const input = visit({ title: '[raw] title', url: 'https://example.com/a b' });
  expect(recordFromVisit(input)).toMatchObject({
    title: '[raw] title',
    url: 'https://example.com/a b',
    representation: 'markdown_link',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: input.browserId,
      id: stableVisitId(input),
    },
  });
});

it('preserves repeated ID-less records by maximum per-document occurrence count', () => {
  const legacy = {
    timestamp: '2024-07-01T08:57:04+03:00',
    title: 'Legacy',
    url: 'https://example.com/',
    browser: 'Safari',
    profile: 'History',
    representation: 'markdown_link' as const,
  };
  expect(reconcileRecords([[legacy, legacy], [legacy]])).toEqual([legacy, legacy]);
});
```

Create synthetic helpers used throughout later codec tests:

```ts
export function historyRecord(
  overrides: Partial<BrowserHistoryRecord> = {},
): BrowserHistoryRecord {
  return {
    timestamp: '2026-08-03T15:34:56+03:00',
    title: 'Example page',
    url: 'https://example.com/',
    browser: 'Google Chrome',
    profile: 'Default',
    representation: 'markdown_link',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: 'chrome',
      id: '1234567890abcdef12345678',
    },
    ...overrides,
  };
}

export function historyDocument(
  overrides: Partial<BrowserHistoryDocument> = {},
): BrowserHistoryDocument {
  return {
    schema_version: 1,
    type: 'browser_history',
    metadata: {
      browser_sync: true,
      period: '2026-08',
      heading: 'Browser history',
      source_format: 'obsidian_browser_sync_browser_database',
    },
    records: [historyRecord()],
    ...overrides,
  };
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx vitest run tests/output/document.test.ts`

Expected: FAIL because `src/output/document.ts` does not exist.

- [ ] **Step 3: Implement canonical types, adaptation, validation helpers, ordering, and reconciliation**

```ts
export type HistorySourceFormat =
  | 'obsidian_browser_sync_browser_database'
  | 'obsidian_browser_sync_markdown'
  | 'obsidian_browser_sync_csv'
  | 'obsidian_browser_sync_json'
  | 'obsidian_browser_sync_mixed';

export type VisitRepresentation = 'markdown_link' | 'inert_text';

export interface BrowserHistorySync {
  namespace: 'obsidian-browser-sync';
  browser: BrowserId;
  id: string;
}

export interface BrowserHistoryRecord {
  timestamp: string;
  title: string;
  url: string;
  browser: string;
  profile: string;
  representation: VisitRepresentation;
  original_title?: string;
  sync?: BrowserHistorySync;
}

export interface BrowserHistoryDocument {
  schema_version: 1;
  type: 'browser_history';
  metadata: {
    browser_sync: true;
    period: string;
    heading: 'Browser history';
    source_format: HistorySourceFormat;
  };
  records: BrowserHistoryRecord[];
}

export interface ManagedDocumentParse {
  document: BrowserHistoryDocument;
  hasUnrecognizedContent: boolean;
}
```

Implement `recordFromVisit()` using the existing local timestamp and stable ID. Normalize title, browser, and profile control characters/whitespace with one exported canonical text function equivalent to the current Markdown label normalization, but do not apply Markdown/HTML escaping there. Set `markdown_link` only for parseable HTTP(S) URLs; otherwise use `inert_text`. Implement strict record guards, including full local ISO timestamp syntax and a finite `Date.parse()` result. Reconcile sync records by ID, throw on conflicting semantic data, and reconcile ID-less records by canonical fingerprint plus the highest occurrence count in any input document. Sort by parsed instant, then timestamp text, then sync ID or canonical fingerprint so different UTC offsets remain chronologically correct and ties are deterministic.

- [ ] **Step 4: Write failing JSON compatibility tests using both attached schema shapes**

```ts
it('parses current records with sync and legacy records without sync', () => {
  const currentRecord = historyRecord();
  const legacyRecord = historyRecord({
    timestamp: '2024-07-01T08:57:04+03:00',
  });
  delete legacyRecord.sync;
  const parsed = parseJsonDocument(JSON.stringify({
    schema_version: 1,
    type: 'browser_history',
    metadata: {
      browser_sync: true,
      period: '2026-08',
      heading: 'Browser history',
      source_format: 'obsidian_browser_sync_markdown',
    },
    records: [currentRecord, legacyRecord],
  }));
  expect(parsed.document.records).toEqual([currentRecord, legacyRecord]);
  expect(parsed.hasUnrecognizedContent).toBe(false);
});

it.each([2, 0, '1'])('rejects unsupported schema version %j', (schema_version) => {
  const validMetadata = historyDocument().metadata;
  expect(() => parseJsonDocument(JSON.stringify({
    schema_version,
    type: 'browser_history',
    metadata: validMetadata,
    records: [],
  }))).toThrow('schema_version');
});
```

- [ ] **Step 5: Implement strict JSON parsing and stable pretty serialization**

```ts
export function parseJsonDocument(content: string): ManagedDocumentParse {
  const value: unknown = JSON.parse(content);
  const document = validateBrowserHistoryDocument(value);
  return { document, hasUnrecognizedContent: false };
}

export function serializeJsonDocument(document: BrowserHistoryDocument): string {
  validateBrowserHistoryDocument(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}
```

Clone validated values so callers cannot retain unvalidated aliases. Reject incorrect type, marker, period, heading, source format, required record fields, representation, namespace, browser ID, or 24-character lowercase hexadecimal sync ID.

- [ ] **Step 6: Run focused tests, then commit**

Run: `npx vitest run tests/output/document.test.ts tests/output/json.test.ts`

Expected: PASS.

```bash
git add src/output/document.ts src/output/json.ts tests/helpers/history-documents.ts tests/output/document.test.ts tests/output/json.test.ts
git commit -m "feat: add canonical history documents and JSON codec"
```

---

### Task 2: CSV codec with reversible spreadsheet safety

**Files:**
- Create: `src/output/csv.ts`
- Test: `tests/output/csv.test.ts`

**Interfaces:**
- Consumes: `BrowserHistoryDocument`, `BrowserHistoryRecord`, `ManagedDocumentParse`, and shared validation from `src/output/document.ts`.
- Produces: `CSV_HEADER`, `encodeCsvText(value)`, `decodeCsvText(value)`, `parseCsvDocument(content)`, and `serializeCsvDocument(document)`.

- [ ] **Step 1: Write failing CSV tests for structure and round trips**

```ts
import { historyDocument, historyRecord } from '../helpers/history-documents';

it('round-trips commas, quotes, Unicode, and embedded CRLF', () => {
  const document = historyDocument({
    records: [historyRecord({
      title: '="formula", café\r\nsecond line',
      url: 'https://example.com/?a=1,b=2',
      original_title: "'original",
    })],
  });
  const csv = serializeCsvDocument(document);
  expect(csv.split(/\r\n/, 1)[0]).toBe(CSV_HEADER.join(','));
  expect(parseCsvDocument(csv).document).toEqual(document);
});

it.each(['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\tformula', '\rformula', '\nformula', "'literal"])(
  'encodes and decodes spreadsheet-sensitive text %j',
  (value) => {
    const encoded = encodeCsvText(value);
    expect(['=', '+', '-', '@', '\t', '\r', '\n']).not.toContain(encoded[0]);
    expect(decodeCsvText(encoded)).toBe(value);
  },
);
```

- [ ] **Step 2: Run the CSV tests and verify they fail**

Run: `npx vitest run tests/output/csv.test.ts`

Expected: FAIL because `src/output/csv.ts` does not exist.

- [ ] **Step 3: Implement the fixed header and bijective text encoding**

```ts
export const CSV_HEADER = [
  'schema_version', 'type', 'metadata_browser_sync', 'metadata_period',
  'metadata_heading', 'metadata_source_format', 'timestamp', 'title', 'url',
  'browser', 'profile', 'representation', 'original_title',
  'sync_namespace', 'sync_browser', 'sync_id',
] as const;

const FORMULA_TRIGGER = /^[=+\-@\t\r\n]/;

export function encodeCsvText(value: string): string {
  return value.startsWith("'") || FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

export function decodeCsvText(value: string): string {
  if (value.startsWith("''") || /^'[=+\-@\t\r\n]/.test(value)) {
    return value.slice(1);
  }
  return value;
}
```

- [ ] **Step 4: Implement RFC 4180 parsing, serialization, and validation**

Use a small state machine that distinguishes quoted and unquoted fields, doubled quotes, commas, CRLF, LF inside quoted fields, and final empty fields. Require the exact header once, require consistent document metadata on every row, decode record text cells, reconstruct optional nested sync only when all three sync cells are present, and reject partial sync values.

```ts
export function serializeCsvDocument(document: BrowserHistoryDocument): string {
  validateBrowserHistoryDocument(document);
  const rows = [CSV_HEADER, ...document.records.map((record) => rowFor(document, record))];
  return `${rows.map((row) => row.map(quoteCsvField).join(',')).join('\r\n')}\r\n`;
}

export function parseCsvDocument(
  content: string,
  context: { period?: string } = {},
): ManagedDocumentParse {
  const rows = parseCsvRows(content);
  assertExactHeader(rows.shift());
  const document = documentFromRows(rows, context);
  validateBrowserHistoryDocument(document);
  return { document, hasUnrecognizedContent: false };
}
```

For header-only CSV, require parse context `{ period: string }` supplied by the codec registry from the destination filename/period group; otherwise reject the missing metadata.

- [ ] **Step 5: Add rejection tests and run the focused suite**

Add exact tests for duplicate/missing headers, bare quotes, truncated quoted fields, inconsistent metadata rows, partial sync cells, and incorrect schema/type/marker. Run:

`npx vitest run tests/output/csv.test.ts tests/output/document.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the CSV codec**

```bash
git add src/output/csv.ts tests/output/csv.test.ts
git commit -m "feat: add safe CSV history codec"
```

---

### Task 3: Strict Markdown parser and codec registry

**Files:**
- Create: `src/output/codec.ts`
- Modify: `src/output/markdown.ts`
- Modify: `tests/output/markdown.test.ts`
- Create: `tests/output/codec.test.ts`

**Interfaces:**
- Consumes: canonical document types and JSON/CSV functions from Tasks 1-2.
- Produces: `OutputFormat`, `HistoryCodec`, `codecFor(format)`, `formatForPath(path)`, `parseMarkdownDocument(content)`, and `serializeMarkdownDocument(document)`.

- [ ] **Step 1: Write failing strict Markdown parsing tests**

```ts
it('parses generated entries into raw canonical values and sync metadata', () => {
  const input = visit({ title: '[unsafe]', url: 'https://example.com/a b' });
  const content = newNote('2026-08', [renderVisit(input).trimEnd()]);
  const parsed = parseMarkdownDocument(content);
  expect(parsed.document.records[0]).toMatchObject({
    title: '[unsafe]',
    url: 'https://example.com/a b',
    sync: { id: stableVisitId(input) },
  });
  expect(parsed.hasUnrecognizedContent).toBe(false);
});

it('reports user-authored content without treating marker examples as records', () => {
  const content = `${newNote('2026-08', [])}My private note\n`;
  const parsed = parseMarkdownDocument(content);
  expect(parsed.document.records).toEqual([]);
  expect(parsed.hasUnrecognizedContent).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run tests/output/markdown.test.ts`

Expected: FAIL because `parseMarkdownDocument` is not exported.

- [ ] **Step 3: Implement strict generated-block parsing without weakening rendering safety**

Recognize exact Browser Sync frontmatter and period, exact `# Browser history` heading, generated visit lines, and an optional immediately following standalone marker. A marked line becomes a modern record; an otherwise exact generated visit line without a marker becomes a legacy ID-less record. Reverse only escaping produced by the renderer; do not interpret general Markdown. Track every non-whitespace span not consumed by frontmatter, heading, or a generated visit block as unrecognized content. Preserve `original_title` when exact source spelling is needed to serialize the same Markdown representation.

```ts
export function parseMarkdownDocument(content: string): ManagedDocumentParse {
  const envelope = parseManagedEnvelope(content);
  const records: BrowserHistoryRecord[] = [];
  const consumed = new Set<number>();
  for (const block of generatedVisitBlocks(envelope.bodyLines)) {
    records.push(recordFromMarkdownBlock(block));
    block.lineIndexes.forEach((index) => consumed.add(index));
  }
  return {
    document: historyDocument(envelope.period, 'obsidian_browser_sync_markdown', records),
    hasUnrecognizedContent: envelope.bodyLines.some(
      (line, index) => line.trim() !== '' && !consumed.has(index),
    ),
  };
}
```

- [ ] **Step 4: Write failing registry tests and implement exact codec lookup**

```ts
export type OutputFormat = 'markdown' | 'csv' | 'json';

export interface HistoryCodec {
  format: OutputFormat;
  extension: '.md' | '.csv' | '.json';
  parse(content: string, context?: { period?: string }): ManagedDocumentParse;
  serialize(document: BrowserHistoryDocument): string;
}

expect(codecFor('markdown').extension).toBe('.md');
expect(codecFor('csv').extension).toBe('.csv');
expect(codecFor('json').extension).toBe('.json');
expect(formatForPath('History/2026-08.JSON')).toBe('json');
expect(formatForPath('History/readme.txt')).toBeUndefined();
```

Register only the three codecs. Ensure `serializeMarkdownDocument()` reproduces the current note envelope and uses the existing safe renderer from canonical records.

Add `renderHistoryRecord(record)` as the canonical Markdown renderer. It writes the hidden marker only when `record.sync` exists; ID-less legacy records remain exact visit lines without a fabricated marker. Keep `renderVisit(visit)` as a compatibility wrapper around `recordFromVisit()` plus `renderHistoryRecord()` so existing callers and security tests continue to pass.

- [ ] **Step 5: Run output tests and commit**

Run: `npx vitest run tests/output`

Expected: PASS.

```bash
git add src/output/codec.ts src/output/markdown.ts tests/output/markdown.test.ts tests/output/codec.test.ts
git commit -m "feat: add Markdown parsing and output codec registry"
```

---

### Task 4: Format settings and destination extensions

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/settings.ts`
- Modify: `src/settings-tab.ts`
- Modify: `src/output/file-name.ts`
- Modify: `src/output/periods.ts`
- Modify: `src/main.ts`
- Modify: `tests/settings.test.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/output/periods.test.ts`

**Interfaces:**
- Consumes: `OutputFormat` from `src/output/codec.ts`.
- Produces: `FormatConversionBehavior`, expanded `PluginSettings`, format-aware `formatOutputFileName(template, period, format)`, and settings fields `outputFormat` / `formatConversionBehavior`.

- [ ] **Step 1: Write failing migration and destination-path tests**

```ts
expect(migratePersistedData(savedV3, DEVICE_A, NOW)).toMatchObject({
  version: 3,
  settings: {
    outputFormat: 'markdown',
    formatConversionBehavior: 'keep',
  },
  cursors: savedV3.cursors,
});

expect(destinationPath({
  ...DEFAULT_SETTINGS,
  outputFormat: 'json',
}, local('2026-08-03'))).toBe('Browser History/2026/2026-08.json');
```

- [ ] **Step 2: Run tests and verify type/test failures**

Run: `npx vitest run tests/settings.test.ts tests/output/periods.test.ts tests/main.test.ts`

Expected: FAIL because the new settings fields and format-aware extension are missing.

- [ ] **Step 3: Add types, defaults, migration, validation, clone, and persistence patch support**

```ts
export type FormatConversionBehavior = 'keep' | 'replace';

export interface PluginSettings {
  enabledBrowsers: Record<BrowserId, boolean>;
  outputFolder: string;
  fileNameTemplate: string;
  layout: OutputLayout;
  period: NotePeriod;
  outputFormat: OutputFormat;
  formatConversionBehavior: FormatConversionBehavior;
}
```

Add `outputFormat: 'markdown'` and `formatConversionBehavior: 'keep'` to `DEFAULT_SETTINGS`. Migrate only permitted values. Extend `validSettings`, `PluginSettingField`, `SettingsPatch`, `settingsPatch`, and `applySettingsPatch`. Confirm `clonePersistedData` and cursor persistence preserve both committed settings fields.

- [ ] **Step 4: Add dropdown UI tests and implement settings controls**

```ts
expect(setting('Export format').dropdown).toMatchObject({
  value: 'markdown',
  options: { markdown: 'Markdown', csv: 'CSV', json: 'JSON' },
});
expect(setting('Format conversion behavior').dropdown).toMatchObject({
  value: 'keep',
  options: { keep: 'Keep original files', replace: 'Replace original files' },
});
```

Place **Export format** near **File name template**. Use the description “Choose the file format for future browser history imports.” Use “The selected format's extension is added automatically” in the template description. Place conversion behavior after export format and state that it applies to the conversion command.

- [ ] **Step 5: Make filename and destination generation codec-aware**

```ts
export function formatOutputFileName(
  template: string,
  periodKey: string,
  format: OutputFormat,
): string {
  return `${template.split(PERIOD_TOKEN).join(periodKey)}${codecFor(format).extension}`;
}
```

Add `outputFormat` to the `destinationPath()` settings pick and update every caller/test fixture to pass it.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run tests/settings.test.ts tests/output/periods.test.ts tests/main.test.ts`

Expected: PASS.

```bash
git add src/domain.ts src/settings.ts src/settings-tab.ts src/output/file-name.ts src/output/periods.ts src/main.ts tests/settings.test.ts tests/output/periods.test.ts tests/main.test.ts
git commit -m "feat: add export format settings"
```

---

### Task 5: Generalized managed-file vault operations

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/obsidian-vault.ts`
- Modify: `tests/helpers/fake-vault.ts`
- Modify: `tests/obsidian-vault.test.ts`

**Interfaces:**
- Produces: `VaultFileSnapshot`, `VaultPort.scanFiles()`, `VaultPort.write()`, and `VaultPort.trash()`.
- Consumes: safe vault-path validation already used by `ObsidianVaultPort`.

- [ ] **Step 1: Write failing vault-port tests**

```ts
it('scans supported extensions in deterministic path order under an optional root', async () => {
  const seen: string[] = [];
  await port.scanFiles(['.md', '.csv', '.json'], ({ path }) => seen.push(path), 'History');
  expect(seen).toEqual([
    'History/2026-08.csv',
    'History/2026-08.json',
    'History/2026-08.md',
  ]);
});

it('writes existing files and trashes through the recoverable vault API', async () => {
  await port.write('History/2026-08.json', '{"ok":true}\n');
  await port.trash('History/old.md');
  expect(vault.modify).toHaveBeenCalled();
  expect(vault.trash).toHaveBeenCalledWith(expect.any(TFile), true);
});
```

- [ ] **Step 2: Run the focused vault tests and verify they fail**

Run: `npx vitest run tests/obsidian-vault.test.ts`

Expected: FAIL because `scanFiles`, `write`, and `trash` are absent.

- [ ] **Step 3: Expand the port and real adapter**

```ts
export interface VaultFileSnapshot {
  path: string;
  content: string;
}

export interface VaultPort {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  trash(path: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
  scanFiles(
    extensions: readonly string[],
    visit: (file: VaultFileSnapshot) => void | Promise<void>,
    root?: string,
  ): Promise<void>;
}
```

Implement `write()` with `vault.modify()` for an existing `TFile` and `create()` for a missing path. Implement `trash()` with `vault.trash(file, true)` so removal is recoverable. Implement `scanFiles()` by filtering `vault.getFiles()` on lowercase extensions and safe root containment, sorting paths, then reading each file. Remove `scanMarkdownFiles()` after migrating callers.

- [ ] **Step 4: Expand the fake vault with failure injection and trash visibility**

Support `failWrite`, `failTrash`, `write()`, `trash()`, `scanFiles()`, `hasFile(path)`, and `trashedPaths()`. Keep existing append failure behavior so old importer tests remain meaningful.

```ts
export interface FakeVault extends VaultPort {
  readText(path: string): string;
  hasFile(path: string): boolean;
  trashedPaths(): string[];
}
```

- [ ] **Step 5: Run vault and existing importer tests, then commit**

Run: `npx vitest run tests/obsidian-vault.test.ts tests/sync/importer.test.ts`

Expected: PASS.

```bash
git add src/domain.ts src/obsidian-vault.ts tests/helpers/fake-vault.ts tests/obsidian-vault.test.ts tests/sync/importer.test.ts
git commit -m "refactor: support managed history files in vault port"
```

---

### Task 6: Multi-format importer and shared operation guard

**Files:**
- Create: `src/sync/operation-guard.ts`
- Modify: `src/sync/importer.ts`
- Modify: `tests/sync/importer.test.ts`

**Interfaces:**
- Consumes: codec registry, canonical visit adaptation/reconciliation, generalized vault scanning, format-aware destination paths.
- Produces: `ExclusiveOperationGuard`, `browserSyncOperationGuard`, and importer support for all output formats.

- [ ] **Step 1: Write failing importer tests for JSON, CSV, and cross-format IDs**

```ts
it.each([
  ['json', 'Browser History/2026/2026-08.json'],
  ['csv', 'Browser History/2026/2026-08.csv'],
] as const)('imports and reruns idempotently as %s', async (outputFormat, path) => {
  const state = persisted({
    settings: {
      ...DEFAULT_SETTINGS,
      enabledBrowsers: { ...DEFAULT_SETTINGS.enabledBrowsers },
      outputFormat,
    },
  });
  const vault = fakeVault();
  const first = await runImport({ data: state }, deps({ vault, visits: [normalized()] }));
  const second = await runImport({ data: state }, deps({ vault, visits: [normalized()] }));
  expect(first.imported).toBe(1);
  expect(second.imported).toBe(0);
  expect(codecFor(outputFormat).parse(vault.readText(path)).document.records).toHaveLength(1);
});

it('indexes a JSON sync ID before importing to Markdown', async () => {
  const input = normalized();
  const existing = historyDocument({ records: [recordFromVisit(input)] });
  const vault = fakeVault({
    files: { 'Archive/old.json': serializeJsonDocument(existing) },
  });
  const result = await runImport({ data: persisted() }, deps({ vault, visits: [input] }));
  expect(result).toMatchObject({ imported: 0, alreadyPresent: 1 });
});
```

- [ ] **Step 2: Run importer tests and verify failures**

Run: `npx vitest run tests/sync/importer.test.ts`

Expected: FAIL because import still renders and scans Markdown only.

- [ ] **Step 3: Implement one shared exclusive operation guard**

```ts
export class BrowserSyncOperationAlreadyRunningError extends Error {}

export class ExclusiveOperationGuard {
  private running = false;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running) throw new BrowserSyncOperationAlreadyRunningError();
    this.running = true;
    try {
      return await operation();
    } finally {
      this.running = false;
    }
  }
}

export const browserSyncOperationGuard = new ExclusiveOperationGuard();
```

Replace the importer-local boolean and `ImportAlreadyRunningError` with the shared guard/error. Keep the public error wording compatible with existing notices.

- [ ] **Step 4: Refactor grouping and writes through canonical records and codecs**

For each destination, parse the existing managed document when present, reconcile with pending canonical records, serialize, parse back, and then write. Retain the current Markdown append path so user-authored content is never rewritten; use codec parsing only to inspect IDs and canonical records. Use `VaultPort.write()` for CSV/JSON. Count already-present candidates by sync ID before writes and preserve per-profile failure/cursor semantics.

```ts
const codec = codecFor(settings.outputFormat);
const candidate = {
  id: stableVisitId(visit),
  record: recordFromVisit(visit),
  owner,
};
const serialized = codec.serialize(mergedDocument);
codec.parse(serialized, { period: group.label });
await dependencies.vault.write(path, serialized);
```

- [ ] **Step 5: Replace Markdown-only indexing with safe all-codec indexing**

Scan `.md`, `.csv`, and `.json`; choose a codec by extension; ignore files that are not recognized managed exports; report recognized invalid managed destinations as write failures when they are active targets. Normal import scans the whole vault, while rebuild passes `settings.outputFolder` as root.

```ts
await vault.scanFiles(['.md', '.csv', '.json'], async ({ path, content }) => {
  const format = formatForPath(path);
  if (!format) return;
  const parsed = tryParseManaged(codecFor(format), content, periodFromPath(path));
  for (const record of parsed?.document.records ?? []) {
    if (record.sync) importedIds.add(record.sync.id);
  }
}, root);
```

- [ ] **Step 6: Add cursor-preservation, structured-write-failure, and guard tests**

Verify switching `outputFormat` never invokes `readVisits` with an undefined cursor unless rebuild was requested. Verify an invalid existing structured destination and a failed structured write do not advance the contributing profile cursor. Verify simultaneous imports yield one `BrowserSyncOperationAlreadyRunningError`.

- [ ] **Step 7: Run importer/output suites and commit**

Run: `npx vitest run tests/sync/importer.test.ts tests/output`

Expected: PASS.

```bash
git add src/sync/operation-guard.ts src/sync/importer.ts tests/sync/importer.test.ts
git commit -m "feat: import browser history in selected format"
```

---

### Task 7: Existing-export conversion service

**Files:**
- Create: `src/sync/converter.ts`
- Create: `tests/sync/converter.test.ts`

**Interfaces:**
- Consumes: `PluginSettings`, `VaultPort`, codec registry, canonical reconciliation, destination path generation, and `browserSyncOperationGuard`.
- Produces: `ConversionSummary` and `convertExistingExports(request, dependencies)`.

- [ ] **Step 1: Write failing keep-mode conversion tests**

```ts
it('converts managed Markdown to the selected JSON format and keeps the source', async () => {
  const input = visit();
  const vault = fakeVaultWithRenderedVisit(input);
  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json', formatConversionBehavior: 'keep' },
  }, { vault });
  expect(summary).toMatchObject({ converted: 1, retained: 1, failed: [] });
  expect(vault.hasFile('Browser History/2026/2026-08.md')).toBe(true);
  expect(parseJsonDocument(vault.readText('Browser History/2026/2026-08.json'))
    .document.records[0].sync?.id).toBe(stableVisitId(input));
});

it('does not multiply modern or repeated legacy records when rerun', async () => {
  const modern = historyRecord({ timestamp: '2024-07-01T08:56:04+03:00' });
  const legacy = historyRecord({
    timestamp: '2024-07-01T08:57:04+03:00',
    sync: undefined,
  });
  const source = 'Browser History/2024/2024-07.json';
  const target = 'Browser History/2024/2024-07.csv';
  const vault = fakeVault({
    files: {
      [source]: serializeJsonDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          period: '2024-07',
          source_format: 'obsidian_browser_sync_markdown',
        },
        records: [modern, legacy, legacy],
      })),
    },
  });
  const request = {
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'csv' as const,
      formatConversionBehavior: 'keep' as const,
    },
  };
  await convertExistingExports(request, { vault });
  await convertExistingExports(request, { vault });
  expect(parseCsvDocument(vault.readText(target)).document.records)
    .toEqual([modern, legacy, legacy]);
});
```

- [ ] **Step 2: Run converter tests and verify they fail**

Run: `npx vitest run tests/sync/converter.test.ts`

Expected: FAIL because `src/sync/converter.ts` does not exist.

- [ ] **Step 3: Implement scan, managed recognition, period grouping, merging, and validation**

```ts
export interface ConversionSummary {
  converted: number;
  alreadyCurrent: number;
  retained: number;
  skippedReplacement: number;
  failed: Array<{ path: string; category: string }>;
}

export interface ConversionRequest {
  settings: PluginSettings;
}

export interface ConversionDependencies {
  vault: VaultPort;
}

export async function convertExistingExports(
  request: ConversionRequest,
  dependencies: ConversionDependencies,
): Promise<ConversionSummary> {
  return browserSyncOperationGuard.run(() => performConversion(request, dependencies));
}
```

Scan only under `settings.outputFolder`. Ignore unsupported and clearly unmanaged files. Record recognized-invalid managed files as failures without including record data. Derive destination paths from each document's metadata period and the current layout/template/format. Include an existing target as an input to reconciliation. Set source metadata deterministically to the single source kind or `obsidian_browser_sync_mixed`.

- [ ] **Step 4: Write failing replace-mode transaction tests**

```ts
it('trashes a clean source only after a validated destination write', async () => {
  const source = 'Browser History/2026/2026-08.md';
  const vault = fakeVaultWithRenderedVisit(visit());
  const replaceRequest = {
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json' as const,
      formatConversionBehavior: 'replace' as const,
    },
  };
  const summary = await convertExistingExports(replaceRequest, { vault });
  expect(summary.skippedReplacement).toBe(0);
  expect(vault.trashedPaths()).toEqual([source]);
});

it('retains Markdown with user content and every source whose destination fails', async () => {
  const source = 'Browser History/2026/2026-08.md';
  const target = 'Browser History/2026/2026-08.json';
  const managedMarkdown = newNote('2026-08', [renderVisit(visit()).trimEnd()]);
  const vault = fakeVault({
    files: { [source]: `${managedMarkdown}\nPrivate note\n` },
    failWrite: target,
  });
  const replaceRequest = {
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json' as const,
      formatConversionBehavior: 'replace' as const,
    },
  };
  const summary = await convertExistingExports(replaceRequest, { vault });
  expect(summary.failed).toHaveLength(1);
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});
```

- [ ] **Step 5: Implement keep/replace behavior and per-destination failure isolation**

Serialize and parse back before `write()`. Re-read and validate the written destination before calling `trash()`. Never trash the selected-format target. In replace mode, retain sources with `hasUnrecognizedContent`, count them in `skippedReplacement`, and trash only clean non-target sources in stable path order. If write, read-back, or trash fails, report the path/category and continue with independent period groups.

- [ ] **Step 6: Add malformed, conflict, mixed-source, partial-sync, and concurrency tests**

Cover invalid managed JSON/CSV, same sync ID with conflicting semantics, mixed Markdown/CSV input, source-format metadata, a trash failure after successful output, and conversion racing an import. Assert all logs/summaries contain paths/categories only.

- [ ] **Step 7: Run converter and importer suites, then commit**

Run: `npx vitest run tests/sync/converter.test.ts tests/sync/importer.test.ts`

Expected: PASS.

```bash
git add src/sync/converter.ts tests/sync/converter.test.ts
git commit -m "feat: convert existing browser history exports"
```

---

### Task 8: Plugin command, notices, and runtime wiring

**Files:**
- Modify: `src/main.ts`
- Modify: `tests/main.test.ts`

**Interfaces:**
- Consumes: `convertExistingExports`, `ConversionSummary`, generalized `VaultPort`, and shared operation error.
- Produces: command `convert-browser-history-exports`, `convertBrowserHistoryExports()`, and conversion completion/error notices.

- [ ] **Step 1: Write failing command registration and settings-snapshot tests**

```ts
expect(plugin.commands.map((command) => command.id)).toEqual([
  'import-browser-history',
  'rebuild-browser-history-output',
  'convert-browser-history-exports',
]);
expect(plugin.commands[2].name).toBe('Convert existing browser history exports');

await plugin.commands[2].callback?.();
expect(fakeRuntime.runConverter).toHaveBeenCalledWith(
  { settings: originalSettingsSnapshot },
  { vault: fakeRuntime.vault },
);
```

- [ ] **Step 2: Run main tests and verify they fail**

Run: `npx vitest run tests/main.test.ts`

Expected: FAIL because the converter runtime dependency and command are absent.

- [ ] **Step 3: Wire conversion through the runtime and command callback**

```ts
export interface BrowserSyncRuntime {
  // existing fields remain
  runConverter(
    request: ConversionRequest,
    dependencies: ConversionDependencies,
  ): Promise<ConversionSummary>;
}

this.addCommand({
  id: 'convert-browser-history-exports',
  name: 'Convert existing browser history exports',
  callback: () => this.convertBrowserHistoryExports(),
});
```

Take a deep settings snapshot before any deferred work. Validate settings, ensure the configured output folder exists, and invoke the converter without modifying cursors or saved settings.

- [ ] **Step 4: Add completion, partial-failure, and busy notice tests**

```ts
expect(notice).toHaveBeenCalledWith(
  'Browser history conversion complete: 2 converted, 1 already current, 2 originals retained, 1 replacement skipped, 0 failed.',
);
expect(notice).toHaveBeenCalledWith('A Browser Sync operation is already running.');
```

Implement the exact completion sentence above with values from the summary. On partial failure, show the summary and one additional generic notice directing the user to check the output folder and console. Categorize failures without logging history contents.

- [ ] **Step 5: Run main tests and commit**

Run: `npx vitest run tests/main.test.ts`

Expected: PASS.

```bash
git add src/main.ts tests/main.test.ts
git commit -m "feat: expose browser history conversion command"
```

---

### Task 9: Cross-format fixtures, documentation, and release verification

**Files:**
- Create: `tests/output/roundtrip.test.ts`
- Modify: `README.md`
- Modify: `tests/release.test.ts` only if the documented release assertions need new user-facing text checks; do not change release artifacts otherwise.

**Interfaces:**
- Consumes: all three codecs, canonical reconciliation, settings, importer, converter, and plugin command.
- Produces: final compatibility coverage and user documentation.

- [ ] **Step 1: Add pairwise round-trip tests**

```ts
it.each([
  ['markdown', 'csv'], ['markdown', 'json'],
  ['csv', 'markdown'], ['csv', 'json'],
  ['json', 'markdown'], ['json', 'csv'],
] as const)('round-trips canonical records from %s to %s', (source, target) => {
  const first = codecFor(source).parse(codecFor(source).serialize(document)).document;
  const second = codecFor(target).parse(codecFor(target).serialize(first)).document;
  expect(second.records).toEqual(document.records);
});
```

Include modern sync records, legacy records, repeated identical visits, Markdown metacharacters, CSV formula triggers, Unicode, quotes, commas, HTTP(S), non-web schemes, and malformed URLs. Cover embedded newlines in the CSV-to-JSON and JSON-to-CSV cases; Markdown pairwise cases use the canonical single-line normalization applied to browser title/browser/profile text. Normalize only `metadata.source_format` in assertions because conversions intentionally update it.

- [ ] **Step 2: Run the complete unit suite before documentation changes**

Run: `npm test`

Expected: PASS with all new and existing tests.

- [ ] **Step 3: Update README with exact behavior**

Document:

- The **Export format** and **Format conversion behavior** dropdowns and defaults.
- `.md`, `.csv`, and `.json` filename examples for flat and tiered layouts.
- JSON schema version 1 and the fixed CSV header.
- Optional sync metadata for legacy records.
- The conversion command, keep/replace behavior, recoverable trash, and Markdown user-content safeguard.
- `data.json` cursor preservation after format changes and the need to run conversion for historical output in the new format.
- Vault-wide cross-format sync-ID indexing and the limitation of ID-less history after device-state invalidation.
- CSV spreadsheet-safety encoding and local-only privacy behavior.

- [ ] **Step 4: Run lint and fix only findings caused by this feature**

Run: `npm run lint`

Expected: PASS with no warnings or errors.

- [ ] **Step 5: Run all unit, build, and staged-release checks**

Run: `npm test`

Expected: PASS.

Run: `npm run build`

Expected: PASS and produce `build/main.js`, `build/manifest.json`, and `build/styles.css`.

Run: `npm run test:release`

Expected: PASS against the fresh build output.

- [ ] **Step 6: Inspect the final diff for privacy, generated artifacts, and scope**

Run: `git status --short`

Expected: only source, tests, README, and intentionally generated ignored build output; no browser-history fixture copied from the user's vault and no raw URLs/titles from attached files.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 7: Commit documentation and final integration coverage**

```bash
git add README.md tests/output/roundtrip.test.ts tests/release.test.ts
git commit -m "docs: document multi-format history exports"
```

If `tests/release.test.ts` did not require a change, omit it from `git add` rather than creating an unrelated edit.
