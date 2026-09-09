// Minimal ESLint setup: the TypeScript recommended rules, plus prettier turning off
// everything that would fight the formatter. If a rule annoys you, we discuss it in
// the group chat and change it here once, for everyone.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Unused function arguments are normal in Express middleware signatures.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
