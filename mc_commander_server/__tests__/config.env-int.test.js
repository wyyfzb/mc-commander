import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

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

  it('链式候选首个已设置项生效即校验：非法时报第一候选变量名，不下探', async () => {
    process.env.PANEL_BACKUP_RETENTION_MAX = 'abc';
    process.env.BACKUP_RETENTION_MAX = '10';
    const err = await loadConfig().catch((e) => e);
    const text = String(err?.message ?? err);
    expect(text).toContain('PANEL_BACKUP_RETENTION_MAX');
    expect(text).not.toContain('BACKUP_RETENTION_MAX="10"');
  });

  it('23 处调用点全部收口：配置赋值不再直接 parseInt(process.env)', async () => {
    const src = readFileSync(new URL('../config.js', import.meta.url), 'utf8');
    const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('//'));
    // 对象属性形态的 parseInt 调用为 0（全部经 intFromEnv 收口）
    expect(codeLines.filter((l) => /:\s*parseInt\(/.test(l))).toEqual([]);
    // 1 处定义 + 23 处调用
    expect(src.split('intFromEnv(').length - 1).toBe(24);
  });
});
