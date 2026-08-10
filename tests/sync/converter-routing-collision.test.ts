import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { serializeJsonDocument } from '../../src/output/json';
import { historyDocument, historyRecord } from '../helpers/history-documents';
import { fakeVault } from '../helpers/fake-vault';

vi.mock('../../src/output/periods', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/output/periods')>();
  return {
    ...original,
    destinationPath: () => 'Browser History/colliding.md',
  };
});

const { convertExistingExports } = await import('../../src/sync/converter');

it('rejects a destination group when different valid periods route to one path', async () => {
  const august = historyDocument();
  const september = historyDocument({
    metadata: { ...historyDocument().metadata, period: '2026-09' },
    records: [historyRecord({
      timestamp: '2026-09-03T15:34:56+03:00',
      sync: {
        namespace: 'obsidian-browser-sync',
        browser: 'chrome',
        id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      },
    })],
  });
  const augustPath = 'Browser History/august.json';
  const septemberPath = 'Browser History/september.json';
  const vault = fakeVault({
    files: {
      [augustPath]: serializeJsonDocument(august),
      [septemberPath]: serializeJsonDocument(september),
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
    { path: 'Browser History/colliding.md', category: 'routing-collision' },
  ]);
  expect(vault.hasFile('Browser History/colliding.md')).toBe(false);
  expect(vault.hasFile(augustPath)).toBe(true);
  expect(vault.hasFile(septemberPath)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});
