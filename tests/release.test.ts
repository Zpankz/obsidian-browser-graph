import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';

const RELEASE_ARTIFACTS = [
  'main.js',
  'manifest.json',
  'styles.css',
  'sql-wasm.wasm',
] as const;

interface StagedSqliteDatabase {
  all<T extends Record<string, unknown>>(sql: string): T[];
  close(): void;
}

interface StagedBundle {
  createSqliteFactory(installedPluginDirectory: string): {
    open(databasePath: string): Promise<StagedSqliteDatabase>;
  };
}

const localRequire = createRequire(import.meta.url);
const builtinSpecifiers = new Set(builtinModules.flatMap((moduleName) => [
  moduleName,
  `node:${moduleName}`,
]));

function allowedExternal(specifier: string): boolean {
  return specifier === 'obsidian'
    || specifier === 'electron'
    || specifier.startsWith('@codemirror/')
    || specifier.startsWith('@lezer/')
    || builtinSpecifiers.has(specifier);
}

function obsidianHostStub(): Record<string, unknown> {
  return {
    FileSystemAdapter: class {},
    Notice: class {},
    Plugin: class {},
    PluginSettingTab: class {},
    Setting: class {},
    TFile: class {},
    TFolder: class {},
    normalizePath: (value: string) => value,
  };
}

function loadStagedBundle(bundlePath: string, source: string): StagedBundle {
  const commonJsModule: { exports: unknown } = { exports: {} };
  const guardedRequire = (specifier: string): unknown => {
    if (!allowedExternal(specifier)) {
      throw new Error(`Unexpected production dependency: ${specifier}`);
    }
    if (specifier === 'obsidian') {
      return obsidianHostStub();
    }
    if (
      specifier === 'electron'
      || specifier.startsWith('@codemirror/')
      || specifier.startsWith('@lezer/')
    ) {
      return {};
    }
    return localRequire(specifier);
  };
  const wrapper = runInNewContext(
    `(function (exports, require, module, __filename, __dirname) { ${source}\n})`,
    {
      Buffer,
      TextDecoder,
      TextEncoder,
      URL,
      WebAssembly,
      clearTimeout,
      console,
      crypto: globalThis.crypto,
      performance,
      process,
      setTimeout,
    },
  ) as (
    exports: unknown,
    require: (specifier: string) => unknown,
    module: { exports: unknown },
    filename: string,
    dirname: string,
  ) => void;
  wrapper(
    commonJsModule.exports,
    guardedRequire,
    commonJsModule,
    bundlePath,
    path.dirname(bundlePath),
  );
  return commonJsModule.exports as StagedBundle;
}

describe('release bundle', () => {
  it('runs as the exact source-independent desktop release', async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), 'obsidian-browser-sync-release-'),
    );
    const releaseDirectory = path.join(temporaryRoot, 'obsidian-browser-sync');

    try {
      await mkdir(releaseDirectory);
      await Promise.all(RELEASE_ARTIFACTS.map((artifact) =>
        copyFile(artifact, path.join(releaseDirectory, artifact))));

      expect((await readdir(releaseDirectory)).sort())
        .toEqual([...RELEASE_ARTIFACTS].sort());
      for (const artifact of RELEASE_ARTIFACTS) {
        expect((await stat(path.join(releaseDirectory, artifact))).size)
          .toBeGreaterThan(0);
      }

      const manifest = JSON.parse(await readFile(
        path.join(releaseDirectory, 'manifest.json'),
        'utf8',
      ));
      const versions = JSON.parse(await readFile('versions.json', 'utf8'));
      expect(manifest).toMatchObject({
        id: 'obsidian-browser-sync',
        isDesktopOnly: true,
        minAppVersion: '1.13.0',
      });
      expect(versions[manifest.version]).toBe(manifest.minAppVersion);

      const bundlePath = path.join(releaseDirectory, 'main.js');
      const bundle = await readFile(bundlePath, 'utf8');
      const externalSpecifiers = [...bundle.matchAll(
        /\brequire\((['"])([^'"]+)\1\)/g,
      )].map((match) => match[2]);
      expect(externalSpecifiers.length).toBeGreaterThan(0);
      expect([...new Set(externalSpecifiers)].filter(
        (specifier) => !allowedExternal(specifier),
      )).toEqual([]);
      expect(externalSpecifiers).not.toContain('sql.js');
      expect(bundle).not.toMatch(/node_modules[\\/]/);
      expect(bundle).toContain('sql-wasm.wasm');
      expect(bundle).not.toContain('sql-wasm-browser.wasm');

      const fixtureRuntime = await initSqlJs({
        locateFile: (file) => path.join(
          process.cwd(),
          'node_modules/sql.js/dist',
          file,
        ),
      });
      const fixture = new fixtureRuntime.Database();
      fixture.run('CREATE TABLE release_check (id INTEGER, value TEXT)');
      fixture.run("INSERT INTO release_check VALUES (7, 'staged wasm works')");
      const fixturePath = path.join(temporaryRoot, 'fixture.sqlite');
      await writeFile(fixturePath, fixture.export());
      fixture.close();

      const stagedBundle = loadStagedBundle(bundlePath, bundle);
      expect(typeof stagedBundle.createSqliteFactory).toBe('function');
      const database = await stagedBundle
        .createSqliteFactory(releaseDirectory)
        .open(fixturePath);
      const rows = database.all(
        'SELECT id, value FROM release_check ORDER BY id',
      );
      expect(JSON.parse(JSON.stringify(rows))).toEqual([
        { id: 7, value: 'staged wasm works' },
      ]);
      database.close();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
