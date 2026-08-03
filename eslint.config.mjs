import js from '@eslint/js';
import globals from 'globals';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['main.js', 'node_modules/', 'coverage/', '.obsidian/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: { obsidianmd },
  },
);
