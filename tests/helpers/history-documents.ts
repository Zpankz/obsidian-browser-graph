import type {
  BrowserHistoryDocument,
  BrowserHistoryRecord,
} from '../../src/output/document';

export function historyRecord(
  overrides: Partial<BrowserHistoryRecord> = {},
): BrowserHistoryRecord {
  return {
    timestamp: '2026-08-03T15:34:56+03:00',
    title: 'Example page',
    url: 'https://example.com/',
    browser: 'Google Chrome',
    profile: 'Default',
    representation: 'markdown_link',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: 'chrome',
      id: '1234567890abcdef12345678',
    },
    ...overrides,
  };
}

export function historyDocument(
  overrides: Partial<BrowserHistoryDocument> = {},
): BrowserHistoryDocument {
  return {
    schema_version: 1,
    type: 'browser_history',
    metadata: {
      browser_sync: true,
      period: '2026-08',
      heading: 'Browser history',
      source_format: 'obsidian_browser_sync_browser_database',
    },
    records: [historyRecord()],
    ...overrides,
  };
}
