# Obsidian Browser Sync

Obsidian Browser Sync is a desktop-only Obsidian plugin that imports local browser visits into ordinary Markdown notes. It preserves every visit, including repeated visits to the same URL, and imports every detected profile for each enabled browser.

Imports run only when you choose **Import browser history** from Obsidian's command palette. The plugin has no startup import, timer, background watcher, ribbon action, or mobile support.

## Requirements and browser support

- Obsidian desktop 1.13.0 or later on macOS, Windows, or Linux.
- A locally installed, supported browser with persisted history. Private or incognito visits that the browser does not save cannot be imported.

| Browser | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Safari | First-class support | Not available | Not available |
| Firefox | First-class support | First-class support | First-class support |
| Google Chrome | First-class support | First-class support | First-class support |
| Microsoft Edge | Compatible Chromium adapter | Compatible Chromium adapter | Compatible Chromium adapter |
| Brave | Compatible Chromium adapter | Compatible Chromium adapter | Compatible Chromium adapter |
| Chromium | Compatible Chromium adapter | Compatible Chromium adapter | Compatible Chromium adapter |
| Vivaldi | Compatible Chromium adapter | Compatible Chromium adapter | Compatible Chromium adapter |

Compatible Chromium browsers are read when their local history schema matches Chrome's. Browser schema changes may require a plugin update. A missing browser is skipped, and a failure in one profile does not stop healthy profiles from importing.

## Install

### From Community Plugins

When the plugin is available in the Obsidian Community Plugins catalog, search for **Browser Sync**, install it, and enable it. The stable Community plugin ID is `browser-history-sync`.

### From a release

1. Create `<vault>/.obsidian/plugins/browser-history-sync/`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into that directory. No other runtime file is required.
3. Restart Obsidian, or reload the app without saving.
4. Open **Settings → Community plugins** and enable **Browser Sync**.

### From source

Install a current Node.js release supported by the repository's dependencies, then run:

```sh
npm ci
npm test
npm run build
npm run test:release
```

`npm test` is artifact-independent and succeeds before a build. `npm run test:release` runs only after the build and stages the exact three-file Community release in an isolated temporary directory for verification. Copy the same three release files listed above into `<vault>/.obsidian/plugins/browser-history-sync/`. Development dependencies remain in the source checkout; they are not part of the installed plugin. The production `sql.js` WebAssembly bytes are embedded in generated `main.js` at build time.

## Use

1. Open **Settings → Browser Sync** and review the browser sources, output folder, layout, and note period.
2. Open the command palette and run **Import browser history**.
3. Run the same command whenever you want to import newer visits.

The plugin discovers all profiles for every enabled browser and writes a separate entry for each visit. Two visits to the same URL remain two entries. Very recent visits still present only in a browser's uncheckpointed write-ahead log may appear on a later run.

## Settings and paths

The settings page provides:

- A toggle for Safari, Firefox, Google Chrome, Microsoft Edge, Brave, Chromium, and Vivaldi. Sources default to enabled; unavailable or undetected sources are skipped.
- A vault-relative output folder with suggestions from existing vault folders. The default is `Browser History`. Absolute and drive-relative paths, parent traversal, `.obsidian` aliases, Windows reserved names/characters, and components with trailing dots or spaces are rejected on every platform.
- A **Flat** or **Tiered** layout. The default is **Tiered**.
- A **Day**, **ISO week**, **Month**, or **Year** note period. The default is **Month**.
- A read-only list of detected profiles and their availability or permission status.

With the defaults, an August 2026 visit is written to:

```text
Browser History/2026/2026-08.md
```

Flat layouts place notes directly in the output folder:

```text
History/2026-08-03.md
History/2026-W32.md
History/2026-08.md
History/2026.md
```

Tiered layouts create time folders down to the selected period:

```text
History/2026.md
History/2026/2026-08.md
History/2026/2026-08/2026-W32.md
History/2026/2026-08/2026-W32/2026-08-03.md
```

Week grouping follows ISO 8601: weeks begin on Monday and use the ISO week-year. For tiered week and day layouts, the parent year and month come from that week's Monday so an entire week stays together across a month or year boundary. For example, Thursday 2026-01-01 belongs to ISO week `2026-W01`, whose Monday is 2025-12-29:

```text
History/2025/2025-12/2026-W01.md
History/2025/2025-12/2026-W01/2026-01-01.md
```

Dates, times, and filenames use the local timezone of the Obsidian desktop environment at import time. Every visit entry begins with a full local ISO timestamp such as `2026-08-03T09:14:32+03:00`, including the applicable UTC offset. Existing notes keep user-authored content; the plugin appends entries and never reformats or deletes that content.

## Idempotency and state

Each imported entry is followed by a hidden `obsidian-browser-sync` marker containing a deterministic, path-independent visit ID. The marker namespace is retained for compatibility even though the Community plugin ID is `browser-history-sync`. The plugin indexes managed markers across all Markdown files in the vault, so these markers remain the final deduplication authority after a change to the output folder, layout, period, timezone, or local browser-profile path. Running the command twice without new history adds nothing, and existing notes or user-authored content are never moved or rewritten.

The plugin also saves a timestamp and source-visit-ID high-water cursor for each local browser profile in version 3 of its `data.json`. Cursor state is device-specific and should not be treated as portable vault content. A random per-device token is stored outside the synced vault in Obsidian/Electron local storage; only its SHA-256 hash is written to `data.json`.

If state is deleted or omitted from Git, the local device token is cleared, or the saved hash does not match, the next import invalidates cursors and rescans from the beginning. Copying `data.json` to another device is rejected even when both devices report identical platform, hostname, home-directory, and browser paths. Existing hidden markers remain device-independent and prevent duplicate entries. Keep the markers in generated notes if you edit them.

Each import uses an immutable snapshot of the settings that were active when the command was invoked. Settings changed while an import is running apply only to the next run.

## Safari permission and retry guidance

macOS may block access to Safari history until Obsidian has Full Disk Access:

1. Quit Obsidian.
2. Open **System Settings → Privacy & Security → Full Disk Access**.
3. Add Obsidian if necessary and enable its switch.
4. Reopen Obsidian and run **Import browser history** again.

The plugin reads a temporary snapshot rather than opening the live browser database for writing. If a profile still reports a database lock, copy error, or incomplete latest history, close that browser completely and retry the command. Retrying is safe: written markers prevent duplicates, and a failed note write does not advance that profile's cursor.

## Privacy

All processing stays on the local machine. The plugin makes no network requests, opens browser databases read-only, never writes to or deletes browser data, and removes temporary database snapshots after each profile attempt. A cleanup failure is reported explicitly because a sensitive temporary snapshot may remain. The plugin writes generated Markdown under the configured vault folder, settings and a device-identity hash in its `data.json`, and the raw random device token only in local application storage outside the vault.

Browser titles, URLs, browser names, and profile labels are treated as untrusted text and escaped before insertion into Markdown. Only `http:` and `https:` destinations become links; other schemes and malformed URLs remain inert text. Corrupt, negative, unrepresentable, or implausibly future timestamps are skipped at the profile-reader boundary. Visits not persisted by a browser, such as most private or incognito activity, are unavailable to the plugin.

## Git-controlled vaults

The release has no separate WASM sidecar: the production `sql.js` WebAssembly bytes are embedded in `.obsidian/plugins/browser-history-sync/main.js`. For a Git-controlled vault, either ignore the installed plugin directory or intentionally version the three Community release files. Generated browser history is ordinary Markdown and can be reviewed, diffed, and versioned normally. Consider excluding the plugin's device-specific `data.json` while retaining the hidden markers in history notes.

## Development verification

```sh
npm run lint
npm test
npm run build
npm run test:release
```

Run the commands in that order: the default suite is intentionally independent of ignored build artifacts, while release verification requires a fresh build. Tests use synthetic database fixtures and in-memory vaults. They never inspect real browser history.
