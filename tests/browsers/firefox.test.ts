import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '../../src/domain';
import { FirefoxReader } from '../../src/browsers/firefox';
import { firefoxFixture, sqliteFixture } from '../helpers/sqlite-fixture';

function firefoxMicros(value: string): number {
  return Date.parse(value) * 1_000;
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

describe('FirefoxReader', () => {
  it('maps every Firefox visit instead of collapsing repeated URLs', async () => {
    const db = await firefoxFixture([
      { id: 7, placeId: 1, visitDate: firefoxMicros('2026-08-03T10:00:00Z') },
      { id: 8, placeId: 1, visitDate: firefoxMicros('2026-08-03T10:05:00Z') },
    ]);

    const visits = new FirefoxReader().read(db, firefoxProfile());

    expect(visits.map((item) => item.sourceVisitId)).toEqual(['7', '8']);
    expect(visits.map((item) => item.url)).toEqual([
      'https://example.com',
      'https://example.com',
    ]);
    db.close();
  });

  it('converts timestamps and preserves profile metadata and an empty title', async () => {
    const db = await firefoxFixture([
      { id: 7, placeId: 1, visitDate: firefoxMicros('2026-08-03T10:00:00Z') },
    ], { title: null });

    expect(new FirefoxReader().read(db, firefoxProfile())).toEqual([{
      sourceKey: 'firefox:profile',
      sourceVisitId: '7',
      browserId: 'firefox',
      browserName: 'Firefox',
      profileId: 'abc.default-release',
      profileName: 'Work',
      visitedAt: new Date('2026-08-03T10:00:00Z'),
      title: '',
      url: 'https://example.com',
    }]);
    db.close();
  });

  it('queries with a two-minute inclusive overlap and deterministic numeric ID ordering', async () => {
    const db = await firefoxFixture([
      { id: 10, placeId: 1, visitDate: firefoxMicros('2026-08-03T10:03:00Z') },
      { id: 2, placeId: 1, visitDate: firefoxMicros('2026-08-03T10:03:00Z') },
      { id: 1, placeId: 1, visitDate: firefoxMicros('2026-08-03T10:02:59Z') },
    ]);

    const visits = new FirefoxReader().read(db, firefoxProfile(), {
      visitedAtMs: Date.parse('2026-08-03T10:05:00Z'),
      sourceVisitId: '99',
    });

    expect(visits.map((item) => item.sourceVisitId)).toEqual(['2', '10']);
    db.close();
  });

  it('rejects a missing required column with a clear schema error', async () => {
    const db = await sqliteFixture([
      'CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT)',
      'CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER)',
    ]);

    expect(() => new FirefoxReader().read(db, firefoxProfile()))
      .toThrow('Unsupported Firefox history schema');
    db.close();
  });
});
