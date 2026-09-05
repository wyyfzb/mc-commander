import { defineConfig } from 'vitest/config';
import crypto from 'crypto';

// API Key 哈希：单元测试用的固定 Key 对应的 SHA-256
const TEST_API_KEY = 'test-api-key-for-unit-tests';
const TEST_API_KEY_HASH = crypto.createHash('sha256').update(TEST_API_KEY).digest('hex');

export default defineConfig({
  test: {
    env: {
      API_KEY: TEST_API_KEY,
      API_KEY_HASH: TEST_API_KEY_HASH,
    },
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text'],
      include: ['routes/**', 'services/**', 'utils/**', 'db/**', 'websocket.js'],
      exclude: ['routes/*.test.js', '**/__tests__/**'],
    }
  }
});
