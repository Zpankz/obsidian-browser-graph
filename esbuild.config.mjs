import esbuild from 'esbuild';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';

const isProduction = process.argv[2] === 'production';
const buildDirectory = 'build';
const releaseFiles = ['manifest.json', 'styles.css'];

if (isProduction) {
  await rm(buildDirectory, { recursive: true, force: true });
  await rm('main.js', { force: true });
}
await mkdir(buildDirectory, { recursive: true });
await Promise.all(releaseFiles.map((file) =>
  copyFile(file, path.join(buildDirectory, file))));

const nodeBuiltins = builtinModules.flatMap((moduleName) => [
  moduleName,
  `node:${moduleName}`,
]);
const embeddedWasmPlugin = {
  name: 'embedded-sql-wasm',
  setup(build) {
    build.onLoad({ filter: /[/\\]src[/\\]sql[/\\]embedded-wasm\.ts$/ }, async () => ({
      contents: await readFile('node_modules/sql.js/dist/sql-wasm.wasm'),
      loader: 'binary',
    }));
  },
};
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/*',
    '@lezer/*',
    ...nodeBuiltins,
  ],
  format: 'cjs',
  platform: 'node',
  target: 'es2021',
  logLevel: 'info',
  minify: isProduction,
  sourcemap: isProduction ? false : 'inline',
  treeShaking: true,
  plugins: [embeddedWasmPlugin],
  outfile: path.join(buildDirectory, 'main.js'),
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
  await rm(path.join(buildDirectory, 'sql-wasm.wasm'), { force: true });
} else {
  await context.watch();
}
