import { defineConfig } from 'vitest/config';
import crypto from 'crypto';

// API Key 哈希：单元测试用的固定 Key 对应的 SHA-256
const TEST_API_KEY = 'test-api-key-for-unit-tests';
const TEST_API_KEY_HASH = crypto.createHash('sha256').update(TEST_API_KEY).digest('hex');

export default defineConfig({
  test: {
    // 并行门禁余量：私有 verify.ps1 三包并行时，重负载用例（如 scrypt N=131072 连做 4~5 次，
    // 空载约 1.3s）会被挤过 vitest 默认的 5s 上限 ⇒ 同一提交在顺序执行的 local-check.sh 下
    // 全绿、在三泳道并行下随机红，且每轮受害者不同。逐文件声明余量修不完（120 个文件里只有
    // 1 个声明过），故在此统一给足；15s 仍能在用例真正挂死时失败，不是把超时当通过。
    testTimeout: 15_000,
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
