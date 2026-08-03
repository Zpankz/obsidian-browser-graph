import esbuild from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';

const isProduction = process.argv[2] === 'production';
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
  outfile: 'main.js',
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
  await rm('sql-wasm.wasm', { force: true });
} else {
  await context.watch();
}
