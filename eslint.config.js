'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  { ignores: ['captured/', 'node_modules/', 'chrome/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      // Unused catch bindings (`catch (e) { /* ignore */ }`) are the house style
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: globals.browser,
    },
  },
  {
    // page.evaluate() callbacks run in the browser
    files: ['costpoint.js', 'test/browser/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // The Costpoint binary protocol delimits fields with control characters
    files: ['protocol.js', 'mock/codec.js', 'tui.js'],
    rules: { 'no-control-regex': 'off' },
  },
  // Formatting belongs to Prettier (npm run format); turn off rules that clash with it
  prettier,
];
