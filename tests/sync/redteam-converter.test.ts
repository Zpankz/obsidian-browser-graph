import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { convertExistingExports } from '../../src/sync/converter';
import { CSV_HEADER, serializeCsvDocument } from '../../src/output/csv';
import { parseJsonDocument, serializeJsonDocument } from '../../src/output/json';
import {
  newNote,
  renderVisit,
  serializeMarkdownDocument,
} from '../../src/output/markdown';
import { historyDocument, historyRecord } from '../helpers/history-documents';
import { fakeVault, fakeVaultWithRenderedVisit } from '../helpers/fake-vault';
import { visit } from '../helpers/visits';

it('redteam: refuses to overwrite an unmanaged file sitting at the destination path', async () => {
  const source = 'Browser History/source.md';
  const target = 'Browser History/2026/2026-08.json';
  const unmanaged = 'Private destination: do not touch';
  const vault = fakeVault({
    files: {
      [source]: serializeMarkdownDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_markdown',
        },
      })),
      [target]: unmanaged,
    },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });

  expect(summary.failed).toEqual([
    { path: target, category: 'unmanaged-destination' },
  ]);
  expect(vault.readText(target)).toBe(unmanaged);
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('redteam: refuses to overwrite a destination carrying user content', async () => {
  const source = 'Browser History/source.json';
  const target = 'Browser History/2026/2026-08.md';
  const targetContent = `${newNote('2026-08', [])}Private target note\n`;
  const vault = fakeVault({
    files: {
      [source]: serializeJsonDocument(historyDocument()),
      [target]: targetContent,
    },
  });

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'markdown',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary.failed).toEqual([
    { path: target, category: 'user-content-destination' },
  ]);
  expect(vault.readText(target)).toBe(targetContent);
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('redteam: reports source-changed when a JSON source is edited between scan and trash', async () => {
  const source = 'Browser History/source.json';
  const target = 'Browser History/2026/2026-08.md';
  const vault = fakeVault({
    files: { [source]: serializeJsonDocument(historyDocument()) },
  });
  const read = vault.read.bind(vault);
  let sabotaged = false;
  vault.read = async (path) => {
    const content = await read(path);
    if (path === target && !sabotaged) {
      sabotaged = true;
      await vault.write(source, serializeJsonDocument(historyDocument({
        records: [
          historyRecord(),
          historyRecord({
            timestamp: '2026-08-03T15:35:56+03:00',
            sync: {
              namespace: 'obsidian-browser-sync',
              browser: 'chrome',
              id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            },
          }),
        ],
      })));
    }
    return content;
  };

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'markdown',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(sabotaged).toBe(true);
  expect(summary.converted).toBe(1);
  expect(summary.failed).toEqual([
    { path: source, category: 'source-changed' },
  ]);
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.hasFile(target)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('redteam: reports concurrency after three raced destination writes', async () => {
  const source = 'Browser History/source.md';
  const target = 'Browser History/2026/2026-08.json';
  const churn = ['444444444444444444444444', '555555555555555555555555', '666666666666666666666666']
    .map((id, index) => serializeJsonDocument(historyDocument({
      records: [historyRecord({
        timestamp: `2026-08-03T15:3${index + 5}:56+03:00`,
        sync: { namespace: 'obsidian-browser-sync', browser: 'chrome', id },
      })],
    })));
  const vault = fakeVault({
    files: {
      [source]: serializeMarkdownDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_markdown',
        },
      })),
    },
    conditionalWriteInterference: { path: target, contents: churn },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });

  expect(summary.failed).toEqual([{ path: target, category: 'concurrency' }]);
  expect(summary.converted).toBe(0);
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('redteam: reports invalid JSON and CSV sources without touching anything else', async () => {
  const badJson = 'Browser History/bad.json';
  const badCsv = 'Browser History/bad.csv';
  const validCsv = serializeCsvDocument(historyDocument({
    metadata: {
      ...historyDocument().metadata,
      source_format: 'obsidian_browser_sync_csv',
    },
  }));
  const vault = fakeVault({
    files: {
      [badJson]: '{"type":"browser_history","metadata":{"browser_sync":true}',
      [badCsv]: `${validCsv}garbage,line\n`,
    },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'markdown' },
  }, { vault });

  expect(summary.failed).toEqual([
    { path: badCsv, category: 'invalid-source' },
    { path: badJson, category: 'invalid-source' },
  ]);
  expect(vault.hasFile(badJson)).toBe(true);
  expect(vault.hasFile(badCsv)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('redteam: fails a three-period routing collision but converts an independent period', async () => {
  const augustJson = 'Browser History/august.json';
  const augustCsv = 'Browser History/august.csv';
  const occupant = 'Browser History/2026/2026-08.json';
  const octoberJson = 'Browser History/october.json';
  const occupantContent = serializeJsonDocument(historyDocument({
    metadata: { ...historyDocument().metadata, period: '2026-09' },
    records: [historyRecord({
      timestamp: '2026-09-03T15:34:56+03:00',
      sync: {
        namespace: 'obsidian-browser-sync',
        browser: 'chrome',
        id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      },
    })],
  }));
  const vault = fakeVault({
    files: {
      [augustJson]: serializeJsonDocument(historyDocument()),
      [augustCsv]: serializeCsvDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_csv',
        },
      })),
      [occupant]: occupantContent,
      [octoberJson]: serializeJsonDocument(historyDocument({
        metadata: { ...historyDocument().metadata, period: '2026-10' },
        records: [historyRecord({
          timestamp: '2026-10-03T15:34:56+03:00',
          sync: {
            namespace: 'obsidian-browser-sync',
            browser: 'chrome',
            id: 'cccccccccccccccccccccccc',
          },
        })],
      })),
    },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });

  expect(summary.failed).toEqual([
    { path: occupant, category: 'routing-collision' },
  ]);
  expect(vault.readText(occupant)).toBe(occupantContent);
  expect(vault.hasFile(augustJson)).toBe(true);
  expect(vault.hasFile(augustCsv)).toBe(true);
  expect(vault.hasFile(octoberJson)).toBe(true);
  expect(vault.hasFile('Browser History/2026/2026-10.json')).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('redteam: reports a zero-op summary for an empty vault', async () => {
  const summary = await convertExistingExports({
    settings: DEFAULT_SETTINGS,
  }, { vault: fakeVault() });

  expect(summary).toEqual({
    converted: 0,
    alreadyCurrent: 0,
    retained: 0,
    skippedReplacement: 0,
    failed: [],
  });
});

it.each(['keep', 'replace'] as const)(
  'redteam: %s mode converts a clean Markdown source to JSON',
  async (formatConversionBehavior) => {
    const source = 'Browser History/2026/2026-08.md';
    const target = 'Browser History/2026/2026-08.json';
    const vault = fakeVaultWithRenderedVisit(visit());

    const summary = await convertExistingExports({
      settings: {
        ...DEFAULT_SETTINGS,
        outputFormat: 'json',
        formatConversionBehavior,
      },
    }, { vault });

    expect(summary.failed).toEqual([]);
    expect(summary.converted).toBe(1);
    expect(vault.hasFile(target)).toBe(true);
    expect(vault.hasFile(source)).toBe(formatConversionBehavior === 'keep');
    expect(vault.trashedPaths()).toEqual(
      formatConversionBehavior === 'keep' ? [] : [source],
    );
    if (formatConversionBehavior === 'keep') {
      expect(summary.retained).toBe(1);
    }
  },
);

it('redteam: rejects header-only CSV files whose filename period disagrees with routing', async () => {
  const bare = 'Browser History/source.csv';
  const misrouted = 'Browser History/archive/2026-08.csv';
  const headerOnly = `${CSV_HEADER.join(',')}\r\n`;
  const vault = fakeVault({ files: { [bare]: headerOnly, [misrouted]: headerOnly } });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });

  expect(summary.failed).toEqual([
    { path: misrouted, category: 'invalid-source' },
    { path: bare, category: 'invalid-source' },
  ]);
  expect(vault.hasFile(bare)).toBe(true);
  expect(vault.hasFile(misrouted)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('redteam: converts but retains Markdown carrying unrecognized user content', async () => {
  const source = 'Browser History/2026/2026-08.md';
  const target = 'Browser History/2026/2026-08.csv';
  const managed = newNote('2026-08', [renderVisit(visit()).trimEnd()]);
  const vault = fakeVault({
    files: { [source]: `${managed}\nPrivate note\n` },
  });

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'csv',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary.failed).toEqual([]);
  expect(summary.converted).toBe(1);
  expect(summary.skippedReplacement).toBe(1);
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.hasFile(target)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('redteam: merges 100 sources in under five seconds', async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 100; index += 1) {
    const id = index.toString(16).padStart(24, '0');
    files[`Browser History/src-${String(index).padStart(3, '0')}.json`] =
      serializeJsonDocument(historyDocument({
        records: [historyRecord({
          timestamp: `2026-08-03T15:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}+03:00`,
          sync: { namespace: 'obsidian-browser-sync', browser: 'chrome', id },
        })],
      }));
  }
  const vault = fakeVault({ files });

  const startedAt = Date.now();
  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });
  const elapsedMs = Date.now() - startedAt;

  expect(summary.failed).toEqual([]);
  expect(summary.converted).toBe(1);
  expect(
    parseJsonDocument(vault.readText('Browser History/2026/2026-08.json'))
      .document.records,
  ).toHaveLength(100);
  expect(elapsedMs).toBeLessThan(5000);
});
