import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '../../src/domain';
import { ChromiumReader } from '../../src/browsers/chromium';
import { chromiumFixture, sqliteFixture } from '../helpers/sqlite-fixture';

const CHROMIUM_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000;

function chromiumMicros(value: string): number {
  return Date.parse(value) * 1_000 + CHROMIUM_EPOCH_OFFSET_MICROS;
}

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

describe('ChromiumReader', () => {
  it('maps every Chromium visit instead of collapsing repeated URLs', async () => {
    const db = await chromiumFixture([
      { id: 7, urlId: 1, visitTime: chromiumMicros('2026-08-03T10:00:00Z') },
      { id: 8, urlId: 1, visitTime: chromiumMicros('2026-08-03T10:05:00Z') },
    ]);

    const visits = new ChromiumReader().read(db, chromeProfile());

    expect(visits.map((item) => item.sourceVisitId)).toEqual(['7', '8']);
    expect(visits.map((item) => item.url)).toEqual([
      'https://example.com',
      'https://example.com',
    ]);
    db.close();
  });

  it('converts timestamps and preserves profile metadata and an empty title', async () => {
    const db = await chromiumFixture([
      { id: 7, urlId: 1, visitTime: chromiumMicros('2026-08-03T10:00:00Z') },
    ], { title: null });

    expect(new ChromiumReader().read(db, chromeProfile())).toEqual([{
      sourceKey: 'chrome:profile',
      sourceVisitId: '7',
      browserId: 'chrome',
      browserName: 'Google Chrome',
      profileId: 'Default',
      profileName: 'Personal',
      visitedAt: new Date('2026-08-03T10:00:00Z'),
      title: '',
      url: 'https://example.com',
    }]);
    db.close();
  });

  it('queries with a two-minute inclusive overlap and deterministic numeric ID ordering', async () => {
    const db = await chromiumFixture([
      { id: 10, urlId: 1, visitTime: chromiumMicros('2026-08-03T10:03:00Z') },
      { id: 2, urlId: 1, visitTime: chromiumMicros('2026-08-03T10:03:00Z') },
      { id: 1, urlId: 1, visitTime: chromiumMicros('2026-08-03T10:02:59Z') },
    ]);

    const visits = new ChromiumReader().read(db, chromeProfile(), {
      visitedAtMs: Date.parse('2026-08-03T10:05:00Z'),
      sourceVisitId: '99',
    });

    expect(visits.map((item) => item.sourceVisitId)).toEqual(['2', '10']);
    db.close();
  });

  it('recovers a higher visit ID even when its corrected timestamp predates the overlap', async () => {
    const db = await chromiumFixture([
      { id: 6, urlId: 1, visitTime: chromiumMicros('2026-08-03T09:00:00Z') },
      { id: 8, urlId: 1, visitTime: chromiumMicros('2026-08-03T09:00:00Z') },
    ]);

    const visits = new ChromiumReader().read(db, chromeProfile(), {
      visitedAtMs: Date.parse('2026-08-03T10:05:00Z'),
      sourceVisitId: '7',
    });

    expect(visits.map((item) => item.sourceVisitId)).toEqual(['8']);
    db.close();
  });

  it('skips corrupt timestamps without discarding healthy rows', async () => {
    const now = Date.parse('2026-08-03T12:00:00Z');
    const db = await chromiumFixture([
      { id: 1, urlId: 1, visitTime: CHROMIUM_EPOCH_OFFSET_MICROS - 1_000 },
      { id: 2, urlId: 1, visitTime: chromiumMicros('2030-01-01T00:00:00Z') },
      { id: 3, urlId: 1, visitTime: chromiumMicros('2026-08-03T10:00:00Z') },
    ]);

    expect(new ChromiumReader(() => now).read(db, chromeProfile())
      .map((item) => item.sourceVisitId)).toEqual(['3']);
    db.close();
  });

  it('keeps valid microseconds below Date precision and rejects NULL timestamps', async () => {
    const db = await sqliteFixture([
      'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT)',
      'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time)',
      "INSERT INTO urls VALUES (1, 'https://example.com', 'Example')",
    ]);
    db.run('INSERT INTO visits VALUES (1, 1, :time)', {
      ':time': chromiumMicros('2026-08-03T10:00:00Z') + 123,
    });
    db.run('INSERT INTO visits VALUES (2, 1, NULL)');

    expect(new ChromiumReader(() => Date.parse('2026-08-04T00:00:00Z'))
      .read(db, chromeProfile()).map((item) => item.sourceVisitId)).toEqual(['1']);
    db.close();
  });

  it('rejects a missing required column with a clear schema error', async () => {
    const db = await sqliteFixture([
      'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT)',
      'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER)',
    ]);

    expect(() => new ChromiumReader().read(db, chromeProfile()))
      .toThrow('Unsupported Chromium history schema');
    db.close();
  });
});
