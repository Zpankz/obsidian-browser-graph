import type { BrowserProfile, NormalizedVisit, ProfileCursor } from '../domain';
import type { SqliteDatabase } from '../sql/sqlite';
import {
  CURSOR_OVERLAP_MS,
  type BrowserHistoryReader,
  normalizeVisit,
  presentVisits,
  sortVisits,
  validateSchema,
} from './reader';

const CHROMIUM_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000;

interface ChromiumVisitRow extends Record<string, unknown> {
  sourceVisitId: number | string;
  title: string | null;
  url: string;
  visitTime: unknown;
}

export class ChromiumReader implements BrowserHistoryReader {
  constructor(private readonly now: () => number = Date.now) {}

  read(
    db: SqliteDatabase,
    profile: BrowserProfile,
    cursor?: ProfileCursor,
  ): NormalizedVisit[] {
    validateSchema(db, 'Chromium', {
      urls: ['id', 'url', 'title'],
      visits: ['id', 'url', 'visit_time'],
    });

    const since = cursor
      ? (cursor.visitedAtMs - CURSOR_OVERLAP_MS) * 1_000 + CHROMIUM_EPOCH_OFFSET_MICROS
      : undefined;
    const rows = db.all<ChromiumVisitRow>(`
      SELECT visits.id AS sourceVisitId,
             visits.visit_time AS visitTime,
             urls.title AS title,
             urls.url AS url
      FROM visits
      INNER JOIN urls ON urls.id = visits.url
      ${since === undefined ? '' : `WHERE (
        visits.visit_time >= :since
        OR visits.id > CAST(:sourceVisitId AS INTEGER)
      )`}
      ORDER BY visits.visit_time ASC, visits.id ASC
    `, since === undefined ? undefined : {
      ':since': since,
      ':sourceVisitId': cursor?.sourceVisitId ?? '0',
    });

    return sortVisits(presentVisits(rows.map((row) => normalizeVisit(
      profile,
      row.sourceVisitId,
      typeof row.visitTime === 'number'
        ? (row.visitTime - CHROMIUM_EPOCH_OFFSET_MICROS) / 1_000
        : Number.NaN,
      row.title,
      row.url,
      this.now(),
    ))));
  }
}
