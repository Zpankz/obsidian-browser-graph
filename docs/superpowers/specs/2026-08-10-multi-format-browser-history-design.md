# Multi-format browser history export and conversion

## Summary

Obsidian Browser Sync will export browser history as Markdown, CSV, or JSON. The selected format applies to future imports, while the existing device-specific browser cursors in `data.json` remain valid and format-independent. A command will convert existing managed exports in the configured output folder to the selected format.

All formats will use one canonical browser-history document and record model. Separate codecs will parse and serialize Markdown, CSV, and JSON without duplicating import or conversion rules.

## Goals

- Add an **Export format** setting with Markdown, CSV, and JSON options.
- Keep Markdown as the default for existing and new installations.
- Add a **Format conversion behavior** setting with **Keep original files** and **Replace original files** options.
- Keep original files by default.
- Add a **Convert existing browser history exports** command.
- Preserve `data.json` cursors when the export format changes.
- Preserve chronological order, repeated visits, stable sync IDs, timestamps, titles, URLs, browser names, and profile names across formats.
- Accept legacy structured records that do not have sync metadata.
- Keep conversions safe and idempotent, including when a command is run repeatedly.

## Non-goals

- Automatically converting files as soon as the export format setting changes.
- Keeping a hidden canonical copy of all browser history.
- Converting arbitrary Markdown, CSV, or JSON files that are not recognized Browser Sync exports.
- Representing arbitrary user-authored Markdown content in CSV or JSON.
- Fabricating stable IDs for legacy records that never had them.

## Settings

`PluginSettings` gains two fields:

- `outputFormat: 'markdown' | 'csv' | 'json'`, defaulting to `markdown`.
- `formatConversionBehavior: 'keep' | 'replace'`, defaulting to `keep`.

The settings tab presents both as dropdowns. The file-name-template description must no longer claim that `.md` is always added; it explains that the selected format's extension is added automatically.

Changing `outputFormat` affects subsequent imports and the conversion command. It must not reset, rewind, or otherwise modify profile cursors. Changing `formatConversionBehavior` has no immediate filesystem effect and applies only when the conversion command runs.

The persisted-data version remains version 3. Migration adds safe defaults for the two settings while retaining valid same-device cursors.

## Canonical model

The format-neutral model is a browser-history document with:

- `schema_version`
- `type: 'browser_history'`
- metadata containing the Browser Sync marker, period, heading, and source format
- an ordered collection of browser-history records

Each canonical record contains:

- full local ISO timestamp with UTC offset
- title
- URL
- browser name
- profile name
- representation
- optional original title
- optional sync metadata containing namespace, browser ID, and stable visit ID

The canonical model holds semantic values. Markdown escaping and CSV safety encoding never leak into canonical titles, URLs, browser names, or profile names.

Stable sync metadata follows the current structured export:

```json
{
  "namespace": "obsidian-browser-sync",
  "browser": "safari",
  "id": "83363a8d78449fd2e213bf60"
}
```

Legacy records without `sync` remain valid and convertible. The plugin does not invent IDs for them.

## Format codecs

Each codec has one clear responsibility: identify managed files of its format, parse them into the canonical model, serialize canonical documents, and expose stable IDs for indexing. Import and conversion logic select codecs through a registry rather than branching into format-specific business logic.

### JSON

JSON follows schema version 1 of the attached examples:

```json
{
  "schema_version": 1,
  "type": "browser_history",
  "metadata": {
    "browser_sync": true,
    "period": "2026-08",
    "heading": "Browser history",
    "source_format": "obsidian_browser_sync_markdown"
  },
  "records": []
}
```

Records use `timestamp`, `title`, `url`, `browser`, `profile`, `representation`, optional `original_title`, and optional nested `sync`. The parser validates document identity and schema version before treating a JSON file as managed.

`metadata.source_format` describes the immediate source used to produce the document. Direct imports use `obsidian_browser_sync_browser_database`; a conversion from one codec uses `obsidian_browser_sync_markdown`, `obsidian_browser_sync_csv`, or `obsidian_browser_sync_json`; and a merge involving multiple source kinds uses `obsidian_browser_sync_mixed`. Adding direct browser visits to a document produced from another source also changes the value to `obsidian_browser_sync_mixed`.

### CSV

CSV is UTF-8 and uses a fixed header:

```text
schema_version,type,metadata_browser_sync,metadata_period,metadata_heading,metadata_source_format,timestamp,title,url,browser,profile,representation,original_title,sync_namespace,sync_browser,sync_id
```

Document metadata repeats on every record row so the file remains self-contained. Nested JSON sync fields map to `sync_namespace`, `sync_browser`, and `sync_id`. Optional values use empty cells.

The codec follows RFC 4180 field quoting and line rules. It also applies reversible spreadsheet-formula safety encoding to record text cells. A value beginning with an apostrophe gets one additional leading apostrophe. A value beginning with `=`, `+`, `-`, `@`, tab, carriage return, or line feed gets one leading apostrophe. Decoding removes one apostrophe from a doubled-apostrophe prefix or from an apostrophe followed by one of those formula-trigger characters. All other apostrophes remain untouched. This mapping is bijective, including for values that already begin with apostrophes, and prevents an exported record cell from beginning with a spreadsheet formula trigger.

A header-only CSV is a valid empty managed document when its period can be established from the managed destination context. CSV files with missing, duplicated, or unsupported required columns are rejected rather than guessed.

### Markdown

Markdown keeps the existing frontmatter, heading, rendered visit layout, URL safety behavior, and hidden sync marker. The Markdown parser recognizes only the plugin's exact generated structure and returns both canonical records and whether unrecognized user-authored content is present.

Only HTTP and HTTPS destinations become Markdown links. Their canonical `representation` is `markdown_link`. Other schemes and malformed URLs remain inert text and use `inert_text`. Structured formats preserve those URLs as data.

The optional `original_title` field supports fidelity when a legacy Markdown conversion distinguishes a normalized title from its original Markdown representation. Newly imported canonical titles remain unescaped source titles.

## Paths and filenames

Period grouping, flat or tiered layout, and `{period}` expansion remain unchanged. Filename generation appends the selected codec's extension:

- `.md` for Markdown
- `.csv` for CSV
- `.json` for JSON

The configured template continues to exclude an explicit extension. Destination-path tests cover every format.

## Import flow

The importer takes an immutable settings snapshot as it does today. It converts normalized browser visits into canonical records, groups them by destination period, and delegates reading and writing to the selected codec.

Markdown may retain its append-oriented implementation. CSV and JSON require parse, merge, serialize, and safe replacement because a raw append would corrupt their document structure. Before replacing a structured destination, the plugin serializes and validates the complete result.

Managed sync IDs are indexed across Markdown, CSV, and JSON files throughout the vault during normal import. During rebuild, the index remains limited to the active output folder, preserving current rebuild semantics. This cross-format index remains the final deduplication authority for records with sync IDs.

Profile cursors in `data.json` remain the primary incremental-read mechanism and are independent of output format. A format change never triggers a browser rescan. If a user wants historical records in the newly selected format, they run the conversion command.

Legacy ID-less records rely on the existing cursor for ordinary incremental imports. If device state is deliberately invalidated and browser history is rebuilt, they cannot provide authoritative cross-format deduplication; this limitation is reported in documentation rather than hidden by fabricated IDs.

## Conversion flow

The **Convert existing browser history exports** command:

1. Takes an immutable snapshot of the settings.
2. Recursively scans the configured output folder for supported managed `.md`, `.csv`, and `.json` files.
3. Parses recognized documents with their codecs and groups them by period and configured destination.
4. Merges records into the selected target format in chronological order.
5. Writes and validates each destination.
6. Applies keep or replace behavior only after the destination succeeds.
7. Reports a summary.

Files that already use the selected format participate as existing destinations and are not needlessly recreated when their content is current.

Modern records reconcile by stable sync ID. Conflicting semantic data under the same sync ID is an error for that destination and is not silently chosen. Legacy records reconcile through an occurrence-aware canonical fingerprint. Within one destination-period group, the converter counts each fingerprint separately in every source document and the existing target, then retains the highest count found in any one document rather than summing counts across documents. This preserves genuinely repeated identical visits within a source while preventing repeat conversions from multiplying legacy data. Because ID-less records cannot prove whether identical records in different sources are independent, this deterministic maximum-count rule is the documented limitation.

### Keep original files

This is the default. Successfully converted sources remain in place. Markdown user content outside recognized Browser Sync entries is not included in the structured destination, but keeping the source preserves that content.

### Replace original files

A source becomes eligible for removal only after its destination has been written and parsed back successfully. Eligible sources are moved through Obsidian's recoverable trash mechanism rather than permanently deleted.

If a Markdown source contains unrecognized user-authored content, its Browser Sync records may still be converted, but the source is retained and reported as skipped for replacement. A malformed source, failed destination, validation error, or conflicting record also leaves every affected source untouched.

## Concurrency and transactions

Import, rebuild, and conversion share an exclusive operation guard so they cannot race writes. A concurrent command exits with a clear notice.

For each destination, parsing, merging, serialization, and validation finish before any source removal. A failure affects only that destination group; other independent periods may continue. Cursor advancement remains transactional per successful browser profile and must not advance when its planned output write fails.

Structured destination replacement uses the safest vault-supported write sequence. Temporary files, when required, use a sibling managed temporary name, are validated before promotion, and are cleaned up after success or failure. Existing destinations and sources remain recoverable if promotion fails.

## Reporting and privacy

Conversion displays one completion notice containing counts for:

- converted files
- already-current files
- retained originals
- sources skipped for replacement
- failed files

Detailed errors are logged with paths and failure categories but never with titles, URLs, or other browser-history record contents. Import notices retain their existing behavior.

No network access is introduced. No hidden canonical history database is created. Temporary structured files receive the same privacy treatment as browser database snapshots and are removed after the operation whenever possible.

## Validation and error handling

The codecs reject:

- unsupported schema versions
- incorrect document types or Browser Sync markers
- malformed JSON or CSV
- invalid required fields
- invalid stable sync metadata
- inconsistent CSV document metadata across rows
- conflicting records that share a stable sync ID

Unrecognized files are ignored. Recognized but invalid managed files are reported as failures. No invalid source is overwritten or removed.

## Testing

Tests will cover:

- JSON compatibility with both attached schema-version-1 examples.
- JSON records with and without nested sync metadata.
- CSV quoting, Unicode, commas, quotes, line breaks, optional fields, formula safety, and nested sync mapping.
- Strict Markdown parsing, user-content detection, escaping, unsafe URLs, and hidden markers.
- Pairwise Markdown, CSV, and JSON round trips through the canonical model.
- Chronological order and repeated visits.
- Repeated identical legacy visits without IDs.
- Stable-ID conflicts.
- Vault-wide cross-format deduplication.
- Rebuild indexing limited to the active output folder.
- Format changes that preserve `data.json` cursors.
- Settings migration and both dropdown controls.
- Dynamic file extensions and all period layouts.
- Keep and replace behavior, including recoverable removal, user-authored Markdown, partial writes, invalid destinations, and reruns.
- Exclusive concurrency across import, rebuild, and conversion.
- Command registration and summary notices.
- Existing lint, unit, build, and release verification.

## Documentation

The README will explain the three formats, their schemas, the two conversion behaviors, command usage, cursor behavior after a format change, legacy ID limitations, CSV spreadsheet safety, and replacement safeguards.
