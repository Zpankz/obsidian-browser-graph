import { expect, it } from 'vitest';
import { codecFor, formatForPath } from '../../src/output/codec';
import { historyDocument } from '../helpers/history-documents';

it('registers exactly the Markdown, CSV, and JSON codecs', () => {
  expect(codecFor('markdown').extension).toBe('.md');
  expect(codecFor('csv').extension).toBe('.csv');
  expect(codecFor('json').extension).toBe('.json');
});

it('detects supported filename extensions case-insensitively', () => {
  expect(formatForPath('History/2026-08.JSON')).toBe('json');
  expect(formatForPath('History/2026-08.CsV')).toBe('csv');
  expect(formatForPath('History/2026-08.MD')).toBe('markdown');
  expect(formatForPath('History/readme.txt')).toBeUndefined();
});

it('dispatches serialization and parsing through the selected codec', () => {
  const document = historyDocument({
    metadata: {
      ...historyDocument().metadata,
      source_format: 'obsidian_browser_sync_json',
    },
  });
  const codec = codecFor('json');
  expect(codec.parse(codec.serialize(document)).document).toEqual(document);
});
