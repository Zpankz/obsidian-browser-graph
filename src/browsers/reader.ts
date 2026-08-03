import type { BrowserProfile, NormalizedVisit, ProfileCursor } from '../domain';
import type { SqliteDatabase } from '../sql/sqlite';

export const CURSOR_OVERLAP_MS = 120_000;
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

export interface BrowserHistoryReader {
  read(
    db: SqliteDatabase,
    profile: BrowserProfile,
    cursor?: ProfileCursor,
  ): NormalizedVisit[];
}

export function validateSchema(
  db: SqliteDatabase,
  browser: string,
  requirements: Readonly<Record<string, readonly string[]>>,
): void {
  const supported = Object.entries(requirements).every(([table, requiredColumns]) => {
    if (!db.hasTable(table)) {
      return false;
    }
    const quotedTable = table.replace(/"/g, '""');
    const columns = db.all<{ name: unknown }>(`PRAGMA table_info("${quotedTable}")`);
    const present = new Set(columns.map((column) => String(column.name)));
    return requiredColumns.every((column) => present.has(column));
  });

  if (!supported) {
    throw new Error(`Unsupported ${browser} history schema`);
  }
}

export function normalizeVisit(
  profile: BrowserProfile,
  sourceVisitId: unknown,
  visitedAtMs: number,
  title: unknown,
  url: unknown,
  nowMs = Date.now(),
): NormalizedVisit | undefined {
  if (!isSafeVisitTimestamp(visitedAtMs, nowMs)) {
    return undefined;
  }
  const normalizedTimestamp = new Date(visitedAtMs).getTime();
  return {
    sourceKey: profile.sourceKey,
    sourceVisitId: String(sourceVisitId),
    browserId: profile.browserId,
    browserName: profile.browserName,
    profileId: profile.profileId,
    profileName: profile.profileName,
    visitedAt: new Date(normalizedTimestamp),
    title: typeof title === 'string' ? title : '',
    url: typeof url === 'string' ? url : '',
  };
}

export function isSafeVisitTimestamp(
  value: unknown,
  nowMs = Date.now(),
): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_DATE_MS
    && Number.isFinite(new Date(value).getTime())
    && value <= nowMs + MAX_FUTURE_SKEW_MS;
}

export function presentVisits(
  visits: Array<NormalizedVisit | undefined>,
): NormalizedVisit[] {
  return visits.filter((visit): visit is NormalizedVisit => visit !== undefined);
}

export function sortVisits(visits: NormalizedVisit[]): NormalizedVisit[] {
  return visits.sort((left, right) => {
    const timeOrder = left.visitedAt.getTime() - right.visitedAt.getTime();
    if (timeOrder !== 0) {
      return timeOrder;
    }
    return compareSourceVisitIds(left.sourceVisitId, right.sourceVisitId);
  });
}

function compareSourceVisitIds(left: string, right: string): number {
  if (/^-?\d+$/.test(left) && /^-?\d+$/.test(right)) {
    return compareIntegerStrings(left, right);
  }
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareIntegerStrings(left: string, right: string): number {
  const leftInteger = canonicalInteger(left);
  const rightInteger = canonicalInteger(right);
  if (leftInteger.negative !== rightInteger.negative) {
    return leftInteger.negative ? -1 : 1;
  }

  const direction = leftInteger.negative ? -1 : 1;
  if (leftInteger.digits.length !== rightInteger.digits.length) {
    return (leftInteger.digits.length < rightInteger.digits.length ? -1 : 1) * direction;
  }
  if (leftInteger.digits < rightInteger.digits) {
    return -direction;
  }
  if (leftInteger.digits > rightInteger.digits) {
    return direction;
  }
  return 0;
}

function canonicalInteger(value: string): { digits: string; negative: boolean } {
  const negative = value.startsWith('-');
  const digits = value.slice(negative ? 1 : 0).replace(/^0+(?=\d)/, '');
  return { digits, negative: negative && digits !== '0' };
}
