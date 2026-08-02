import esbuild from 'esbuild';
import { copyFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';

const isProduction = process.argv[2] === 'production';
const nodeBuiltins = builtinModules.flatMap((moduleName) => [
  moduleName,
  `node:${moduleName}`,
]);
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
  outfile: 'main.js',
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
  await copyFile('node_modules/sql.js/dist/sql-wasm.wasm', 'sql-wasm.wasm');
} else {
  await context.watch();
}
