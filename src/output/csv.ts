import type {
  BrowserHistoryDocument,
  BrowserHistoryRecord,
  BrowserHistorySync,
  ManagedDocumentParse,
} from './document';
import { validateBrowserHistoryDocument } from './document';

export const CSV_HEADER = [
  'schema_version', 'type', 'metadata_browser_sync', 'metadata_period',
  'metadata_heading', 'metadata_source_format', 'timestamp', 'title', 'url',
  'browser', 'profile', 'representation', 'original_title',
  'sync_namespace', 'sync_browser', 'sync_id',
] as const;

const FORMULA_TRIGGER = /^[=+\-@\t\r\n]/;

export function encodeCsvText(value: string): string {
  return value.startsWith("'") || FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

export function decodeCsvText(value: string): string {
  if (value.startsWith("''") || /^'[=+\-@\t\r\n]/.test(value)) {
    return value.slice(1);
  }
  return value;
}

export function serializeCsvDocument(document: BrowserHistoryDocument): string {
  const validated = validateBrowserHistoryDocument(document);
  const rows = [CSV_HEADER, ...validated.records.map((record) => rowFor(validated, record))];
  return `${rows.map((row) => row.map(quoteCsvField).join(',')).join('\r\n')}\r\n`;
}

export function parseCsvDocument(
  content: string,
  context: { period?: string } = {},
): ManagedDocumentParse {
  const rows = parseCsvRows(content);
  assertExactHeader(rows.shift());
  const document = documentFromRows(rows, context);
  validateBrowserHistoryDocument(document);
  return { document, hasUnrecognizedContent: false };
}

function rowFor(document: BrowserHistoryDocument, record: BrowserHistoryRecord): string[] {
  return [
    '1',
    'browser_history',
    'true',
    encodeCsvText(document.metadata.period),
    encodeCsvText(document.metadata.heading),
    encodeCsvText(document.metadata.source_format),
    encodeCsvText(record.timestamp),
    encodeCsvText(record.title),
    encodeCsvText(record.url),
    encodeCsvText(record.browser),
    encodeCsvText(record.profile),
    encodeCsvText(record.representation),
    record.original_title === undefined ? '' : `'${encodeCsvText(record.original_title)}`,
    record.sync === undefined ? '' : encodeCsvText(record.sync.namespace),
    record.sync === undefined ? '' : encodeCsvText(record.sync.browser),
    record.sync === undefined ? '' : encodeCsvText(record.sync.id),
  ];
}

function quoteCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function documentFromRows(
  rows: string[][],
  context: { period?: string },
): BrowserHistoryDocument {
  if (rows.length === 0) {
    if (context.period === undefined) {
      throw new Error('CSV header-only documents require a period parse context');
    }
    return {
      schema_version: 1,
      type: 'browser_history',
      metadata: {
        browser_sync: true,
        period: context.period,
        heading: 'Browser history',
        source_format: 'obsidian_browser_sync_csv',
      },
      records: [],
    };
  }

  const first = rows[0];
  assertRowWidth(first);
  const metadata = metadataFor(first);
  const records = rows.map((row) => {
    assertRowWidth(row);
    assertDocumentMarkers(row);
    assertMatchingMetadata(metadata, metadataFor(row));
    return recordFor(row);
  });
  return {
    schema_version: 1,
    type: 'browser_history',
    metadata,
    records,
  };
}

function metadataFor(row: string[]): BrowserHistoryDocument['metadata'] {
  return {
    browser_sync: true,
    period: decodeCsvText(row[3]),
    heading: decodeCsvText(row[4]) as 'Browser history',
    source_format: decodeCsvText(row[5]) as BrowserHistoryDocument['metadata']['source_format'],
  };
}

function recordFor(row: string[]): BrowserHistoryRecord {
  const syncCells = row.slice(13, 16).map(decodeCsvText);
  const hasSync = syncCells.some((value) => value.length > 0);
  if (hasSync && syncCells.some((value) => value.length === 0)) {
    throw new Error('CSV record has partial sync values');
  }

  const record: BrowserHistoryRecord = {
    timestamp: decodeCsvText(row[6]),
    title: decodeCsvText(row[7]),
    url: decodeCsvText(row[8]),
    browser: decodeCsvText(row[9]),
    profile: decodeCsvText(row[10]),
    representation: decodeCsvText(row[11]) as BrowserHistoryRecord['representation'],
  };
  if (row[12] !== '') {
    if (!row[12].startsWith("'")) {
      throw new Error('CSV original_title is missing its presence marker');
    }
    record.original_title = decodeCsvText(row[12].slice(1));
  }
  if (hasSync) {
    record.sync = {
      namespace: syncCells[0] as 'obsidian-browser-sync',
      browser: syncCells[1] as BrowserHistorySync['browser'],
      id: syncCells[2],
    };
  }
  return record;
}

function assertDocumentMarkers(row: string[]): void {
  if (decodeCsvText(row[0]) !== '1') {
    throw new Error('schema_version must be 1');
  }
  if (decodeCsvText(row[1]) !== 'browser_history') {
    throw new Error('type must be browser_history');
  }
  if (decodeCsvText(row[2]) !== 'true') {
    throw new Error('metadata_browser_sync must be true');
  }
}

function assertMatchingMetadata(
  expected: BrowserHistoryDocument['metadata'],
  actual: BrowserHistoryDocument['metadata'],
): void {
  if (expected.browser_sync !== actual.browser_sync
    || expected.period !== actual.period
    || expected.heading !== actual.heading
    || expected.source_format !== actual.source_format) {
    throw new Error('CSV rows have inconsistent metadata');
  }
}

function assertExactHeader(header: string[] | undefined): asserts header is string[] {
  if (header === undefined
    || header.length !== CSV_HEADER.length
    || header.some((value, index) => value !== CSV_HEADER[index])) {
    throw new Error('CSV header must exactly match the expected header');
  }
}

function assertRowWidth(row: string[]): void {
  if (row.length !== CSV_HEADER.length) {
    throw new Error(`CSV row must have ${CSV_HEADER.length} fields`);
  }
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'start' | 'unquoted' | 'quoted' | 'after-quote' = 'start';

  const finishRow = (): void => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    state = 'start';
  };

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (state === 'quoted') {
      if (character === '"') {
        state = 'after-quote';
      } else {
        field += character;
      }
      continue;
    }
    if (state === 'after-quote') {
      if (character === '"') {
        field += '"';
        state = 'quoted';
      } else if (character === ',') {
        row.push(field);
        field = '';
        state = 'start';
      } else if (character === '\r' && content[index + 1] === '\n') {
        finishRow();
        index += 1;
      } else {
        throw new Error('CSV has invalid characters after a closing quote');
      }
      continue;
    }
    if (state === 'start') {
      if (character === '"') {
        state = 'quoted';
      } else if (character === ',') {
        row.push('');
      } else if (character === '\r' && content[index + 1] === '\n') {
        finishRow();
        index += 1;
      } else if (character === '\r' || character === '\n') {
        throw new Error('CSV records must be separated by CRLF');
      } else {
        field = character;
        state = 'unquoted';
      }
      continue;
    }
    if (character === ',') {
      row.push(field);
      field = '';
      state = 'start';
    } else if (character === '"') {
      throw new Error('CSV has a bare quote in an unquoted field');
    } else if (character === '\r' && content[index + 1] === '\n') {
      finishRow();
      index += 1;
    } else if (character === '\r' || character === '\n') {
      throw new Error('CSV records must be separated by CRLF');
    } else {
      field += character;
    }
  }

  if (state === 'quoted') {
    throw new Error('CSV has a truncated quoted field');
  }
  if (state === 'after-quote' || state === 'unquoted') {
    finishRow();
  } else if (state === 'start' && row.length > 0) {
    finishRow();
  }
  return rows;
}
