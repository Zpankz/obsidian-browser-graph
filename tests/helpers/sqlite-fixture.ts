import path from 'node:path';
import initSqlJs from 'sql.js';
import type { SqliteDatabase } from '../../src/sql/sqlite';

type SqlValue = string | number | Uint8Array | null;

export interface FixtureDatabase extends SqliteDatabase {
  run(sql: string, params?: Record<string, SqlValue>): void;
}

let runtime: Promise<initSqlJs.SqlJsStatic> | undefined;

export async function sqliteFixture(schema: readonly string[]): Promise<FixtureDatabase> {
  runtime ??= initSqlJs({
    locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
  });
  const sql = await runtime;
  const database = new sql.Database();
  for (const statement of schema) {
    database.run(statement);
  }

  return {
    all<T extends Record<string, unknown>>(
      query: string,
      params?: Record<string, string | number>,
    ): T[] {
      const statement = database.prepare(query, params);
      try {
        const rows: T[] = [];
        while (statement.step()) {
          rows.push(statement.getAsObject() as T);
        }
        return rows;
      } finally {
        statement.free();
      }
    },
    close: () => database.close(),
    hasTable(name: string) {
      const result = database.exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :name",
        { ':name': name },
      );
      return result.length > 0 && result[0].values.length > 0;
    },
    run(query: string, params?: Record<string, SqlValue>) {
      database.run(query, params);
    },
  };
}

export interface ChromiumVisitRow {
  id: number;
  urlId: number;
  visitTime: number;
}

export async function chromiumFixture(
  visits: readonly ChromiumVisitRow[],
  page: { id?: number; title?: string | null; url?: string } = {},
): Promise<FixtureDatabase> {
  const database = await sqliteFixture([
    'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT)',
    'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL)',
  ]);
  database.run(
    'INSERT INTO urls (id, url, title) VALUES (:id, :url, :title)',
    {
      ':id': page.id ?? 1,
      ':url': page.url ?? 'https://example.com',
      ':title': page.title === undefined ? 'Example' : page.title,
    },
  );
  for (const visit of visits) {
    database.run(
      'INSERT INTO visits (id, url, visit_time) VALUES (:id, :url, :visit_time)',
      { ':id': visit.id, ':url': visit.urlId, ':visit_time': visit.visitTime },
    );
  }
  return database;
}

export interface FirefoxVisitRow {
  id: number;
  placeId: number;
  visitDate: number;
}

export async function firefoxFixture(
  visits: readonly FirefoxVisitRow[],
  page: { id?: number; title?: string | null; url?: string } = {},
): Promise<FixtureDatabase> {
  const database = await sqliteFixture([
    'CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT)',
    'CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER NOT NULL, visit_date INTEGER NOT NULL)',
  ]);
  database.run(
    'INSERT INTO moz_places (id, url, title) VALUES (:id, :url, :title)',
    {
      ':id': page.id ?? 1,
      ':url': page.url ?? 'https://example.com',
      ':title': page.title === undefined ? 'Example' : page.title,
    },
  );
  for (const visit of visits) {
    database.run(
      'INSERT INTO moz_historyvisits (id, place_id, visit_date) VALUES (:id, :place_id, :visit_date)',
      { ':id': visit.id, ':place_id': visit.placeId, ':visit_date': visit.visitDate },
    );
  }
  return database;
}

export interface SafariVisitRow {
  id: number;
  historyItem: number;
  visitTime: number;
}

export async function safariFixture(
  visits: readonly SafariVisitRow[],
  page: { id?: number; title?: string | null; url?: string } = {},
): Promise<FixtureDatabase> {
  const database = await sqliteFixture([
    'CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL)',
    'CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER NOT NULL, visit_time REAL NOT NULL, title TEXT)',
  ]);
  database.run(
    'INSERT INTO history_items (id, url) VALUES (:id, :url)',
    {
      ':id': page.id ?? 1,
      ':url': page.url ?? 'https://example.com',
    },
  );
  for (const visit of visits) {
    database.run(
      'INSERT INTO history_visits (id, history_item, visit_time, title) VALUES (:id, :history_item, :visit_time, :title)',
      {
        ':id': visit.id,
        ':history_item': visit.historyItem,
        ':visit_time': visit.visitTime,
        ':title': page.title === undefined ? 'Example' : page.title,
      },
    );
  }
  return database;
}
