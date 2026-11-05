import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '../../src/domain';
import {
  CURSOR_OVERLAP_MS,
  MAX_FUTURE_SKEW_MS,
  isSafeVisitTimestamp,
  normalizeVisit,
  sortVisits,
} from '../../src/browsers/reader';
import { ChromiumReader } from '../../src/browsers/chromium';
import { FirefoxReader } from '../../src/browsers/firefox';
import { SafariReader } from '../../src/browsers/safari';
import {
  chromiumFixture,
  firefoxFixture,
  safariFixture,
  sqliteFixture,
} from '../helpers/sqlite-fixture';
import { visit } from '../helpers/visits';

const CHROMIUM_OFFSET_MICROS = 11_644_473_600_000_000;
const SAFARI_OFFSET_SECONDS = 978_307_200;
const NOW = Date.parse('2026-08-03T12:00:00Z');

function chromeProfile(): BrowserProfile {
  return {
    sourceKey: 'chrome:profile',
    browserId: 'chrome',
    browserName: 'Google Chrome',
    profileId: 'Default',
    profileName: 'Personal',
    databasePath: '/browser/History',
    readerKind: 'chromium',
  };
}

function firefoxProfile(): BrowserProfile {
  return {
    sourceKey: 'firefox:profile',
    browserId: 'firefox',
    browserName: 'Firefox',
    profileId: 'abc.default-release',
    profileName: 'Work',
    databasePath: '/browser/places.sqlite',
    readerKind: 'firefox',
  };
}

function safariProfile(): BrowserProfile {
  return {
    sourceKey: 'safari:profile',
    browserId: 'safari',
    browserName: 'Safari',
    profileId: 'History',
    profileName: 'History',
    databasePath: '/browser/History.db',
    readerKind: 'safari',
  };
}

describe('redteam: empty DB / missing tables fail schema validation', () => {
  it('chromium rejects an empty database with a schema error', async () => {
    const db = await sqliteFixture([]);
    expect(() => new ChromiumReader(() => NOW).read(db, chromeProfile()))
      .toThrow('Unsupported Chromium history schema');
    db.close();
  });

  it('firefox rejects an empty database with a schema error', async () => {
    const db = await sqliteFixture([]);
    expect(() => new FirefoxReader(() => NOW).read(db, firefoxProfile()))
      .toThrow('Unsupported Firefox history schema');
    db.close();
  });

  it('safari rejects an empty database with a schema error', async () => {
    const db = await sqliteFixture([]);
    expect(() => new SafariReader(() => NOW).read(db, safariProfile()))
      .toThrow('Unsupported Safari history schema');
    db.close();
  });

  it('chromium rejects a database with urls but no visits table', async () => {
    const db = await sqliteFixture([
      'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT)',
    ]);
    expect(() => new ChromiumReader(() => NOW).read(db, chromeProfile()))
      .toThrow('Unsupported Chromium history schema');
    db.close();
  });
});

describe('redteam: cursor-overlap boundary is inclusive', () => {
  const cursorMs = Date.parse('2026-08-03T10:05:00Z');
  const edgeMs = cursorMs - CURSOR_OVERLAP_MS;

  it('chromium includes a visit exactly at the overlap edge', async () => {
    const db = await chromiumFixture([
      { id: 2, urlId: 1, visitTime: edgeMs * 1_000 + CHROMIUM_OFFSET_MICROS },
    ]);
    const visits = new ChromiumReader(() => NOW).read(db, chromeProfile(), {
      visitedAtMs: cursorMs,
      sourceVisitId: '99',
    });
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['2']);
    db.close();
  });

  it('chromium excludes a visit 1ms before the overlap edge', async () => {
    const db = await chromiumFixture([
      { id: 1, urlId: 1, visitTime: (edgeMs - 1) * 1_000 + CHROMIUM_OFFSET_MICROS },
    ]);
    const visits = new ChromiumReader(() => NOW).read(db, chromeProfile(), {
      visitedAtMs: cursorMs,
      sourceVisitId: '99',
    });
    expect(visits).toEqual([]);
    db.close();
  });

  it('firefox includes a visit exactly at the overlap edge', async () => {
    const db = await firefoxFixture([
      { id: 2, placeId: 1, visitDate: edgeMs * 1_000 },
    ]);
    const visits = new FirefoxReader(() => NOW).read(db, firefoxProfile(), {
      visitedAtMs: cursorMs,
      sourceVisitId: '99',
    });
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['2']);
    db.close();
  });

  it('firefox excludes a visit 1ms before the overlap edge', async () => {
    const db = await firefoxFixture([
      { id: 1, placeId: 1, visitDate: (edgeMs - 1) * 1_000 },
    ]);
    const visits = new FirefoxReader(() => NOW).read(db, firefoxProfile(), {
      visitedAtMs: cursorMs,
      sourceVisitId: '99',
    });
    expect(visits).toEqual([]);
    db.close();
  });

  it('safari includes a visit exactly at the overlap edge', async () => {
    const db = await safariFixture([
      { id: 2, historyItem: 1, visitTime: edgeMs / 1_000 - SAFARI_OFFSET_SECONDS },
    ]);
    const visits = new SafariReader(() => NOW).read(db, safariProfile(), {
      visitedAtMs: cursorMs,
      sourceVisitId: '99',
    });
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['2']);
    db.close();
  });

  it('safari excludes a visit 1ms before the overlap edge', async () => {
    const db = await safariFixture([
      { id: 1, historyItem: 1, visitTime: (edgeMs - 1) / 1_000 - SAFARI_OFFSET_SECONDS },
    ]);
    const visits = new SafariReader(() => NOW).read(db, safariProfile(), {
      visitedAtMs: cursorMs,
      sourceVisitId: '99',
    });
    expect(visits).toEqual([]);
    db.close();
  });
});

describe('redteam: future skew beyond 24h is dropped', () => {
  it('normalizeVisit accepts exactly +24h but drops +24h+1ms', () => {
    const accepted = normalizeVisit(
      chromeProfile(), '1', NOW + MAX_FUTURE_SKEW_MS,
      'Edge', 'https://example.com', NOW,
    );
    expect(accepted?.visitedAt).toEqual(new Date(NOW + MAX_FUTURE_SKEW_MS));
    expect(normalizeVisit(
      chromeProfile(), '2', NOW + MAX_FUTURE_SKEW_MS + 1,
      'Future', 'https://example.com', NOW,
    )).toBeUndefined();
  });

  it('chromium drops a visit 25h in the future without losing healthy rows', async () => {
    const futureMicros = Date.parse(new Date(NOW + 25 * 3_600_000).toISOString()) * 1_000
      + CHROMIUM_OFFSET_MICROS;
    const db = await chromiumFixture([
      { id: 1, urlId: 1, visitTime: futureMicros },
      { id: 2, urlId: 1, visitTime: Date.parse('2026-08-03T10:00:00Z') * 1_000 + CHROMIUM_OFFSET_MICROS },
    ]);
    const visits = new ChromiumReader(() => NOW).read(db, chromeProfile());
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['2']);
    db.close();
  });
});

describe('redteam: hostile timestamps never escape the reader', () => {
  it('chromium drops huge and negative visit_time values without crashing', async () => {
    const db = await chromiumFixture([
      { id: 1, urlId: 1, visitTime: 9e18 },
      { id: 2, urlId: 1, visitTime: CHROMIUM_OFFSET_MICROS - 1e12 },
      { id: 3, urlId: 1, visitTime: Date.parse('2026-08-03T10:00:00Z') * 1_000 + CHROMIUM_OFFSET_MICROS },
    ]);
    const visits = new ChromiumReader(() => NOW).read(db, chromeProfile());
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['3']);
    db.close();
  });

  it('firefox drops huge and negative visit_date values without crashing', async () => {
    const db = await firefoxFixture([
      { id: 1, placeId: 1, visitDate: 9e18 },
      { id: 2, placeId: 1, visitDate: -1e15 },
      { id: 3, placeId: 1, visitDate: Date.parse('2026-08-03T10:00:00Z') * 1_000 },
    ]);
    const visits = new FirefoxReader(() => NOW).read(db, firefoxProfile());
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['3']);
    db.close();
  });

  it('safari drops huge and negative visit_time values without crashing', async () => {
    const db = await safariFixture([
      { id: 1, historyItem: 1, visitTime: 9e12 },
      { id: 2, historyItem: 1, visitTime: -(SAFARI_OFFSET_SECONDS + 1_000) },
      { id: 3, historyItem: 1, visitTime: Date.parse('2026-08-03T10:00:00Z') / 1_000 - SAFARI_OFFSET_SECONDS },
    ]);
    const visits = new SafariReader(() => NOW).read(db, safariProfile());
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['3']);
    db.close();
  });

  it('chromium drops a non-numeric TEXT visit_time without crashing', async () => {
    const db = await sqliteFixture([
      'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT)',
      'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time)',
      "INSERT INTO urls VALUES (1, 'https://example.com', 'Example')",
      "INSERT INTO visits VALUES (1, 1, 'not-a-time')",
    ]);
    db.run('INSERT INTO visits VALUES (2, 1, :time)', {
      ':time': Date.parse('2026-08-03T10:00:00Z') * 1_000 + CHROMIUM_OFFSET_MICROS,
    });
    const visits = new ChromiumReader(() => NOW).read(db, chromeProfile());
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['2']);
    db.close();
  });

  it('safari drops a non-numeric TEXT visit_time without crashing', async () => {
    const db = await sqliteFixture([
      'CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT)',
      'CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time, title TEXT)',
      "INSERT INTO history_items VALUES (1, 'https://example.com')",
      "INSERT INTO history_visits VALUES (1, 1, 'garbage', 'Bad')",
    ]);
    db.run('INSERT INTO history_visits VALUES (2, 1, :time, :title)', {
      ':time': Date.parse('2026-08-03T10:00:00Z') / 1_000 - SAFARI_OFFSET_SECONDS,
      ':title': 'Good',
    });
    const visits = new SafariReader(() => NOW).read(db, safariProfile());
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['2']);
    db.close();
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    '12345',
    null,
    undefined,
    {},
    [],
    8_640_000_000_000_001,
  ])('isSafeVisitTimestamp rejects hostile value %s', (value) => {
    expect(isSafeVisitTimestamp(value, NOW)).toBe(false);
  });
});

describe('redteam: hostile titles and urls are coerced, never thrown', () => {
  it('chromium maps NULL title and empty title both to empty string', async () => {
    const db = await sqliteFixture([
      'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT)',
      'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time)',
      "INSERT INTO urls VALUES (1, 'https://a.example/', NULL)",
      "INSERT INTO urls VALUES (2, 'https://b.example/', '')",
    ]);
    db.run('INSERT INTO visits VALUES (1, 1, :time)', {
      ':time': Date.parse('2026-08-03T10:00:00Z') * 1_000 + CHROMIUM_OFFSET_MICROS,
    });
    db.run('INSERT INTO visits VALUES (2, 2, :time)', {
      ':time': Date.parse('2026-08-03T10:01:00Z') * 1_000 + CHROMIUM_OFFSET_MICROS,
    });
    const visits = new ChromiumReader(() => NOW).read(db, chromeProfile());
    expect(visits.map((item) => item.title)).toEqual(['', '']);
    db.close();
  });

  it('chromium keeps sqlite TEXT-affinity coercion (numbers stored as text)', async () => {
    const db = await sqliteFixture([
      'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT)',
      'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time)',
      'INSERT INTO urls VALUES (1, 12345, 678)',
    ]);
    db.run('INSERT INTO visits VALUES (1, 1, :time)', {
      ':time': Date.parse('2026-08-03T10:00:00Z') * 1_000 + CHROMIUM_OFFSET_MICROS,
    });
    const visits = new ChromiumReader(() => NOW).read(db, chromeProfile());
    expect(visits).toHaveLength(1);
    // SQLite TEXT affinity stores 678/12345 as '678'/'12345' before the
    // reader ever sees them, so normalizeVisit correctly keeps the strings.
    expect(visits[0].title).toBe('678');
    expect(visits[0].url).toBe('12345');
    db.close();
  });

  it('normalizeVisit coerces non-string title and url to empty string', () => {
    const coerced = normalizeVisit(
      chromeProfile(), '1', NOW - 1_000, 678 as unknown as string,
      12345 as unknown as string, NOW,
    );
    expect(coerced?.title).toBe('');
    expect(coerced?.url).toBe('');
  });

  it('chromium preserves unicode and control characters in urls exactly', async () => {
    const weirdUrl = 'https://example.com/ünïcodé/☃/🎉?q=ÿ&lang=日本語\twith-tab\nwith-newline';
    const db = await chromiumFixture(
      [{ id: 1, urlId: 1, visitTime: Date.parse('2026-08-03T10:00:00Z') * 1_000 + CHROMIUM_OFFSET_MICROS }],
      { url: weirdUrl },
    );
    const visits = new ChromiumReader(() => NOW).read(db, chromeProfile());
    expect(visits).toHaveLength(1);
    expect(visits[0].url).toBe(weirdUrl);
    db.close();
  });
});

describe('redteam: incremental cursor semantics', () => {
  it('chromium fetches a higher id at the same timestamp as the cursor (tie-break)', async () => {
    const at = Date.parse('2026-08-03T10:00:00Z') * 1_000 + CHROMIUM_OFFSET_MICROS;
    const db = await chromiumFixture([
      { id: 4, urlId: 1, visitTime: at },
      { id: 5, urlId: 1, visitTime: at },
      { id: 6, urlId: 1, visitTime: at },
    ]);
    const visits = new ChromiumReader(() => NOW).read(db, chromeProfile(), {
      visitedAtMs: Date.parse('2026-08-03T10:00:00Z'),
      sourceVisitId: '5',
    });
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['4', '5', '6']);
    db.close();
  });

  it('chromium recovers a backwards-clock visit with a higher id but not a lower one', async () => {
    const at = Date.parse('2026-08-03T09:00:00Z') * 1_000 + CHROMIUM_OFFSET_MICROS;
    const db = await chromiumFixture([
      { id: 6, urlId: 1, visitTime: at },
      { id: 8, urlId: 1, visitTime: at },
    ]);
    const visits = new ChromiumReader(() => NOW).read(db, chromeProfile(), {
      visitedAtMs: Date.parse('2026-08-03T10:05:00Z'),
      sourceVisitId: '7',
    });
    expect(visits.map((item) => item.sourceVisitId)).toEqual(['8']);
    db.close();
  });

  it('sortVisits orders huge numeric ids numerically, not lexicographically', () => {
    const at = new Date('2026-08-03T10:00:00Z');
    const sorted = sortVisits([
      visit({ sourceVisitId: '9007199254740993', visitedAt: at }),
      visit({ sourceVisitId: '10', visitedAt: at }),
      visit({ sourceVisitId: '9', visitedAt: at }),
      visit({ sourceVisitId: '9007199254740992', visitedAt: at }),
    ]);
    expect(sorted.map((item) => item.sourceVisitId)).toEqual([
      '9',
      '10',
      '9007199254740992',
      '9007199254740993',
    ]);
  });
});
