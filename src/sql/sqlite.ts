import { readFile } from 'node:fs/promises';
import initSqlJs from 'sql.js';
import embeddedSqlWasm from './embedded-wasm';

export interface SqliteDatabase {
  all<T extends Record<string, unknown>>(
    sql: string,
    params?: Record<string, string | number>,
  ): T[];
  hasTable(name: string): boolean;
  close(): void;
}

export interface SqliteFactory {
  open(databasePath: string): Promise<SqliteDatabase>;
}

export interface SqliteRuntimeDependencies {
  initialize: typeof initSqlJs;
  readFile(path: string): Promise<Uint8Array>;
  wasmBinary: Uint8Array;
}

const runtimeDependencies: SqliteRuntimeDependencies = {
  initialize: initSqlJs,
  readFile,
  wasmBinary: embeddedSqlWasm,
};

export function createSqliteFactory(
  dependencies: SqliteRuntimeDependencies = runtimeDependencies,
): SqliteFactory {
  let runtime: Promise<initSqlJs.SqlJsStatic> | undefined;
  const initializeRuntime = async (): Promise<initSqlJs.SqlJsStatic> =>
    dependencies.initialize({
      wasmBinary: Uint8Array.from(dependencies.wasmBinary).buffer,
    });

  return {
    async open(databasePath) {
      runtime ??= initializeRuntime();
      const [sql, contents] = await Promise.all([
        runtime,
        dependencies.readFile(databasePath),
      ]);
      return new SqlJsDatabase(new sql.Database(contents));
    },
  };
}

class SqlJsDatabase implements SqliteDatabase {
  constructor(private readonly database: initSqlJs.Database) {}

  all<T extends Record<string, unknown>>(
    sql: string,
    params?: Record<string, string | number>,
  ): T[] {
    const statement = this.database.prepare(sql, params);
    try {
      const rows: T[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as T);
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  hasTable(name: string): boolean {
    return this.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = :name LIMIT 1",
      { ':name': name },
    ).length > 0;
  }

  close(): void {
    this.database.close();
  }
}
