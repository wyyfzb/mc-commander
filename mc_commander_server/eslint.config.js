import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'servers/**', 'backups/**', 'data/**', 'coverage/**', 'public/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // 基础规则：只拦截明确的错误，不强制代码风格
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['warn', 'smart'],
      // 日志收口（issue #325）：运行时一律走 utils/logger.js（四级过滤 +
      // error 分流轮转 + stderr banner 白名单），裸 console 禁止回归
      'no-console': 'error',
    },
  },
];
