import { readFile } from 'node:fs/promises';
import path from 'node:path';
import initSqlJs from 'sql.js';

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
}

const runtimeDependencies: SqliteRuntimeDependencies = { initialize: initSqlJs, readFile };

export function createSqliteFactory(
  installedPluginDirectory: string,
  dependencies: SqliteRuntimeDependencies = runtimeDependencies,
): SqliteFactory {
  let runtime: Promise<initSqlJs.SqlJsStatic> | undefined;
  const initializeRuntime = async (): Promise<initSqlJs.SqlJsStatic> => {
    const wasmPath = path.join(installedPluginDirectory, 'sql-wasm.wasm');
    const wasmContents = await dependencies.readFile(wasmPath);
    return dependencies.initialize({
      locateFile: (file) => path.join(installedPluginDirectory, file),
      wasmBinary: Uint8Array.from(wasmContents).buffer,
    });
  };

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
