import esbuild from 'esbuild';
import { copyFile } from 'node:fs/promises';

const isProduction = process.argv[2] === 'production';
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron'],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
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
