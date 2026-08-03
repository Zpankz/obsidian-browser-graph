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

interface FirefoxVisitRow extends Record<string, unknown> {
  sourceVisitId: number | string;
  title: string | null;
  url: string;
  visitDate: unknown;
}

export class FirefoxReader implements BrowserHistoryReader {
  constructor(private readonly now: () => number = Date.now) {}

  read(
    db: SqliteDatabase,
    profile: BrowserProfile,
    cursor?: ProfileCursor,
  ): NormalizedVisit[] {
    validateSchema(db, 'Firefox', {
      moz_places: ['id', 'url', 'title'],
      moz_historyvisits: ['id', 'place_id', 'visit_date'],
    });

    const since = cursor
      ? (cursor.visitedAtMs - CURSOR_OVERLAP_MS) * 1_000
      : undefined;
    const rows = db.all<FirefoxVisitRow>(`
      SELECT moz_historyvisits.id AS sourceVisitId,
             moz_historyvisits.visit_date AS visitDate,
             moz_places.title AS title,
             moz_places.url AS url
      FROM moz_historyvisits
      INNER JOIN moz_places ON moz_places.id = moz_historyvisits.place_id
      ${since === undefined ? '' : `WHERE (
        moz_historyvisits.visit_date >= :since
        OR moz_historyvisits.id > CAST(:sourceVisitId AS INTEGER)
      )`}
      ORDER BY moz_historyvisits.visit_date ASC, moz_historyvisits.id ASC
    `, since === undefined ? undefined : {
      ':since': since,
      ':sourceVisitId': cursor?.sourceVisitId ?? '0',
    });

    return sortVisits(presentVisits(rows.map((row) => normalizeVisit(
      profile,
      row.sourceVisitId,
      typeof row.visitDate === 'number' ? row.visitDate / 1_000 : Number.NaN,
      row.title,
      row.url,
      this.now(),
    ))));
  }
}
