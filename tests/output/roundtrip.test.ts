import { describe, expect, it } from 'vitest';
import { codecFor, type OutputFormat } from '../../src/output/codec';
import {
  normalizeCanonicalText,
  type BrowserHistoryDocument,
  type BrowserHistoryRecord,
} from '../../src/output/document';
import { historyDocument, historyRecord } from '../helpers/history-documents';

const repeatedLegacyRecord = historyRecord({
  timestamp: '2026-08-03T09:02:03+03:00',
  title: 'Repeated synthetic visit',
  url: 'http://repeat.example.test/item?id=7',
  browser: 'Legacy Browser',
  profile: 'Profile, Two',
  sync: undefined,
});

const records: BrowserHistoryRecord[] = [
  historyRecord({
    timestamp: '2026-08-03T09:00:01+03:00',
    title: '=SUM(A1), "quoted" [sample] *title* — café 東京',
    url: 'https://docs.example.test/path_(one)?first=1,second=2',
    browser: '+Browser [Preview]',
    profile: '@Profile "A", 東京',
    original_title: 'Original "sample", title',
  }),
  historyRecord({
    timestamp: '2026-08-03T09:01:02+03:00',
    title: 'Legacy `script` sample',
    url: 'javascript:alert("synthetic")',
    browser: 'Legacy *Browser*',
    profile: '-Profile',
    representation: 'inert_text',
    sync: undefined,
  }),
  repeatedLegacyRecord,
  { ...repeatedLegacyRecord },
  historyRecord({
    timestamp: '2026-08-03T09:03:04+03:00',
    title: 'Non-web scheme',
    url: 'obsidian://open?vault=Synthetic&file=Example',
    representation: 'inert_text',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: 'firefox',
      id: 'abcdef1234567890abcdef12',
    },
  }),
  historyRecord({
    timestamp: '2026-08-03T09:04:05+03:00',
    title: 'Malformed URL',
    url: 'not a URL (synthetic)',
    representation: 'inert_text',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: 'safari',
      id: 'fedcba0987654321fedcba09',
    },
  }),
  historyRecord({
    timestamp: '2026-08-03T09:05:06+03:00',
    title: 'Line one\r\nLine two',
    url: 'https://multiline.example.test/',
    browser: 'Browser\nBeta',
    profile: 'Profile\rTwo',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: 'edge',
      id: '00112233445566778899aabb',
    },
  }),
];

const pairwiseFormats = [
  ['markdown', 'csv'],
  ['markdown', 'json'],
  ['csv', 'markdown'],
  ['csv', 'json'],
  ['json', 'markdown'],
  ['json', 'csv'],
] as const satisfies ReadonlyArray<readonly [OutputFormat, OutputFormat]>;

describe('cross-format canonical records', () => {
  it.each(pairwiseFormats)(
    'round-trips canonical records from %s to %s',
    (source, target) => {
      const document = fixtureFor(source, target);
      const first = codecFor(source).parse(codecFor(source).serialize(document)).document;
      const second = codecFor(target).parse(codecFor(target).serialize(first)).document;

      expect(normalizeSourceFormat(second)).toEqual(normalizeSourceFormat(document));
    },
  );

  it.each(pairwiseFormats)(
    'preserves lossy-looking inert URLs from %s to %s',
    (source, target) => {
      const inertRecords = [
        '',
        'javascript:\u0001alert(1)',
        'not   a\t URL',
      ].map((url, index) => historyRecord({
        timestamp: `2026-08-03T09:1${index}:00+03:00`,
        title: 'Inert URL fidelity',
        url,
        representation: 'inert_text',
        sync: {
          namespace: 'obsidian-browser-sync',
          browser: 'chrome',
          id: `${index + 1}`.repeat(24),
        },
      }));
      const document = historyDocument({ records: inertRecords });

      const first = codecFor(source).parse(
        codecFor(source).serialize(document),
        { period: document.metadata.period },
      ).document;
      const second = codecFor(target).parse(
        codecFor(target).serialize(first),
        { period: document.metadata.period },
      ).document;

      expect(second.records.map(({ url }) => url)).toEqual(inertRecords.map(({ url }) => url));
    },
  );
});

function fixtureFor(source: OutputFormat, target: OutputFormat): BrowserHistoryDocument {
  const includesMarkdown = source === 'markdown' || target === 'markdown';
  return historyDocument({
    records: records.map((record) => includesMarkdown
      ? normalizeMarkdownLineText(record)
      : { ...record }),
  });
}

function normalizeMarkdownLineText(record: BrowserHistoryRecord): BrowserHistoryRecord {
  return {
    ...record,
    title: normalizeCanonicalText(record.title),
    browser: normalizeCanonicalText(record.browser),
    profile: normalizeCanonicalText(record.profile),
  };
}

function normalizeSourceFormat(document: BrowserHistoryDocument): BrowserHistoryDocument {
  return {
    ...document,
    metadata: {
      ...document.metadata,
      source_format: 'obsidian_browser_sync_mixed',
    },
  };
}
