'use strict'

const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      // Unused callback args are fine, the shape is dictated by the caller.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha } }
  }
]
