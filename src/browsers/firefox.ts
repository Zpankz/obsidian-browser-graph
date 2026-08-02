import type { BrowserProfile, NormalizedVisit, ProfileCursor } from '../domain';
import type { SqliteDatabase } from '../sql/sqlite';
import {
  CURSOR_OVERLAP_MS,
  type BrowserHistoryReader,
  normalizeVisit,
  sortVisits,
  validateSchema,
} from './reader';

interface FirefoxVisitRow extends Record<string, unknown> {
  sourceVisitId: number | string;
  title: string | null;
  url: string;
  visitDate: number;
}

export class FirefoxReader implements BrowserHistoryReader {
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
      ${since === undefined ? '' : 'WHERE moz_historyvisits.visit_date >= :since'}
    `, since === undefined ? undefined : { ':since': since });

    return sortVisits(rows.map((row) => normalizeVisit(
      profile,
      row.sourceVisitId,
      Number(row.visitDate) / 1_000,
      row.title,
      row.url,
    )));
  }
}
