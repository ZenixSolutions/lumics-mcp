// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Root-level config files (eslint.config.js, vitest.config.ts) are not
        // in tsconfig.json's `include`, so the project service has no program
        // for them. `allowDefaultProject` lints them with an inferred program.
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', '*.cjs', '*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // standards/typescript-standard.md: "Avoid `any` unless justified."
      // Justified uses must carry an inline eslint-disable with a reason.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // standards/typescript-standard.md: "Use explicit error types."
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Public contracts must be explicit.
      '@typescript-eslint/explicit-module-boundary-types': 'warn',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // standards/security-standard.md: "Never commit, log, echo, or expose
      // secrets." stdout is the MCP transport channel on stdio; anything
      // written there corrupts the protocol stream. Diagnostics go to stderr
      // through the redacting logger in src/util/logger.ts.
      // ESLint 10 rejects `['error', { allow: [] }]` — the `allow` array has a
      // minItems of 1 — so the rule is configured bare, which is equivalent:
      // every `console` member is an error.
      'no-console': 'error',

      eqeqeq: ['error', 'always'],
      'no-param-reassign': 'error',
    },
  },
  {
    // Root-level tooling config is linted for syntax and correctness but not
    // with type-aware rules: it sits outside tsconfig.json's `include`, so the
    // inferred program types `import.meta` as `any` and every type-aware rule
    // fires on our own config file.
    files: ['*.js', '*.mjs', '*.cjs', '*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Tests may reach for looser typing against mock payloads.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The logger is the one place permitted to write to stderr.
    files: ['src/util/logger.ts'],
    rules: { 'no-console': 'off' },
  },
);
