import { describe, expect, it } from 'vitest';
import { codecFor } from '../../src/output/codec';
import { serializeCsvDocument, parseCsvDocument, CSV_HEADER } from '../../src/output/csv';
import {
  ConflictingSyncIdError,
  normalizeCanonicalText,
  reconcileRecords,
  type BrowserHistoryDocument,
  type BrowserHistoryRecord,
} from '../../src/output/document';
import { serializeJsonDocument, parseJsonDocument } from '../../src/output/json';
import { serializeMarkdownDocument, parseMarkdownDocument } from '../../src/output/markdown';
import { periodFor } from '../../src/output/periods';
import { historyDocument, historyRecord } from '../helpers/history-documents';

const syncId = (seed: number): string =>
  seed.toString(16).padStart(24, '0').slice(-24);

const adversarialRecords = (): BrowserHistoryRecord[] => [
  historyRecord({
    timestamp: '2026-08-03T09:00:01+03:00',
    title: 'Café 東京 🎉 emoji + CJK',
    url: 'https://example.com/emoji',
    sync: { namespace: 'obsidian-browser-sync', browser: 'chrome', id: syncId(1) },
  }),
  historyRecord({
    timestamp: '2026-08-03T09:01:02+03:00',
    title: 'Pipes | in || title | and — em dash',
    url: 'https://example.com/pipes',
    sync: { namespace: 'obsidian-browser-sync', browser: 'firefox', id: syncId(2) },
  }),
  historyRecord({
    timestamp: '2026-08-03T09:02:03+03:00',
    title: 'Comma, "quoted", =FORMULA(1+1), @mention',
    url: 'https://example.com/?a=1,b=2',
    original_title: 'Orig "quoted", title',
    sync: { namespace: 'obsidian-browser-sync', browser: 'safari', id: syncId(3) },
  }),
  historyRecord({
    timestamp: '2026-08-03T09:03:04+03:00',
    title: '',
    url: 'javascript:alert(1)',
    representation: 'inert_text',
    sync: undefined,
  }),
];

const withMixedSource = (document: BrowserHistoryDocument): BrowserHistoryDocument => ({
  ...document,
  metadata: { ...document.metadata, source_format: 'obsidian_browser_sync_mixed' },
});

describe('redteam: markdown -> json -> csv triple round-trip', () => {
  it('preserves adversarial records across all three codecs', () => {
    const document = historyDocument({ records: adversarialRecords() });
    const viaMarkdown = codecFor('markdown').parse(
      codecFor('markdown').serialize(document),
    ).document;
    const viaJson = codecFor('json').parse(
      codecFor('json').serialize(viaMarkdown),
    ).document;
    const viaCsv = codecFor('csv').parse(
      codecFor('csv').serialize(viaJson),
    ).document;

    expect(withMixedSource(viaCsv).records).toEqual(withMixedSource(document).records);
  });

  it('round-trips the reverse direction csv -> json -> markdown', () => {
    const document = historyDocument({ records: adversarialRecords() });
    const viaCsv = codecFor('csv').parse(codecFor('csv').serialize(document)).document;
    const viaJson = codecFor('json').parse(codecFor('json').serialize(viaCsv)).document;
    const viaMarkdown = codecFor('markdown').parse(
      codecFor('markdown').serialize(viaJson),
    ).document;

    expect(withMixedSource(viaMarkdown).records).toEqual(
      withMixedSource(document).records,
    );
  });
});

describe('redteam: unicode / emoji / CJK titles', () => {
  it.each(['markdown', 'json', 'csv'] as const)('survives %s intact', (format) => {
    const codec = codecFor(format);
    const document = historyDocument({
      records: [
        historyRecord({ title: '日本語タイトル 🎌 café naïve façade ☃', sync: { namespace: 'obsidian-browser-sync', browser: 'chrome', id: syncId(11) } }),
        historyRecord({ title: '🏳️‍🌈 ZWJ sequence 표 테스트', sync: { namespace: 'obsidian-browser-sync', browser: 'chrome', id: syncId(12) } }),
      ],
    });
    const parsed = codec.parse(codec.serialize(document)).document;
    expect(parsed.records.map((record) => record.title)).toEqual(
      document.records.map((record) => record.title),
    );
  });
});

describe('redteam: pipes and newlines in titles', () => {
  it('round-trips pipe characters through markdown', () => {
    const document = historyDocument({
      records: [historyRecord({ title: 'a | b || c |' })],
    });
    const parsed = parseMarkdownDocument(serializeMarkdownDocument(document));
    expect(parsed.document.records[0]?.title).toBe('a | b || c |');
    expect(parsed.hasUnrecognizedContent).toBe(false);
  });

  it('normalizes embedded newlines per normalizeCanonicalText instead of corrupting', () => {
    const raw = 'Line one\nLine two\r\nLine three\tLine four';
    const document = historyDocument({ records: [historyRecord({ title: raw })] });
    const parsed = parseMarkdownDocument(serializeMarkdownDocument(document));
    expect(parsed.document.records[0]?.title).toBe(normalizeCanonicalText(raw));
  });

  it('never silently drops an em-dash title: either exact or flagged unrecognized', () => {
    const document = historyDocument({
      records: [historyRecord({ title: 'A — B' })],
    });
    const parsed = parseMarkdownDocument(serializeMarkdownDocument(document));
    const roundTripped = parsed.document.records[0]?.title === 'A — B';
    expect(roundTripped || parsed.hasUnrecognizedContent).toBe(true);
  });
});

describe('redteam: commas and quotes in CSV fields', () => {
  it('round-trips commas, quotes, and formula triggers in every text field', () => {
    const document = historyDocument({
      records: [
        historyRecord({
          title: '"quoted", with, commas =SUM(A1)',
          browser: 'Browser, "Inc"',
          profile: '@Profile, +x',
          original_title: "'leading quote",
        }),
      ],
    });
    expect(parseCsvDocument(serializeCsvDocument(document)).document).toEqual(document);
  });
});

describe('redteam: frontmatter period mismatch', () => {
  it('rejects CSV rows with inconsistent metadata periods', () => {
    const first = historyRecord({
      sync: { namespace: 'obsidian-browser-sync', browser: 'chrome', id: syncId(21) },
    });
    const second = historyRecord({
      timestamp: '2026-09-03T09:00:01+03:00',
      sync: { namespace: 'obsidian-browser-sync', browser: 'chrome', id: syncId(22) },
    });
    const docAugust = historyDocument({
      metadata: { ...historyDocument().metadata, period: '2026-08' },
      records: [first],
    });
    const docSeptember = historyDocument({
      metadata: { ...historyDocument().metadata, period: '2026-09' },
      records: [second],
    });
    const header = serializeCsvDocument(docAugust).split('\r\n')[0] as string;
    const rowOf = (doc: BrowserHistoryDocument): string =>
      serializeCsvDocument(doc).split('\r\n')[1] as string;
    const mixed = `${header}\r\n${rowOf(docAugust)}\r\n${rowOf(docSeptember)}\r\n`;
    expect(() => parseCsvDocument(mixed)).toThrow('inconsistent metadata');
  });

  it('rejects a JSON document with an invalid period', () => {
    const document = historyDocument({
      metadata: { ...historyDocument().metadata, period: 'not-a-period' },
    });
    expect(() => parseJsonDocument(serializeJsonDocument(document))).toThrow();
  });
});

describe('redteam: reconcileRecords across 3 sources', () => {
  it('dedupes identical sync records seen in three sources to one', () => {
    const record = historyRecord({
      sync: { namespace: 'obsidian-browser-sync', browser: 'chrome', id: syncId(31) },
    });
    const reconciled = reconcileRecords([
      [{ ...record }],
      [{ ...record }],
      [{ ...record }],
    ]);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toEqual(record);
  });

  it('throws ConflictingSyncIdError when three sources disagree on one sync id', () => {
    const base = {
      namespace: 'obsidian-browser-sync',
      browser: 'chrome',
    } as const;
    const left = historyRecord({ title: 'Left title', sync: { ...base, id: syncId(32) } });
    const middle = historyRecord({ title: 'Middle title', sync: { ...base, id: syncId(32) } });
    const right = historyRecord({ title: 'Right title', sync: { ...base, id: syncId(32) } });
    expect(() => reconcileRecords([[{ ...left }], [{ ...middle }], [{ ...right }]])).toThrow(
      ConflictingSyncIdError,
    );
  });

  it('keeps the max per-document repeat count for legacy records', () => {
    const legacy = historyRecord({ title: 'Legacy repeat', sync: undefined });
    const reconciled = reconcileRecords([
      [{ ...legacy }, { ...legacy }],
      [{ ...legacy }],
      [],
    ]);
    expect(reconciled).toHaveLength(2);
  });
});

describe('redteam: empty records document', () => {
  it('round-trips an empty document through markdown and json', () => {
    const empty = historyDocument({ records: [] });
    expect(
      parseMarkdownDocument(serializeMarkdownDocument(empty)).document.records,
    ).toEqual([]);
    expect(parseJsonDocument(serializeJsonDocument(empty)).document.records).toEqual([]);
  });

  it('parses a header-only CSV with an explicit period context', () => {
    const parsed = parseCsvDocument(`${CSV_HEADER.join(',')}\r\n`, {
      period: '2026-08',
    });
    expect(parsed.document.records).toEqual([]);
    expect(parsed.document.metadata.period).toBe('2026-08');
  });
});

describe('redteam: 10k-record perf sanity', () => {
  it('serializes and parses 10k records in under 3s per codec', () => {
    const records = Array.from({ length: 10_000 }, (_, index) =>
      historyRecord({
        timestamp: `2026-08-03T09:${String(index % 60).padStart(2, '0')}:${String(Math.floor(index / 60) % 60).padStart(2, '0')}+03:00`,
        title: `Perf record ${index} café 東京 🎉`,
        url: `https://example.com/items/${index}?a=1,b=2`,
        sync: {
          namespace: 'obsidian-browser-sync',
          browser: 'chrome',
          id: syncId(100_000 + index),
        },
      }));
    const document = historyDocument({ records });

    for (const format of ['json', 'csv'] as const) {
      const codec = codecFor(format);
      const started = Date.now();
      const parsed = codec.parse(codec.serialize(document)).document;
      expect(Date.now() - started).toBeLessThan(3000);
      expect(parsed.records).toHaveLength(10_000);
    }
  }, 30_000);
});

describe('redteam: malformed frontmatter', () => {
  it('refuses a markdown note missing the browser-sync flag instead of misreading it', () => {
    const good = serializeMarkdownDocument(historyDocument());
    const withoutFlag = good.replace('browser-sync: true\n', '');
    expect(() => parseMarkdownDocument(withoutFlag)).toThrow(
      'exact Browser Sync envelope',
    );
  });
});

describe('redteam: CSV header drift', () => {
  it('rejects a header with an extra column', () => {
    const good = serializeCsvDocument(historyDocument());
    const drifted = good.replace(
      CSV_HEADER.join(','),
      `${CSV_HEADER.join(',')},extra_column`,
    );
    expect(() => parseCsvDocument(drifted)).toThrow('header');
  });

  it('rejects a header with a renamed column', () => {
    const good = serializeCsvDocument(historyDocument());
    const renamed = good.replace('metadata_period', 'metadata_peroid');
    expect(() => parseCsvDocument(renamed)).toThrow('header');
  });
});

describe('redteam: week-period ISO edges', () => {
  const noon = (value: string): Date => new Date(`${value}T12:00:00`);

  it('assigns year-boundary dates to the correct ISO week', () => {
    expect(periodFor(noon('2024-12-29'), 'week').key).toBe('2024-W52');
    expect(periodFor(noon('2024-12-30'), 'week').key).toBe('2025-W01');
    expect(periodFor(noon('2024-12-31'), 'week').key).toBe('2025-W01');
    expect(periodFor(noon('2025-01-01'), 'week').key).toBe('2025-W01');
    expect(periodFor(noon('2024-01-01'), 'week').key).toBe('2024-W01');
  });

  it('keeps day-period keys stable across the local-date noon invariant', () => {
    for (const day of ['2026-03-08', '2026-11-01', '2026-08-03']) {
      const midnight = new Date(`${day}T00:30:00`);
      const late = new Date(`${day}T23:30:00`);
      expect(periodFor(late, 'day').key).toBe(periodFor(midnight, 'day').key);
      expect(periodFor(midnight, 'day').key).toBe(day);
    }
  });
});
