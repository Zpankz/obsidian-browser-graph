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

it('rejects nonexistent calendar dates in record timestamps and day periods', () => {
  const invalidTimestamp = historyDocument({
    records: [historyRecord({ timestamp: '2026-02-31T12:00:00+03:00' })],
  });
  expect(() => parseJsonDocument(JSON.stringify(invalidTimestamp)))
    .toThrow('record.timestamp');

  const invalidPeriod = historyDocument({
    metadata: { ...historyDocument().metadata, period: '2026-02-31' },
  });
  expect(() => parseJsonDocument(JSON.stringify(invalidPeriod)))
    .toThrow('metadata.period');
});

it('accepts valid leap-day timestamps and day periods', () => {
  const document = historyDocument({
    metadata: { ...historyDocument().metadata, period: '2024-02-29' },
    records: [historyRecord({ timestamp: '2024-02-29T12:00:00+03:00' })],
  });

  expect(parseJsonDocument(JSON.stringify(document)).document).toEqual(document);
});
