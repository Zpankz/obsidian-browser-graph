import { expect, it } from 'vitest';
import {
  CSV_HEADER,
  decodeCsvText,
  encodeCsvText,
  parseCsvDocument,
  serializeCsvDocument,
} from '../../src/output/csv';
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

it('requires parse context to reconstruct a header-only document', () => {
  const content = `${CSV_HEADER.join(',')}\r\n`;
  expect(() => parseCsvDocument(content)).toThrow('period');
  expect(parseCsvDocument(content, { period: '2026-08' }).document).toEqual(historyDocument({
    metadata: { ...historyDocument().metadata, source_format: 'obsidian_browser_sync_csv' },
    records: [],
  }));
});

it('rejects duplicate or missing headers', () => {
  const duplicate = [...CSV_HEADER];
  duplicate[1] = duplicate[0];
  expect(() => parseCsvDocument(`${duplicate.join(',')}\r\n`)).toThrow('header');
  expect(() => parseCsvDocument(`${CSV_HEADER.slice(0, -1).join(',')}\r\n`)).toThrow('header');
});

it('rejects malformed RFC 4180 quoted fields', () => {
  expect(() => parseCsvDocument(`${CSV_HEADER.join(',')}\r\n"unterminated`)).toThrow('quoted');
  expect(() => parseCsvDocument(`${CSV_HEADER.join(',')}\r\nabc"def`)).toThrow('quote');
  expect(() => parseCsvDocument(`${CSV_HEADER.join(',')}\r\n"abc"def`)).toThrow('quote');
});

it('rejects inconsistent document metadata rows', () => {
  const document = historyDocument({ records: [historyRecord(), historyRecord({ title: 'second' })] });
  const rows = serializeCsvDocument(document).trimEnd().split('\r\n');
  const cells = rows[2].split(',');
  cells[3] = '2026-09';
  rows[2] = cells.join(',');
  expect(() => parseCsvDocument(`${rows.join('\r\n')}\r\n`)).toThrow('metadata');
});

it('rejects partial sync cells', () => {
  const document = historyDocument({ records: [historyRecord({ sync: undefined })] });
  const rows = serializeCsvDocument(document).trimEnd().split('\r\n');
  const cells = rows[1].split(',');
  cells[13] = 'obsidian-browser-sync';
  rows[1] = cells.join(',');
  expect(() => parseCsvDocument(`${rows.join('\r\n')}\r\n`)).toThrow('sync');
});

it.each([
  ['schema_version', '2'],
  ['type', 'not_history'],
  ['metadata_browser_sync', 'false'],
])('rejects an incorrect %s marker', (column, value) => {
  const document = historyDocument();
  const rows = serializeCsvDocument(document).trimEnd().split('\r\n');
  const index = CSV_HEADER.indexOf(column as (typeof CSV_HEADER)[number]);
  const cells = rows[1].split(',');
  cells[index] = value;
  rows[1] = cells.join(',');
  expect(() => parseCsvDocument(`${rows.join('\r\n')}\r\n`)).toThrow(column);
});
