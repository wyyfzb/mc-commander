import { defineConfig } from 'vitest/config';
import crypto from 'crypto';
import os from 'os';
import path from 'path';

// API Key 哈希：单元测试用的固定明文 Key 与其 SHA-256（服务端只读 API_KEY_HASH）
const TEST_API_KEY = 'test-api-key-for-unit-tests';
const TEST_API_KEY_HASH = crypto.createHash('sha256').update(TEST_API_KEY).digest('hex');

// 运行时目录一律挂到系统临时目录：未显式 mock config 的用例会读真实 config
// （DATA_DIR 缺省 './data' 相对 cwd），否则 `npm test` 会把测试日志写进仓库
// 真实 data/logs。目录名带 pid（同包并发两轮各用各的，互不相干）；
// __tests__/global-setup.js 起手清空自己的、回收陈旧根，收尾删除——否则每轮留下的
// SQLite 夹具库会一直堆积。需要保留现场时 KEEP_TEST_TMP=1 npm test
const TEST_RUNTIME_ROOT = path.join(os.tmpdir(), `mc-commander-server-vitest-${process.pid}`);

export default defineConfig({
  test: {
    globalSetup: ['./__tests__/global-setup.js'],
    // 并行门禁余量：私有 verify.ps1 三包并行时，重负载用例（如 scrypt N=131072 连做 4~5 次，
    // 空载约 1.3s）会被挤过 vitest 默认的 5s 上限 ⇒ 同一提交在顺序执行的 local-check.sh 下
    // 全绿、在三泳道并行下随机红，且每轮受害者不同。逐文件声明余量修不完（120 个文件里只有
    // 1 个声明过），故在此统一给足；15s 仍能在用例真正挂死时失败，不是把超时当通过。
    testTimeout: 15_000,
    env: {
      API_KEY_HASH: TEST_API_KEY_HASH,
      DATA_DIR: path.join(TEST_RUNTIME_ROOT, 'data'),
      SERVERS_DIR: path.join(TEST_RUNTIME_ROOT, 'servers'),
      BACKUPS_DIR: path.join(TEST_RUNTIME_ROOT, 'backups'),
      // 供 __tests__/global-setup.js 复用同一个运行根（单一来源，避免两处各算一遍 pid）
      MCS_TEST_TMP: TEST_RUNTIME_ROOT,
    },
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text'],
      include: ['routes/**', 'services/**', 'utils/**', 'db/**', 'websocket.js'],
      exclude: ['routes/*.test.js', '**/__tests__/**'],
    }
  }
});
