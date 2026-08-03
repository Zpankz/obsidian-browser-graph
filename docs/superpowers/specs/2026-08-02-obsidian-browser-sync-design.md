# Obsidian Browser Sync Design

## Summary

Browser Sync is a desktop-only Obsidian Community plugin with stable plugin ID `browser-history-sync` (the repository/package name remains `obsidian-browser-sync`). It imports local browser visit history into Markdown notes only when the user invokes an Obsidian command. The plugin supports macOS, Windows, and Linux, provides first-class adapters for Safari, Firefox, and Chrome, and discovers compatible Chromium-family browsers such as Edge, Brave, Chromium, and Vivaldi.

Every detected profile of an enabled browser is imported. Each individual visit is retained, including repeated visits to the same URL. Repeated command runs are idempotent: after the initial import, only newer and not-yet-written visits extend the output notes.

## Goals

- Import local browser visits into human-readable Markdown without network access.
- Support Safari, Firefox, and Chrome as first-class sources and compatible Chromium browsers where their history schemas match Chrome's.
- Support every detected browser profile and identify the browser and profile on each entry.
- Let users enable or disable each browser source.
- Let users choose a vault-relative output folder, flat or tiered layout, and daily, ISO-weekly, monthly, or yearly notes.
- Preserve every visit while making retries, interrupted imports, and deleted cursor state safe.
- Give actionable, isolated errors without preventing healthy browser profiles from importing.

## Non-goals

- Automatic or scheduled imports.
- Browser-history modification, deletion, or synchronization back to browsers.
- Mobile support.
- Network synchronization or cloud services.
- Importing bookmarks, downloads, open tabs, cookies, or private/incognito sessions that browsers do not persist.
- Guaranteeing that visits still present only in a browser's uncheckpointed write-ahead log appear immediately; such visits can appear on a later run.

## Platform and Packaging

The plugin targets the Obsidian desktop application on macOS, Windows, and Linux. It uses TypeScript, the Obsidian plugin API, Node-compatible filesystem APIs exposed by Obsidian desktop, esbuild, Vitest, and `sql.js`.

The release contains:

- `main.js`
- `manifest.json`
- `styles.css`

These are the complete Community installation artifacts under `.obsidian/plugins/browser-history-sync/`. The production `sql.js` WebAssembly bytes are embedded in generated `main.js` at build time, so installation has no separate WASM sidecar. The root manifest declares author `git-akihakune`, the MIT-licensed package metadata, Obsidian 1.13.0 minimum, and desktop-only support. Generated history remains ordinary Markdown.

## Architecture

### Plugin orchestration

The plugin entry point loads settings and per-profile sync state, registers one manual command, registers the settings tab, and coordinates an import run. It prevents overlapping runs in the same Obsidian window and reports completion counts through Obsidian notices.

### Browser discovery

Discovery adapters receive an explicit platform and home-directory abstraction so their behavior is unit-testable. Each adapter returns detected browser installations and profiles with stable source keys and database paths.

- Safari: discover the macOS Safari history database. Safari is unavailable on Windows and Linux.
- Firefox: discover profiles from the platform-specific Firefox data root and profile configuration where available.
- Chrome: discover all Chrome profiles on each supported platform.
- Chromium-compatible browsers: discover known data roots for Edge, Brave, Chromium, and Vivaldi, then use the Chrome reader when their database schema is compatible.

Each discovered profile has a local cursor key derived from browser identifier and canonical profile location. It also carries a portable profile ID, such as the Chromium profile directory or Firefox profile-directory basename, for path-independent Markdown visit identity. Display names are used only in Markdown and settings UI.

### Snapshot and SQLite access

Browser databases are opened read-only through bundled `sql.js`, initialized directly from the WASM bytes embedded in `main.js`. Before querying, the plugin copies the database into an operating-system temporary directory so it does not contend with the browser's lock. Temporary copies are removed after each operation. If both the database operation and cleanup fail, one combined error retains the operation failure as primary and preserves the cleanup failure; cleanup-only failures explicitly warn that a sensitive snapshot may remain.

Because `sql.js` loads a database snapshot into memory and does not consume a separate live write-ahead log, a very recent visit that has not reached the main database may be absent from the current run. The saved cursor includes a conservative overlap window, so a later run can pick it up without duplication.

### Browser readers

Each browser reader owns schema detection, timestamp conversion, and query construction. Readers emit the shared `NormalizedVisit` contract:

```ts
interface NormalizedVisit {
  sourceKey: string;
  sourceVisitId: string;
  browserId: string;
  browserName: string;
  profileId: string;
  profileName: string;
  visitedAt: Date;
  title: string;
  url: string;
}
```

Timestamp conversion is explicit per schema: Chromium's epoch, Firefox's Unix-microsecond values, and Safari's Core Data reference date. Each reader rejects non-finite, unrepresentable, negative, and implausibly future timestamps before normalized visits escape its profile boundary. Readers preserve separate visit rows and do not collapse repeated URLs. Cursor queries use both the timestamp overlap and a monotonic source-visit-ID predicate, with deterministic bound parameters and native timestamp/ID ordering, so a corrected future clock cannot permanently hide later higher-ID visits.

### Stable visit identity

Every normalized visit receives a deterministic ID generated from portable browser ID, portable profile ID, source visit ID, timestamp, and URL fields. It never includes the local canonical profile path, cursor source key, device token, or device hash. The ID is encoded in a hidden Markdown comment following the visible entry. Source IDs alone are not assumed globally unique.

```markdown
- 14:32:08 [Page title](https://example.com) — Chrome · Personal
  <!-- obsidian-browser-sync:chrome:stable-id -->
```

Titles, browser names, and profile labels are escaped for Markdown and raw HTML. Only `http:` and `https:` URLs are clickable; `obsidian:`, `javascript:`, `file:`, other schemes, and malformed URLs are inert text while the visit and hidden ID remain. Empty titles fall back to the URL. Marker parsing accepts only exact standalone managed-marker lines, preventing marker-shaped label text from becoming imported state. The historical `obsidian-browser-sync` marker namespace remains unchanged for compatibility with existing notes.

## Import Data Flow

When the user invokes the import command, the plugin performs these steps:

1. Reject a second invocation if an import is already running.
2. Snapshot all settings immutably, validate the vault-relative output folder, and create it if necessary.
3. Discover all profiles for enabled browser sources.
4. Index exact managed markers across every Markdown file in the vault, excluding non-Markdown files.
5. For each profile, create a temporary database snapshot and query visits after that profile's cursor minus the overlap window or with a higher source visit ID.
6. Validate and normalize visits, create stable IDs, and sort chronologically with stable IDs as the tie-breaker.
7. Group visits using the command-time settings snapshot and calculate each destination path.
8. Append only entries whose stable IDs are absent from the vault-wide marker index.
9. After every note write for a profile succeeds, persist independently monotonic timestamp and source-ID high-water fields.
10. Remove temporary snapshots and show imported, skipped, and failed counts.

Profiles may be processed independently, but writes to the same note are serialized so two profiles cannot overwrite each other's additions.

## Idempotency and Recovery

Idempotency uses two layers:

1. A high-water cursor per local browser profile limits later database queries. A conservative timestamp overlap plus an independent source-ID high-water predicate covers timestamp ties, clock correction, late database checkpoints, and partially observed history.
2. Vault-wide hidden stable IDs in Markdown are the final deduplication authority. They make a retry safe even when a prior run wrote notes but failed before saving its cursor, and remain authoritative after output folder, layout, period, timezone, or local profile-path changes.

A profile cursor advances only after all note writes planned for that profile succeed. Failure leaves that cursor unchanged. On the next run, overlapping visits are re-queried and suppressed by their existing Markdown IDs.

If plugin state is deleted, copied from another device, or excluded from Git, the plugin queries history from the beginning but reconstructs deduplication from managed markers across the vault. This can make the first recovery run slower but does not duplicate existing marked entries or rewrite user content.

Cursor state is device-specific and stored in version 3 of the plugin's `data.json` alongside settings. Production generates a random per-device token and persists the raw token outside the synced vault in Obsidian/Electron local storage under a plugin-specific key. Only its SHA-256 hash is stored in `data.json`. A missing/cleared local token, legacy version, invalid persisted cursor timestamp, or hash mismatch invalidates cursors and safely triggers a rescan. Devices with identical platform/hostname/home values still receive distinct identities.

## Output Model

### Note periods

The configured period controls how visits are grouped:

- Day: local calendar date.
- Week: ISO-8601 week, beginning Monday and using the ISO week-year.
- Month: local calendar month.
- Year: local calendar year.

Visit timestamps and filenames use the local timezone reported by the Obsidian desktop environment at import time.

### Flat paths

Flat mode places every note directly inside the selected output folder:

- `History/2026-08-02.md`
- `History/2026-W32.md`
- `History/2026-08.md`
- `History/2026.md`

### Tiered paths

Tiered mode creates temporal folders down to the selected period:

- Year: `History/2026.md`
- Month: `History/2026/2026-08.md`
- Week: `History/2026/2026-08/2026-W32.md`
- Day: `History/2026/2026-08/2026-W32/2026-08-03.md`

For week and day layouts, year and month folders are determined by the ISO week's Monday. This keeps the whole week in one location when it crosses a month or calendar-year boundary. Day notes still use their actual local date as the filename.

The default output folder is `Browser History`, the default layout is tiered, and the default period is month. Therefore, a visit in August 2026 defaults to `Browser History/2026/2026-08.md`.

### Note content

New notes receive minimal frontmatter identifying the period and plugin, followed by a `# Browser history` heading. Existing notes are not reformatted. New entries are appended chronologically within each run. The plugin never rewrites or deletes user-authored content.

## Settings Experience

The settings tab provides:

- Separate toggles for Safari, Firefox, and Chrome.
- Separate toggles for detected compatible Chromium browsers, including Edge, Brave, Chromium, and Vivaldi.
- A vault-relative output folder input with validation and folder suggestions.
- A layout selector: flat or tiered.
- A note-period selector: day, ISO week, month, or year.
- A read-only list of detected browser profiles and permission status.

Safari, Firefox, and Chrome are enabled by default when supported by the current operating system. Compatible Chromium browsers are enabled when detected. The output input uses an Obsidian-compatible folder suggestion component, filtered through the same portable path validator as persistence and vault writes. Each command snapshots browser toggles, output folder, layout, and period before any asynchronous discovery or folder preparation; settings changes during an import apply only to the next manual run.

The plugin registers one command named `Import browser history`. There is no ribbon action, startup import, timer, or background watcher in the initial release.

## Privacy and Security

- All processing remains local; the plugin performs no network requests.
- Browser databases are read only and never modified.
- Temporary snapshots use the operating system's temporary directory and are removed after each profile attempt.
- Output paths must be normalized vault-relative paths. On every host the settings and vault-adapter boundaries reject absolute and drive-relative paths, parent traversal, ASCII control/Windows reserved characters, trailing dots/spaces, reserved device components (including names with extensions), and `.obsidian` aliases.
- Browser-derived titles, browser/profile labels, and inert URL text are treated as untrusted and escaped before insertion into Markdown. Only HTTP(S) URLs are linked.
- Logs and notices avoid printing full visited URLs unless needed for a user-visible source error.
- On macOS, Safari history access may require Full Disk Access for Obsidian. Permission-denied errors explain the required user action without attempting to change system permissions.

## Error Handling

A failure in one browser or profile does not cancel healthy sources. Each profile produces one of three outcomes: imported, skipped, or failed.

Actionable errors cover:

- Browser or profile not found.
- Unsupported or changed database schema.
- Database lock, copy failure, corruption, or insufficient memory.
- macOS privacy denial for Safari.
- Invalid or unwritable output folder.
- Note read or write failure.
- Temporary-file cleanup failure.

Missing browsers are skipped, not treated as run failures. Cleanup failures are reported without hiding the primary import outcome. A completion notice summarizes new visits, already-present visits, skipped profiles, and failed profiles. Detailed diagnostic information is written to the developer console without exposing more browsing data than necessary.

## Testing Strategy

Vitest unit and integration tests use small, synthetic fixture databases and an in-memory vault adapter. Tests do not inspect the developer's real browser history.

Coverage includes:

- Chromium, Firefox, and Safari schema mapping and timestamp conversion.
- Corrupt timestamp filtering and timestamp-or-higher-ID recovery in all three reader schemas.
- First-class browser and compatible Chromium discovery across injected macOS, Windows, and Linux paths.
- Discovery and import of all profiles.
- Preservation of repeated visits to the same URL.
- Deterministic stable visit IDs.
- First import, repeated import, overlapping cursor query, future-clock correction, interrupted write retry, and vault-wide deleted-state recovery across settings/path/timezone changes.
- Cursor advancement only after all planned writes for a profile succeed.
- Day, ISO-week, month, and year grouping.
- Flat paths and every tiered path shape, including ISO weeks that cross month and year boundaries.
- Stable chronological ordering and timestamp ties.
- Raw-HTML/active-URI/marker-injection escaping, empty titles, and cross-host unsafe output-folder rejection at both validation boundaries.
- Browser-not-found, permission-denied, corrupt database, changed-schema, and partial-run failures.
- Version-3 settings defaults, durable device identity, cursor rejection, serialization, and migration.
- Immutable command-time settings and project-owned folder suggestion behavior.
- Primary-plus-cleanup and cleanup-only snapshot failures.
- Prevention of overlapping command runs.

Build verification stages only `main.js`, `manifest.json`, and `styles.css`, loads the bundle without source dependencies or a WASM sidecar, opens a synthetic real SQLite database using embedded WASM, and confirms the Community manifest metadata and desktop-only support.

## Acceptance Criteria

- A user can install and enable the plugin on Obsidian desktop for macOS, Windows, or Linux.
- The settings page exposes browser toggles, output folder, flat/tiered layout, and day/week/month/year period.
- Safari, Firefox, and Chrome are first-class sources; detected compatible Chromium browsers can also import through the Chromium adapter.
- All detected profiles of enabled browsers are imported.
- Each persisted browser visit becomes one Markdown entry, including repeated URLs.
- The default output is a tiered monthly note such as `Browser History/2026/2026-08.md`.
- Running the command twice without new history adds no duplicate entries.
- Moving an already-marked visit across device paths or changing output folder, layout, period, or timezone adds no duplicate entry.
- Newer visits extend only the appropriate existing or new notes.
- A failed note write does not advance the affected profile cursor, and a retry does not duplicate already-written marked entries.
- Browser databases are not modified, no network requests occur, and temporary snapshots are cleaned up or their cleanup failures are preserved and reported.
- Community installation requires exactly `main.js`, `manifest.json`, and optional `styles.css`; SQL WebAssembly is embedded in `main.js`.
- Automated tests and the production build pass on the supported development toolchain.
