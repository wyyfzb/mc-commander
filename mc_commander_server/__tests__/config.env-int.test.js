import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// config.js 模块加载时会读服务端目录 .env（外部 IO 边界）——mock 掉使 env 三态
// 完全由测试掌控，不受本地 .env 内容影响
vi.mock('dotenv', () => ({ default: { config: () => ({}) } }));

// config 是模块级单例：每例重置模块注册表后动态 import，让配置按当前 env 重新求值
function loadConfig() {
  vi.resetModules();
  return import('../config.js');
}

// 仅触碰本文件涉及的键，避免污染同 worker 其他测试的 env（vitest env 注入的
// API_KEY 等非数值键不在其中）
const TOUCHED = [
  'PORT',
  'TRUST_PROXY',
  'RATE_LIMIT_WINDOW',
  'RATE_LIMIT_MAX',
  'ADMIN_SESSION_TTL_HOURS',
  'PANEL_BACKUP_RETENTION_MAX',
  'PANEL_BACKUP_RETENTION_DAYS',
  'BACKUP_RETENTION_MAX',
  'BACKUP_RETENTION_DAYS',
  'DISK_WARNING_PERCENT',
  'API_KEY_ENABLED',
];
let snapshot;

beforeEach(() => {
  snapshot = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe('config 数值环境变量收口（intFromEnv）', () => {
  it('未设置的环境变量走默认值', async () => {
    const config = (await loadConfig()).default;
    expect(config.port).toBe(25566);
    expect(config.rateLimit.max).toBe(240);
  });

  it('合法整数值正常传入', async () => {
    process.env.PORT = '3000';
    process.env.RATE_LIMIT_MAX = '100';
    const config = (await loadConfig()).default;
    expect(config.port).toBe(3000);
    expect(config.rateLimit.max).toBe(100);
  });

  it('首尾空白宽容：trim 后合法即放行（粘贴带空格的笔误画像）', async () => {
    process.env.RATE_LIMIT_WINDOW = ' 60000 ';
    const config = (await loadConfig()).default;
    expect(config.rateLimit.windowMs).toBe(60000);
  });

  it('空字符串沿用 || 短路既有语义走默认值', async () => {
    process.env.PORT = '';
    const config = (await loadConfig()).default;
    expect(config.port).toBe(25566);
  });

  it('合法负数放行（TRUST_PROXY 设 -1 不信任代理头的文档形态）', async () => {
    process.env.TRUST_PROXY = '-1';
    const config = (await loadConfig()).default;
    expect(config.trustProxy).toBe(-1);
  });

  it('乘法形态语义保持：小时/天数配置乘以毫秒系数', async () => {
    process.env.ADMIN_SESSION_TTL_HOURS = '24';
    const config = (await loadConfig()).default;
    expect(config.adminSession.ttlMs).toBe(24 * 3600_000);
  });

  it('链式候选：PANEL_BACKUP_* 独立覆盖时不读 BACKUP_RETENTION_*', async () => {
    process.env.PANEL_BACKUP_RETENTION_MAX = '7';
    process.env.BACKUP_RETENTION_MAX = '15';
    const config = (await loadConfig()).default;
    expect(config.panelBackup.retention.maxBackups).toBe(7);
    expect(config.backupRetention.maxBackups).toBe(15);
  });

  it('非法值启动 fail-fast：错误信息指出变量名与实际读到的值', async () => {
    process.env.PORT = '8O'; // 字母 O 的常见笔误
    const err = await loadConfig().catch((e) => e);
    const text = String(err?.message ?? err);
    expect(text).toContain('PORT');
    expect(text).toContain('8O');
  });

  it('多个非法项一次全部列出，一次修完所有笔误', async () => {
    process.env.PORT = 'abc';
    process.env.RATE_LIMIT_MAX = 'xyz';
    const err = await loadConfig().catch((e) => e);
    const text = String(err?.message ?? err);
    expect(text).toContain('PORT');
    expect(text).toContain('abc');
    expect(text).toContain('RATE_LIMIT_MAX');
    expect(text).toContain('xyz');
  });

  it('前缀截断类静默劣化一并收口：单位后缀不再被 parseInt 截断放行', async () => {
    process.env.PORT = '8080px';
    const err = await loadConfig().catch((e) => e);
    expect(String(err?.message ?? err)).toContain('8080px');
  });

  it('前缀截断类静默劣化一并收口：小数不再被截断成整数', async () => {
    process.env.DISK_WARNING_PERCENT = '85.5';
    const err = await loadConfig().catch((e) => e);
    expect(String(err?.message ?? err)).toContain('DISK_WARNING_PERCENT');
  });

  it('全角数字拦截（手编 .env 输入法笔误画像）', async () => {
    process.env.PORT = '３０００';
    const err = await loadConfig().catch((e) => e);
    expect(String(err?.message ?? err)).toContain('３０００');
  });

  it('磁盘阈值倒置（error ≤ warning）拒绝启动：容错会让 error 档永不触发', async () => {
    process.env.DISK_WARNING_PERCENT = '95';
    process.env.DISK_ERROR_PERCENT = '85';
    const err = await loadConfig().catch((e) => e);
    const text = String(err?.message ?? err);
    expect(text).toContain('必须严格递增');
    expect(text).toContain('95');
    expect(text).toContain('85');
  });

  it('磁盘阈值相等也拒绝（两档重合会让 warning 档永不可达）', async () => {
    process.env.DISK_WARNING_PERCENT = '90';
    process.env.DISK_ERROR_PERCENT = '90';
    const err = await loadConfig().catch((e) => e);
    expect(String(err?.message ?? err)).toContain('必须严格递增');
  });

  it('链式候选首个已设置项生效即校验：非法时报第一候选变量名，不下探', async () => {
    process.env.PANEL_BACKUP_RETENTION_MAX = 'abc';
    process.env.BACKUP_RETENTION_MAX = '10';
    const err = await loadConfig().catch((e) => e);
    const text = String(err?.message ?? err);
    expect(text).toContain('PANEL_BACKUP_RETENTION_MAX');
    expect(text).not.toContain('BACKUP_RETENTION_MAX="10"');
  });

  it('API_KEY_ENABLED 解析：默认开启，大小写与首尾空格不敏感的 false/0 关闭', async () => {
    // 默认（.env 已 mock 掉，等价于未设置）
    expect((await loadConfig()).default.apiKeyEnabled).toBe(true);
    // 空串/纯空白等同未设置（与数值项同一口径）
    process.env.API_KEY_ENABLED = '   ';
    expect((await loadConfig()).default.apiKeyEnabled).toBe(true);
    // 关闭：false 的任意大小写/空白变体，以及 0（FALSE 曾被静默忽略 ⇒ fail-open）
    for (const value of ['false', 'FALSE', 'False', ' false ', '0']) {
      process.env.API_KEY_ENABLED = value;
      expect((await loadConfig()).default.apiKeyEnabled, `API_KEY_ENABLED=${value}`).toBe(false);
    }
    // 开启：true 的变体与 1
    for (const value of ['true', 'TRUE', 'True', ' true ', '1']) {
      process.env.API_KEY_ENABLED = value;
      expect((await loadConfig()).default.apiKeyEnabled, `API_KEY_ENABLED=${value}`).toBe(true);
    }
  });

  it('API_KEY_ENABLED 未识别取值启动 fail-fast（不静默取默认）', async () => {
    // 'no'/'yes'/'2'/拼写错误都属未识别：静默取默认在两个方向上都是坑
    for (const value of ['no', 'yes', '2', 'flase', 'enabled']) {
      process.env.API_KEY_ENABLED = value;
      const err = await loadConfig().catch((e) => e);
      const text = String(err?.message ?? err);
      expect(text, `API_KEY_ENABLED=${value}`).toContain('API_KEY_ENABLED');
      expect(text, `API_KEY_ENABLED=${value}`).toContain(value);
      expect(text).toContain('true/false/1/0');
    }
  });

  it('数值与布尔两类非法项同一次启动全部列出', async () => {
    process.env.PORT = '8O';
    process.env.API_KEY_ENABLED = 'maybe';
    const err = await loadConfig().catch((e) => e);
    const text = String(err?.message ?? err);
    expect(text).toContain('PORT');
    expect(text).toContain('8O');
    expect(text).toContain('API_KEY_ENABLED');
    expect(text).toContain('maybe');
    expect(text).toContain('2 个环境变量');
  });

  it('24 处调用点全部收口：配置赋值不再直接 parseInt(process.env)', async () => {
    const src = readFileSync(new URL('../config.js', import.meta.url), 'utf8');
    const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('//'));
    // 对象属性形态的 parseInt 调用为 0（全部经 intFromEnv 收口）
    expect(codeLines.filter((l) => /:\s*parseInt\(/.test(l))).toEqual([]);
    // 1 处定义 + 24 处调用
    expect(src.split('intFromEnv(').length - 1).toBe(25);
  });
});

// 运行期目录锚定：三个数据目录与 publicDir 同款锚定 __dirname（服务端包目录），
// 从任意 cwd 启动落点都不漂移。锚定失效是静默的——产物会悄悄写进启动目录
// （如从仓库根跑服务端时写进仓库根），故用「改 cwd 后仍指向包目录」锁死口径
describe('config 运行期目录锚定（__dirname，不随 cwd 漂移）', () => {
  // 期望基准取包目录拼接值而非绝对字面量：任意机器 / 任意 checkout 路径都成立
  const PKG_DIR = path.dirname(fileURLToPath(new URL('../config.js', import.meta.url)));
  const DIR_KEYS = ['SERVERS_DIR', 'DATA_DIR', 'BACKUPS_DIR'];

  // vitest.config.js 把三个目录注入为临时绝对路径（隔离真实数据目录），此处需
  // 摘掉它们才能观察到缺省口径；用完按原值还原，不污染同 worker 其他用例
  let dirSnapshot;
  beforeEach(() => {
    dirSnapshot = Object.fromEntries(DIR_KEYS.map((k) => [k, process.env[k]]));
    for (const k of DIR_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of DIR_KEYS) {
      if (dirSnapshot[k] === undefined) delete process.env[k];
      else process.env[k] = dirSnapshot[k];
    }
  });

  it('缺省值锚定服务端包目录，且与启动 cwd 无关', async () => {
    const cwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      const config = (await loadConfig()).default;
      expect(config.serversDir).toBe(path.join(PKG_DIR, 'servers'));
      expect(config.dataDir).toBe(path.join(PKG_DIR, 'data'));
      expect(config.backupsDir).toBe(path.join(PKG_DIR, 'backups'));
    } finally {
      process.chdir(cwd);
    }
  });

  it('env 传绝对路径时以其为准（与 publicDir 同语义，可指到安装目录之外）', async () => {
    const absData = path.join(os.tmpdir(), 'mc-anchor-abs-data');
    process.env.DATA_DIR = absData;
    const config = (await loadConfig()).default;
    expect(config.dataDir).toBe(absData);
  });

  it('env 传相对路径时按包目录解析，而非 cwd', async () => {
    process.env.BACKUPS_DIR = './custom-backups';
    const cwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      const config = (await loadConfig()).default;
      expect(config.backupsDir).toBe(path.join(PKG_DIR, 'custom-backups'));
    } finally {
      process.chdir(cwd);
    }
  });
});
