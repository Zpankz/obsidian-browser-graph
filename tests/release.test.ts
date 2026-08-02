import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('release bundle', () => {
  it('builds the complete desktop-only release', async () => {
    const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
    expect(manifest.id).toBe('obsidian-browser-sync');
    expect(manifest.isDesktopOnly).toBe(true);
    for (const artifact of ['main.js', 'manifest.json', 'styles.css', 'sql-wasm.wasm']) {
      expect((await stat(artifact)).size).toBeGreaterThan(0);
    }

    const bundle = await readFile('main.js', 'utf8');
    expect(bundle).toContain('sql-wasm.wasm');
    expect(bundle).not.toContain('sql-wasm-browser.wasm');
  });
});
