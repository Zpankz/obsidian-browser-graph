import { expect, it } from 'vitest';
import { parseJsonDocument } from '../../src/output/json';
import { historyDocument, historyRecord } from '../helpers/history-documents';

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
