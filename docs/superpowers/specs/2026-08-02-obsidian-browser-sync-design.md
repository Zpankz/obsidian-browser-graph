# Obsidian Browser Sync Design

## Summary

`obsidian-browser-sync` is a desktop-only Obsidian community plugin that imports local browser visit history into Markdown notes. Imports run only when the user invokes an Obsidian command. The plugin supports macOS, Windows, and Linux, provides first-class adapters for Safari, Firefox, and Chrome, and discovers compatible Chromium-family browsers such as Edge, Brave, Chromium, and Vivaldi.

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
- `sql-wasm.wasm`

The production `sql.js` WebAssembly binary is approximately 660 kB uncompressed. It lives only in `.obsidian/plugins/obsidian-browser-sync/` and is never copied into the configured history output folder. Generated history remains ordinary Markdown.

## Architecture

### Plugin orchestration

The plugin entry point loads settings and per-profile sync state, registers one manual command, registers the settings tab, and coordinates an import run. It prevents overlapping runs in the same Obsidian window and reports completion counts through Obsidian notices.

### Browser discovery

Discovery adapters receive an explicit platform and home-directory abstraction so their behavior is unit-testable. Each adapter returns detected browser installations and profiles with stable source keys and database paths.

- Safari: discover the macOS Safari history database. Safari is unavailable on Windows and Linux.
- Firefox: discover profiles from the platform-specific Firefox data root and profile configuration where available.
- Chrome: discover all Chrome profiles on each supported platform.
- Chromium-compatible browsers: discover known data roots for Edge, Brave, Chromium, and Vivaldi, then use the Chrome reader when their database schema is compatible.

Each discovered profile has a stable key derived from browser identifier and canonical profile location. Display names are used only in Markdown and settings UI, not for identity.

### Snapshot and SQLite access

Browser databases are opened read-only through bundled `sql.js`. Before querying, the plugin copies the database into an operating-system temporary directory so it does not contend with the browser's lock. Temporary copies are removed in a `finally` cleanup path.

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

Timestamp conversion is explicit per schema: Chromium's epoch, Firefox's Unix-microsecond values, and Safari's Core Data reference date. Readers preserve separate visit rows and do not collapse repeated URLs.

### Stable visit identity

Every normalized visit receives a deterministic ID generated from its browser ID, stable profile ID, source visit ID, timestamp, and URL. The ID is encoded in a hidden Markdown comment following the visible entry. Source IDs alone are not assumed globally unique.

```markdown
- 14:32:08 [Page title](https://example.com) — Chrome · Personal
  <!-- obsidian-browser-sync:chrome:stable-id -->
```

Titles and URLs are escaped so a browser record cannot break the Markdown structure or inject an Obsidian command. Empty titles fall back to the URL.

## Import Data Flow

When the user invokes the import command, the plugin performs these steps:

1. Reject a second invocation if an import is already running.
2. Validate the vault-relative output folder and create it if necessary.
3. Discover all profiles for enabled browser sources.
4. For each profile, create a temporary database snapshot and query visits after that profile's cursor minus the overlap window.
5. Normalize visits, create stable IDs, and sort chronologically with stable IDs as the tie-breaker.
6. Group visits by configured note period and calculate each destination path.
7. Read each existing destination note and collect its hidden imported IDs.
8. Append only entries whose stable IDs are absent.
9. After every note write for a profile succeeds, persist that profile's new high-water timestamp and source visit tie-breaker.
10. Remove temporary snapshots and show imported, skipped, and failed counts.

Profiles may be processed independently, but writes to the same note are serialized so two profiles cannot overwrite each other's additions.

## Idempotency and Recovery

Idempotency uses two layers:

1. A high-water cursor per stable browser profile limits later database queries. A conservative overlap ensures timestamp ties, late database checkpoints, and partially observed history are queried again.
2. Hidden stable IDs in Markdown are the final deduplication authority. They make a retry safe even when a prior run wrote notes but failed before saving its cursor.

A profile cursor advances only after all note writes planned for that profile succeed. Failure leaves that cursor unchanged. On the next run, overlapping visits are re-queried and suppressed by their existing Markdown IDs.

If plugin state is deleted, copied from another machine, or excluded from Git, the plugin queries history from the beginning but reconstructs deduplication from destination note markers. This can make the first recovery run slower but does not duplicate existing marked entries.

Cursor state is machine-specific and stored in the plugin's `data.json` alongside settings. The format uses a version number so later releases can migrate it. Missing and legacy fields receive explicit defaults.

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

Safari, Firefox, and Chrome are enabled by default when supported by the current operating system. Compatible Chromium browsers are enabled when detected. Settings changes apply to the next manual run.

The plugin registers one command named `Import browser history`. There is no ribbon action, startup import, timer, or background watcher in the initial release.

## Privacy and Security

- All processing remains local; the plugin performs no network requests.
- Browser databases are read only and never modified.
- Temporary snapshots use the operating system's temporary directory and are removed after each profile attempt.
- Output paths must be normalized vault-relative paths. Absolute paths, parent traversal, and `.obsidian` destinations are rejected.
- Browser-derived text is treated as untrusted and escaped before insertion into Markdown.
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
- First-class browser and compatible Chromium discovery across injected macOS, Windows, and Linux paths.
- Discovery and import of all profiles.
- Preservation of repeated visits to the same URL.
- Deterministic stable visit IDs.
- First import, repeated import, overlapping cursor query, interrupted write retry, and deleted-state recovery.
- Cursor advancement only after all planned writes for a profile succeed.
- Day, ISO-week, month, and year grouping.
- Flat paths and every tiered path shape, including ISO weeks that cross month and year boundaries.
- Stable chronological ordering and timestamp ties.
- Markdown escaping, empty titles, and unsafe output-folder rejection.
- Browser-not-found, permission-denied, corrupt database, changed-schema, and partial-run failures.
- Settings defaults, serialization, and migration.
- Prevention of overlapping command runs.

Build verification confirms that the release contains the manifest, bundled JavaScript, stylesheet, and the production WASM asset and that the manifest declares desktop-only support.

## Acceptance Criteria

- A user can install and enable the plugin on Obsidian desktop for macOS, Windows, or Linux.
- The settings page exposes browser toggles, output folder, flat/tiered layout, and day/week/month/year period.
- Safari, Firefox, and Chrome are first-class sources; detected compatible Chromium browsers can also import through the Chromium adapter.
- All detected profiles of enabled browsers are imported.
- Each persisted browser visit becomes one Markdown entry, including repeated URLs.
- The default output is a tiered monthly note such as `Browser History/2026/2026-08.md`.
- Running the command twice without new history adds no duplicate entries.
- Newer visits extend only the appropriate existing or new notes.
- A failed note write does not advance the affected profile cursor, and a retry does not duplicate already-written marked entries.
- Browser databases are not modified, no network requests occur, and temporary snapshots are cleaned up.
- Automated tests and the production build pass on the supported development toolchain.
