import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '../../src/domain';
import { SafariReader } from '../../src/browsers/safari';
import { safariFixture, sqliteFixture } from '../helpers/sqlite-fixture';

const SAFARI_EPOCH_OFFSET_SECONDS = 978_307_200;

function safariSeconds(value: string): number {
  return Date.parse(value) / 1_000 - SAFARI_EPOCH_OFFSET_SECONDS;
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

describe('SafariReader', () => {
  it('maps every Safari visit instead of collapsing repeated URLs', async () => {
    const db = await safariFixture([
      { id: 7, historyItem: 1, visitTime: safariSeconds('2026-08-03T10:00:00Z') },
      { id: 8, historyItem: 1, visitTime: safariSeconds('2026-08-03T10:05:00Z') },
    ]);

    const visits = new SafariReader().read(db, safariProfile());

    expect(visits.map((item) => item.sourceVisitId)).toEqual(['7', '8']);
    expect(visits.map((item) => item.url)).toEqual([
      'https://example.com',
      'https://example.com',
    ]);
    db.close();
  });

  it('converts timestamps and preserves profile metadata and an empty title', async () => {
    const db = await safariFixture([
      { id: 7, historyItem: 1, visitTime: safariSeconds('2026-08-03T10:00:00Z') },
    ], { title: null });

    expect(new SafariReader().read(db, safariProfile())).toEqual([{
      sourceKey: 'safari:profile',
      sourceVisitId: '7',
      browserId: 'safari',
      browserName: 'Safari',
      profileId: 'History',
      profileName: 'History',
      visitedAt: new Date('2026-08-03T10:00:00Z'),
      title: '',
      url: 'https://example.com',
    }]);
    db.close();
  });

  it('queries with a two-minute inclusive overlap and deterministic numeric ID ordering', async () => {
    const db = await safariFixture([
      { id: 10, historyItem: 1, visitTime: safariSeconds('2026-08-03T10:03:00Z') },
      { id: 2, historyItem: 1, visitTime: safariSeconds('2026-08-03T10:03:00Z') },
      { id: 1, historyItem: 1, visitTime: safariSeconds('2026-08-03T10:02:59Z') },
    ]);

    const visits = new SafariReader().read(db, safariProfile(), {
      visitedAtMs: Date.parse('2026-08-03T10:05:00Z'),
      sourceVisitId: '99',
    });

    expect(visits.map((item) => item.sourceVisitId)).toEqual(['2', '10']);
    db.close();
  });

  it('rejects a missing required column with a clear schema error', async () => {
    const db = await sqliteFixture([
      'CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT)',
      'CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, title TEXT)',
    ]);

    expect(() => new SafariReader().read(db, safariProfile()))
      .toThrow('Unsupported Safari history schema');
    db.close();
  });
});
