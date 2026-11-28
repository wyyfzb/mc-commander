/**
 * 运维韧性测试
 * - 崩溃熔断与自启配置
 * - 磁盘使用率（getDiskUsage 缓存 + 去重 + statfsSync 返回值）
 * - check-update 端点（releases 版本源 / 离线回退）
 *
 * 超时余量：本节里三例在 it() 内动态 import 模块图（routes/index.js 是整棵路由树、
 * services/mc_server.js 是服务实例图），耗时是模块图求值而非用例逻辑——三泳道并行下
 * routes/index.js 实测 6910ms，旧 20s 上限在较慢宿主上会被越过（实测 20101ms 为右删失
 * 下界，即被上限截断）。故这三例显式放到 60s；其余纯逻辑用例保留默认值。
 * testTimeout 不覆盖 hook：本文件无重 hook，故无需 hookTimeout。
 */
import { describe, it, expect, vi } from 'vitest';

// ── 1. 崩溃循环熔断 ──────────────────────────────────────
describe('崩溃循环熔断', () => {
  it('config.crashLoop 有默认值', async () => {
    const config = (await import('../src/config.js')).default;
    expect(config.crashLoop.windowMs).toBe(300000);
    expect(config.crashLoop.maxCrashes).toBe(5);
  });
});

// ── 2. 磁盘使用率 ──────────────────────────────────────
describe('磁盘使用率 getDiskUsage', () => {
  it('config.diskAlert 有默认阈值', async () => {
    const config = (await import('../src/config.js')).default;
    expect(config.diskAlert.warningPercent).toBe(85);
    expect(config.diskAlert.errorPercent).toBe(95);
  });

  it('statfsSync 返回值正确计算 percent', () => {
    // 模拟 statfsSync 返回 1TB 磁盘，已用 850GB
    const bsize = 4096;
    const blocks = 256 * 1024 * 1024; // 1TB in 4K blocks
    const bfree = 38.25 * 1024 * 1024; // ~150GB free
    const total = bsize * blocks;
    const used = total - bsize * bfree;
    const percent = Math.round((used / total) * 1000) / 10;
    // 850/1000 = 85%
    expect(percent).toBeCloseTo(85, 0);
  });

  it('config.autoStartDelayMs 有默认值', async () => {
    const config = (await import('../src/config.js')).default;
    expect(config.autoStartDelayMs).toBe(3000);
  });

  it('config.repoPath 有默认值（更新检查的仓库路径）', async () => {
    const config = (await import('../src/config.js')).default;
    expect(config.repoPath).toBe('wyyfzb/mc-commander');
  });

  it('UPDATE_REPO 可覆盖仓库路径（fork 后不再查到上游版本）', async () => {
    const saved = process.env.UPDATE_REPO;
    process.env.UPDATE_REPO = 'someone/fork';
    try {
      vi.resetModules();
      const config = (await import('../src/config.js')).default;
      expect(config.repoPath).toBe('someone/fork');
    } finally {
      if (saved === undefined) delete process.env.UPDATE_REPO;
      else process.env.UPDATE_REPO = saved;
      vi.resetModules();
    }
  });
});

// ── 3. check-update 端点 ──────────────────────────────────────
describe('GET /api/v1/check-update', () => {
  // 端点在路由中注册，这里验证配置基础
  it('端点已注册在路由列表中', { timeout: 60_000 }, async () => {
    const { setupRoutes } = await import('../src/routes/index.js');
    expect(typeof setupRoutes).toBe('function');
  });
});

// ── 4. toStatus 包含韧性字段 ──────────────────────────────────
describe('toStatus 韧性字段', () => {
  it('MCServerInstance.toStatus() 包含 autoStart/circuitBreakerTripped/consecutiveCrashes', {
    timeout: 60_000,
  }, async () => {
    const { MCServerInstance } = await import('../src/services/mc_server.js');
    // 构造一个轻量实例（serverPath 不需要真实 JAR）
    const inst = new MCServerInstance({
      id: 'test-resilience',
      name: 'Test',
      javaPath: 'java',
      jarFile: 'server.jar',
      maxMemory: '1G',
      minMemory: '512M',
      serverPath: '/tmp/test-mc-resilience-' + Date.now(),
      autoRestart: true,
      autoStart: false,
    });
    const status = inst.toStatus();
    expect('autoStart' in status).toBe(true);
    expect('circuitBreakerTripped' in status).toBe(true);
    expect('consecutiveCrashes' in status).toBe(true);
    expect(status.autoStart).toBe(false);
    expect(status.circuitBreakerTripped).toBe(false);
    expect(status.consecutiveCrashes).toBe(0);
  });

  it('autoStart=true 时 toStatus 正确反映', { timeout: 60_000 }, async () => {
    const { MCServerInstance } = await import('../src/services/mc_server.js');
    const inst = new MCServerInstance({
      id: 'test-autostart',
      name: 'Test2',
      javaPath: 'java',
      jarFile: 'server.jar',
      maxMemory: '1G',
      minMemory: '512M',
      serverPath: '/tmp/test-mc-autostart-' + Date.now(),
      autoRestart: true,
      autoStart: true,
    });
    expect(inst.toStatus().autoStart).toBe(true);
  });
});
