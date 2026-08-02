import path from 'node:path';
import initSqlJs from 'sql.js';
import { describe, expect, it, vi } from 'vitest';
import { createSqliteFactory } from '../../src/sql/sqlite';

describe('createSqliteFactory', () => {
  it('initializes sql.js once using the WASM asset in the supplied plugin directory', async () => {
    const fixtureSql = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });
    const fixture = new fixtureSql.Database();
    fixture.run('CREATE TABLE visits (id INTEGER PRIMARY KEY, title TEXT)');
    fixture.run("INSERT INTO visits (id, title) VALUES (1, 'First')");
    const bytes = fixture.export();
    fixture.close();
    const wasmBytes = new Uint8Array([0, 97, 115, 109]);

    const initialize = vi.fn(async (config?: initSqlJs.SqlJsConfig) => {
      expect(config?.locateFile?.('sql-wasm.wasm', '')).toBe('/installed/plugin/sql-wasm.wasm');
      expect(new Uint8Array(config?.wasmBinary ?? new ArrayBuffer(0)))
        .toEqual(wasmBytes);
      return fixtureSql;
    });
    const readFile = vi.fn(async (filePath: string) =>
      filePath.endsWith('sql-wasm.wasm') ? wasmBytes : bytes);
    const factory = createSqliteFactory('/installed/plugin', { initialize, readFile });

    const first = await factory.open('/tmp/one.sqlite');
    const second = await factory.open('/tmp/two.sqlite');

    expect(first.hasTable('visits')).toBe(true);
    expect(first.all<{ id: number; title: string }>(
      'SELECT id, title FROM visits WHERE id = :id',
      { ':id': 1 },
    )).toEqual([{ id: 1, title: 'First' }]);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(readFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      '/installed/plugin/sql-wasm.wasm',
      '/tmp/one.sqlite',
      '/tmp/two.sqlite',
    ]);
    first.close();
    second.close();
  });
});
