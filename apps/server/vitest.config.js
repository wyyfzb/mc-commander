import { defineConfig } from 'vitest/config';
import crypto from 'crypto';
import os from 'os';
import path from 'path';

// API Key 哈希：单元测试用的固定明文 Key 与其 SHA-256（服务端只读 API_KEY_HASH）
const TEST_API_KEY = 'test-api-key-for-unit-tests';
const TEST_API_KEY_HASH = crypto.createHash('sha256').update(TEST_API_KEY).digest('hex');

// 运行时目录一律挂到系统临时目录：未显式 mock config 的用例会读真实 config
// （三个目录缺省锚定服务端安装目录 = 包内真实 data/ servers/ backups/），否则
// `npm test` 会把测试日志与夹具写进仓库内真实数据目录。目录名带 pid（同包并发
// 两轮各用各的，互不相干）；
// tests/global-setup.js 起手清空自己的、回收陈旧根，收尾删除——否则每轮留下的
// SQLite 夹具库会一直堆积。需要保留现场时 KEEP_TEST_TMP=1 npm test
const TEST_RUNTIME_ROOT = path.join(os.tmpdir(), `mc-commander-server-vitest-${process.pid}`);

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.js'],
    // 全局用 vitest 默认的 5s。重负载用例在**组级**声明余量
    // （`describe(..., { timeout })`），不在这里统一放宽。
    //
    // 统一放宽会掩盖真实的性能退化：一个单次耗时数秒的实现缺陷，在宽松的全局值下
    // 只会表现为「这个文件有点慢」，与并行抖动无法区分，于是没人回头查。全局值越小，
    // 这类退化越早暴露。
    //
    // 需要余量的只有三类，理由写在各自的 describe 上：
    //   ① 起真实 bash 进程跑部署/清理脚本（panel-routes、security.deploy）
    //   ② 密码 scrypt（N=131072，计算密集型，单次数百毫秒）× 多次登录
    //      （auth-totp、admin-auth）
    //   ③ 大目录遍历等重 IO（level-dat）
    // 这三类的共同点：耗时由被测代码的真实工作决定，不随机器变好而消失。
    // 新增慢用例时按同一口径在组上写清「慢在哪」，而不是把全局值再抬回去。
    testTimeout: 5_000,
    env: {
      API_KEY_HASH: TEST_API_KEY_HASH,
      DATA_DIR: path.join(TEST_RUNTIME_ROOT, 'data'),
      SERVERS_DIR: path.join(TEST_RUNTIME_ROOT, 'servers'),
      BACKUPS_DIR: path.join(TEST_RUNTIME_ROOT, 'backups'),
      // 供 tests/global-setup.js 复用同一个运行根（单一来源，避免两处各算一遍 pid）
      MCS_TEST_TMP: TEST_RUNTIME_ROOT,
    },
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text'],
      include: [
        'src/routes/**',
        'src/services/**',
        'src/utils/**',
        'src/db/**',
        'src/websocket.js',
      ],
      exclude: ['src/routes/*.test.js', '**/tests/**'],
      // 阈值由本包自己判，不做跨包合计：合计判阈值时一个包掉到 30%、
      // 另一个 95% 也照样通过，等于没有门禁
      thresholds: {
        statements: 70,
      },
    },
  },
});
