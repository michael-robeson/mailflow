'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/coverage/**',
      '**/dist/**',
      '**/build/**',
      '**/workflows/**',
      '**/.env*',
      '**/credentials/**',
      '**/secrets/**',
      '**/.n8n/**',
      'docs/mailflow.code-workspace',
    ],
  },
  {
    files: ['lib/**/*.cjs', 'scripts/**/*.cjs', 'tests/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      complexity: 'warn',
    },
  },
];
