import type { BrowserId, NormalizedVisit } from '../domain';
import { formatLocalIsoTimestamp, stableVisitId } from './markdown';

export type HistorySourceFormat =
  | 'obsidian_browser_sync_browser_database'
  | 'obsidian_browser_sync_markdown'
  | 'obsidian_browser_sync_csv'
  | 'obsidian_browser_sync_json'
  | 'obsidian_browser_sync_mixed';

export type VisitRepresentation = 'markdown_link' | 'inert_text';

export interface BrowserHistorySync {
  namespace: 'obsidian-browser-sync';
  browser: BrowserId;
  id: string;
}

export interface BrowserHistoryRecord {
  timestamp: string;
  title: string;
  url: string;
  browser: string;
  profile: string;
  representation: VisitRepresentation;
  original_title?: string;
  sync?: BrowserHistorySync;
}

export interface BrowserHistoryDocument {
  schema_version: 1;
  type: 'browser_history';
  metadata: {
    browser_sync: true;
    period: string;
    heading: 'Browser history';
    source_format: HistorySourceFormat;
  };
  records: BrowserHistoryRecord[];
}

export interface ManagedDocumentParse {
  document: BrowserHistoryDocument;
  hasUnrecognizedContent: boolean;
}

const browserIds = new Set<BrowserId>([
  'safari',
  'firefox',
  'chrome',
  'edge',
  'brave',
  'chromium',
  'vivaldi',
]);

const sourceFormats = new Set<HistorySourceFormat>([
  'obsidian_browser_sync_browser_database',
  'obsidian_browser_sync_markdown',
  'obsidian_browser_sync_csv',
  'obsidian_browser_sync_json',
  'obsidian_browser_sync_mixed',
]);

const timestampPattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d[+-](?:[01]\d|2[0-3]):[0-5]\d$/;
const periodPattern = /^(?:\d{4}|\d{4}-(?:0[1-9]|1[0-2])|\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3]))$/;
const syncIdPattern = /^[a-f0-9]{24}$/;

export class ConflictingSyncIdError extends Error {
  constructor() {
    super('Conflicting browser history records share a sync ID');
    this.name = 'ConflictingSyncIdError';
  }
}

export function normalizeCanonicalText(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
      ? ' '
      : character;
  }).join('').replace(/\s+/g, ' ').trim();
}

export function recordFromVisit(visit: NormalizedVisit): BrowserHistoryRecord {
  return {
    timestamp: formatLocalIsoTimestamp(visit.visitedAt),
    title: normalizeCanonicalText(visit.title),
    url: visit.url,
    browser: normalizeCanonicalText(visit.browserName),
    profile: normalizeCanonicalText(visit.profileName),
    representation: representationForUrl(visit.url),
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: visit.browserId,
      id: stableVisitId(visit),
    },
  };
}

export function validateBrowserHistoryRecord(value: unknown): BrowserHistoryRecord {
  if (!isPlainObject(value)) {
    throw new Error('Browser history record must be an object');
  }
  assertOnlyKeys(value, [
    'timestamp', 'title', 'url', 'browser', 'profile', 'representation', 'original_title', 'sync',
  ], 'Browser history record');
  assertString(value.timestamp, 'record.timestamp');
  assertTimestamp(value.timestamp);
  assertString(value.title, 'record.title');
  assertString(value.url, 'record.url');
  assertString(value.browser, 'record.browser');
  assertString(value.profile, 'record.profile');
  if (value.representation !== 'markdown_link' && value.representation !== 'inert_text') {
    throw new Error('record.representation is invalid');
  }
  if (value.original_title !== undefined) {
    assertString(value.original_title, 'record.original_title');
  }

  const record: BrowserHistoryRecord = {
    timestamp: value.timestamp,
    title: value.title,
    url: value.url,
    browser: value.browser,
    profile: value.profile,
    representation: value.representation,
  };
  if (value.original_title !== undefined) {
    record.original_title = value.original_title;
  }
  if (value.sync !== undefined) {
    record.sync = validateBrowserHistorySync(value.sync);
  }
  return record;
}

export function validateBrowserHistoryDocument(value: unknown): BrowserHistoryDocument {
  if (!isPlainObject(value)) {
    throw new Error('Browser history document must be an object');
  }
  assertOnlyKeys(value, ['schema_version', 'type', 'metadata', 'records'], 'Browser history document');
  if (value.schema_version !== 1) {
    throw new Error('schema_version must be 1');
  }
  if (value.type !== 'browser_history') {
    throw new Error('type must be browser_history');
  }
  const metadata = validateMetadata(value.metadata);
  if (!Array.isArray(value.records)) {
    throw new Error('records must be an array');
  }
  const records = value.records.map((record) => validateBrowserHistoryRecord(record));
  assertNoConflictingSyncRecords(records);
  return {
    schema_version: 1,
    type: 'browser_history',
    metadata,
    records,
  };
}

export function compareHistoryRecords(left: BrowserHistoryRecord, right: BrowserHistoryRecord): number {
  const instantDifference = Date.parse(left.timestamp) - Date.parse(right.timestamp);
  if (instantDifference !== 0) {
    return instantDifference;
  }
  const timestampDifference = compareText(left.timestamp, right.timestamp);
  if (timestampDifference !== 0) {
    return timestampDifference;
  }
  return compareText(sortKey(left), sortKey(right));
}

export function reconcileRecords(documents: BrowserHistoryRecord[][]): BrowserHistoryRecord[] {
  const syncRecords = new Map<string, BrowserHistoryRecord>();
  const legacyRecords = new Map<string, { record: BrowserHistoryRecord; count: number }>();

  for (const records of documents) {
    const documentCounts = new Map<string, number>();
    const documentLegacyRecords = new Map<string, BrowserHistoryRecord>();
    for (const input of records) {
      const record = validateBrowserHistoryRecord(input);
      if (record.sync) {
        const existing = syncRecords.get(record.sync.id);
        if (existing && semanticRecordKey(existing) !== semanticRecordKey(record)) {
          throw new ConflictingSyncIdError();
        }
        syncRecords.set(record.sync.id, existing ?? record);
        continue;
      }
      const fingerprint = canonicalFingerprint(record);
      documentCounts.set(fingerprint, (documentCounts.get(fingerprint) ?? 0) + 1);
      documentLegacyRecords.set(fingerprint, record);
    }
    for (const [fingerprint, count] of documentCounts) {
      const existing = legacyRecords.get(fingerprint);
      if (!existing || count > existing.count) {
        legacyRecords.set(fingerprint, {
          record: documentLegacyRecords.get(fingerprint) as BrowserHistoryRecord,
          count,
        });
      }
    }
  }

  const reconciled = [
    ...syncRecords.values(),
    ...[...legacyRecords.values()].flatMap(({ record, count }) =>
      Array.from({ length: count }, () => record)),
  ];
  return reconciled.sort(compareHistoryRecords);
}

export function canonicalFingerprint(record: BrowserHistoryRecord): string {
  return JSON.stringify([
    record.timestamp,
    record.title,
    record.url,
    record.browser,
    record.profile,
    record.representation,
    record.original_title ?? null,
  ]);
}

function validateBrowserHistorySync(value: unknown): BrowserHistorySync {
  if (!isPlainObject(value)) {
    throw new Error('record.sync must be an object');
  }
  assertOnlyKeys(value, ['namespace', 'browser', 'id'], 'record.sync');
  if (value.namespace !== 'obsidian-browser-sync') {
    throw new Error('record.sync.namespace is invalid');
  }
  if (typeof value.browser !== 'string' || !browserIds.has(value.browser as BrowserId)) {
    throw new Error('record.sync.browser is invalid');
  }
  if (typeof value.id !== 'string' || !syncIdPattern.test(value.id)) {
    throw new Error('record.sync.id is invalid');
  }
  return {
    namespace: 'obsidian-browser-sync',
    browser: value.browser as BrowserId,
    id: value.id,
  };
}

function validateMetadata(value: unknown): BrowserHistoryDocument['metadata'] {
  if (!isPlainObject(value)) {
    throw new Error('metadata must be an object');
  }
  assertOnlyKeys(value, ['browser_sync', 'period', 'heading', 'source_format'], 'metadata');
  if (value.browser_sync !== true) {
    throw new Error('metadata.browser_sync must be true');
  }
  if (typeof value.period !== 'string' || !isValidPeriod(value.period)) {
    throw new Error('metadata.period is invalid');
  }
  if (value.heading !== 'Browser history') {
    throw new Error('metadata.heading is invalid');
  }
  if (typeof value.source_format !== 'string' || !sourceFormats.has(value.source_format as HistorySourceFormat)) {
    throw new Error('metadata.source_format is invalid');
  }
  return {
    browser_sync: true,
    period: value.period,
    heading: 'Browser history',
    source_format: value.source_format as HistorySourceFormat,
  };
}

function representationForUrl(value: string): VisitRepresentation {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? 'markdown_link'
      : 'inert_text';
  } catch {
    return 'inert_text';
  }
}

function assertTimestamp(value: string): void {
  if (!timestampPattern.test(value)
    || !hasValidCalendarDate(value.slice(0, 10))
    || !Number.isFinite(Date.parse(value))) {
    throw new Error('record.timestamp must be a full local ISO timestamp');
  }
}

function isValidPeriod(value: string): boolean {
  if (!periodPattern.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  if (year < 1000) {
    return false;
  }
  if (value.includes('-W')) {
    const week = Number(value.slice(6, 8));
    return week <= isoWeeksInYear(year);
  }
  return value.length !== 10 || hasValidCalendarDate(value);
}

function isoWeeksInYear(year: number): 52 | 53 {
  const januaryFirst = new Date(Date.UTC(year, 0, 1)).getUTCDay() || 7;
  return januaryFirst === 4 || (januaryFirst === 3 && isLeapYear(year))
    ? 53
    : 52;
}

function hasValidCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  context: string,
): void {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new Error(`${context} contains unrecognized fields`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function semanticRecordKey(record: BrowserHistoryRecord): string {
  return JSON.stringify([
    canonicalFingerprint(record),
    record.sync?.namespace ?? null,
    record.sync?.browser ?? null,
  ]);
}

function assertNoConflictingSyncRecords(records: BrowserHistoryRecord[]): void {
  const semanticRecords = new Map<string, string>();
  for (const record of records) {
    if (!record.sync) {
      continue;
    }
    const semantic = semanticRecordKey(record);
    const existing = semanticRecords.get(record.sync.id);
    if (existing !== undefined && existing !== semantic) {
      throw new ConflictingSyncIdError();
    }
    semanticRecords.set(record.sync.id, semantic);
  }
}

function sortKey(record: BrowserHistoryRecord): string {
  return record.sync?.id ?? canonicalFingerprint(record);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
