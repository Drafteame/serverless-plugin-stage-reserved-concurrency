import { configs, plugins } from 'eslint-config-airbnb-extended';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  plugins.stylistic,
  plugins.importX,
  plugins.typescriptEslint,
  ...configs.base.all,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Private methods use _ prefix by convention; harmless in TypeScript
      'no-underscore-dangle': 'off',
      // Plugin intentionally deletes properties from config objects
      'no-param-reassign': ['error', { props: false }],
      // Static-like helper methods that don't use `this` are acceptable
      'class-methods-use-this': 'off',
      // Allow ++ in loops and counters
      'no-plusplus': 'off',
      // Batch processing intentionally awaits in loops for rate limiting
      'no-await-in-loop': 'off',
      // Allow closures in loops when used with Promise.all batching
      '@typescript-eslint/no-loop-func': 'off',
      // Allow empty interfaces used as placeholder types
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  prettierConfig,
];
