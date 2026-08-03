import js from '@eslint/js';
import globals from 'globals';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['main.js', 'node_modules/', 'coverage/', '.obsidian/', 'release/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: { obsidianmd },
    rules: {
      'obsidianmd/hardcoded-config-path': 'warn',
      'obsidianmd/settings-tab/prefer-setting-definitions': 'warn',
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['tests/**/*.ts', '*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
