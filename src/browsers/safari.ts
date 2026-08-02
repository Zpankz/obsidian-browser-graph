import type { BrowserProfile, NormalizedVisit, ProfileCursor } from '../domain';
import type { SqliteDatabase } from '../sql/sqlite';
import {
  CURSOR_OVERLAP_MS,
  type BrowserHistoryReader,
  normalizeVisit,
  sortVisits,
  validateSchema,
} from './reader';

const SAFARI_EPOCH_OFFSET_SECONDS = 978_307_200;

interface SafariVisitRow extends Record<string, unknown> {
  sourceVisitId: number | string;
  title: string | null;
  url: string;
  visitTime: number;
}

export class SafariReader implements BrowserHistoryReader {
  read(
    db: SqliteDatabase,
    profile: BrowserProfile,
    cursor?: ProfileCursor,
  ): NormalizedVisit[] {
    validateSchema(db, 'Safari', {
      history_items: ['id', 'url'],
      history_visits: ['id', 'history_item', 'visit_time', 'title'],
    });

    const since = cursor
      ? (cursor.visitedAtMs - CURSOR_OVERLAP_MS) / 1_000 - SAFARI_EPOCH_OFFSET_SECONDS
      : undefined;
    const rows = db.all<SafariVisitRow>(`
      SELECT history_visits.id AS sourceVisitId,
             history_visits.visit_time AS visitTime,
             history_visits.title AS title,
             history_items.url AS url
      FROM history_visits
      INNER JOIN history_items ON history_items.id = history_visits.history_item
      ${since === undefined ? '' : 'WHERE history_visits.visit_time >= :since'}
    `, since === undefined ? undefined : { ':since': since });

    return sortVisits(rows.map((row) => normalizeVisit(
      profile,
      row.sourceVisitId,
      (Number(row.visitTime) + SAFARI_EPOCH_OFFSET_SECONDS) * 1_000,
      row.title,
      row.url,
    )));
  }
}
