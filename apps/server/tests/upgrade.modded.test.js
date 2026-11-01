/**
 * Fabric / Forge 实例的升级路径。
 *
 * 承重点在 Forge：上游给的是**安装器**而不是服务端 jar，真入口 jar 与整个
 * libraries/ 依赖树都由 `--installServer` 生成。只下载安装器改名当 jar 用，
 * 实例永远起不来，而错误要等到首启校验才暴露——那时 DB 与实例 jar 都已改完。
 * 故本文件最重要的断言不是「会跑安装器」，而是：
 * ① 安装器跑在**替换之前**（jarFile 未改时它已经在跑）；
 * ② 安装器产出哪个 jar 就登记哪个（不能硬编码 server-<ver>.jar）；
 * ③ 安装失败时**没有**发生替换，走回滚而不是留下半成品。
 *
 * 网络隔离：http-client 全量 mock；子进程用替身（不起真 java）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { jsonImpl, streamImpl, spawnBehavior, spawnCalls } = vi.hoisted(() => ({
  jsonImpl: { current: null },
  streamImpl: { current: null },
  // 'ok'：立刻 exit 0；'exit1'：立刻 exit 1；'hang'：不发射任何事件
  spawnBehavior: { current: 'ok' },
  spawnCalls: { list: [] },
}));

vi.mock('../src/utils/http-client.js', () => ({
  httpJson: vi.fn((...args) => jsonImpl.current(...args)),
  httpStream: vi.fn((...args) => streamImpl.current(...args)),
  httpPost: vi.fn(),
}));

vi.mock('../src/services/backup.service.js', () => ({
  hasWorldData: vi.fn(() => true),
  BackupService: class {
    constructor(serverManager) {
      this.serverManager = serverManager;
    }
    async createBackup(instanceId) {
      this.serverManager.emit('instance:backupComplete', { instanceId, backupId: 'bk-mock' });
      return 'bk-mock';
    }
    async restoreBackup() {
      return { restored: true };
    }
  },
}));

vi.mock('../src/db/index.js', () => ({
  InstanceModel: { update: vi.fn() },
}));

vi.mock('../src/utils/audit.js', () => ({
  recordAudit: vi.fn(),
  AuditActions: { INSTANCE_UPGRADE: 'INSTANCE_UPGRADE' },
}));

// Java 探测扫描真机 /usr/lib/jvm，结果随环境变化；本文件测接线与顺序，
// 固定为「总是满足」以免红绿不定（Java 校验本身由 upgrade.java-check.test.js 覆盖）
vi.mock('../src/utils/java-detector.js', () => ({
  getRecommendedJavaVersion: vi.fn(() => '17'),
  isJavaSatisfied: vi.fn(() => true),
  findJavaPathStrict: vi.fn(() => null),
  findJavaPath: vi.fn(() => 'java'),
  getAllJavaVersions: vi.fn(() => []),
}));

// 子进程替身：安装器只关心「退出码 + 目录里多了什么」，由用例在 exit 前
// 通过 spawnBehavior.onSpawn 自己造产物
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn((command, args, options) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 43434;
      proc.kill = vi.fn();
      spawnCalls.list.push({ command, args, options });
      if (spawnBehavior.current === 'exit1') queueMicrotask(() => proc.emit('exit', 1));
      else if (spawnBehavior.current === 'ok') queueMicrotask(() => proc.emit('exit', 0));
      // 'hang'：不发射事件，等用例推进超时分支
      return proc;
    }),
  };
});

import {
  UpgradeService,
  UPGRADE_STAGES,
  pickForgeLaunchJar,
  FORGE_INSTALL_TIMEOUT_MS,
} from '../src/services/upgrade.service.js';
import { InstanceModel } from '../src/db/index.js';

let tmpDir;

const serverManagerRef = { current: null };

function makeFakeStream() {
  const listeners = {};
  const stream = {
    on(ev, cb) {
      (listeners[ev] = listeners[ev] || []).push(cb);
      return stream;
    },
    pipe(file) {
      stream._file = file;
      return stream;
    },
    destroy() {
      stream._destroyed = true;
    },
  };
  stream._emit = (ev, ...args) => {
    (listeners[ev] || []).forEach((cb) => cb(...args));
  };
  return stream;
}

/** 下载流：写一段内容后正常结束（真实落盘，供安装器替身读写目录） */
function streamSucceeds() {
  return () => {
    const stream = makeFakeStream();
    queueMicrotask(() => {
      stream._emit('downloadProgress', { percent: 1, transferred: 1, total: 1 });
      if (stream._file) {
        stream._file.write('JAR_CONTENT');
        stream._file.end();
      }
    });
    return stream;
  };
}

function createMockInstance(overrides = {}) {
  return {
    id: 'inst-1',
    name: 'Test Server',
    mcVersion: '1.20.4',
    jarFile: 'server-1.20.4.jar',
    serverPath: tmpDir,
    isRunning: false,
    javaPath: '/usr/lib/jvm/java-17/bin/java',
    // 首启校验：立刻发 ready
    start: vi.fn(() => {
      queueMicrotask(() =>
        serverManagerRef.current.emit('instance:status', { instanceId: 'inst-1', event: 'ready' }),
      );
    }),
    ...overrides,
  };
}

function createMockServerManager(instanceOverrides = {}) {
  const instance = createMockInstance(instanceOverrides);
  const listeners = {};
  const emitted = [];
  const manager = {
    getInstance: vi.fn((id) => (id === instance.id ? instance : null)),
    on: vi.fn((event, fn) => {
      (listeners[event] = listeners[event] || []).push(fn);
    }),
    removeListener: vi.fn((event, fn) => {
      if (listeners[event]) listeners[event] = listeners[event].filter((f) => f !== fn);
    }),
    emit: vi.fn((event, data) => {
      emitted.push({ event, data });
      (listeners[event] || []).forEach((fn) => fn(data));
    }),
    _instance: instance,
    _emitted: emitted,
  };
  serverManagerRef.current = manager;
  return manager;
}

function progressStages(manager) {
  return manager._emitted
    .filter((e) => e.event === 'instance:upgradeProgress')
    .map((e) => e.data.stage);
}

beforeEach(() => {
  vi.clearAllMocks();
  spawnCalls.list = [];
  spawnBehavior.current = 'ok';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upgrade-modded-'));
  jsonImpl.current = (url) => {
    const u = String(url);
    // fabric：loader 列表（由新到旧，须跳过 unstable）与 server jar 直链
    if (u.includes('/v2/versions/loader')) {
      return Promise.resolve([
        { version: '0.21.0', stable: false },
        { version: '0.20.1', stable: true },
      ]);
    }
    // forge：promotions
    if (u.includes('promotions_slim.json')) {
      return Promise.resolve({ promos: { '1.20.1-recommended': '47.4.28' } });
    }
    return Promise.reject(new Error('offline (mocked)'));
  };
  streamImpl.current = streamSucceeds();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── ① fabric：下载解析与 loader 缺省 ──

describe('fabric 升级', () => {
  it('loader 留空 → 取上游最新**稳定**版拼出下载地址，且不含摘要', async () => {
    const service = new UpgradeService(createMockServerManager());
    const { url, expectedHash } = await service.resolveDownload('1.21.4', 'fabric');
    // 0.21.0 是 unstable，必须被跳过：模组按 loader 版本声明硬依赖，装错版本直接 HARD_DEP
    expect(url).toBe('https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.20.1/1.0.1/server/jar');
    // 上游确实不提供摘要：如实为 null，不拿别的字段凑
    expect(expectedHash).toBeNull();
  });

  it('显式 loaderVersion → 用指定版本，不查上游列表', async () => {
    const service = new UpgradeService(createMockServerManager());
    const { url } = await service.resolveDownload('1.21.4', 'fabric', '0.16.14');
    expect(url).toContain('/0.16.14/');
  });

  it('升级成功后 jarFile 仍是 server-<版本>.jar 形态（fabric 入口无额外产物）', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    await service.upgrade('inst-1', '1.21.4', 'fabric');

    expect(InstanceModel.update).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ jarFile: 'server-1.21.4.jar', modLoader: 'Fabric' }),
    );
  });
});

// ── ② Forge：安装器是升级的必要步骤 ──

describe('forge 升级', () => {
  it('下载的是安装器（maven 域），不是服务端 jar', async () => {
    const service = new UpgradeService(createMockServerManager());
    const { url, expectedHash } = await service.resolveDownload('1.20.1', 'forge');
    expect(url).toBe(
      'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.28/forge-1.20.1-47.4.28-installer.jar',
    );
    expect(expectedHash).toBeNull();
  });

  it('🔴 必须跑 --installServer，且发生在替换之前', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    // 安装器替身：在 exit 前产出入口 jar（模拟真实安装器行为）
    spawnBehavior.current = 'ok';
    const origSpawnImpl = (await import('child_process')).spawn;

    let jarFileAtInstallTime = null;
    origSpawnImpl.mockImplementationOnce((command, args, options) => {
      // 断言安装发生时的实例状态：此刻 jarFile 必须还是旧值
      jarFileAtInstallTime = manager._instance.jarFile;
      fs.writeFileSync(path.join(options.cwd, 'forge-1.20.1-47.4.28-shim.jar'), 'SHIM');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 43434;
      proc.kill = vi.fn();
      spawnCalls.list.push({ command, args, options });
      queueMicrotask(() => proc.emit('exit', 0));
      return proc;
    });

    await service.upgrade('inst-1', '1.20.1', 'forge');

    // 安装器确实被调用了，参数是 --installServer
    expect(spawnCalls.list.length).toBeGreaterThan(0);
    expect(spawnCalls.list[0].command).toBe('/usr/lib/jvm/java-17/bin/java');
    expect(spawnCalls.list[0].args).toContain('--installServer');
    expect(spawnCalls.list[0].args).toContain('forge-installer.jar');
    // 安装发生在替换之前
    expect(jarFileAtInstallTime).toBe('server-1.20.4.jar');
    // 进度里有一档独立的 forge_install
    expect(progressStages(manager)).toContain(UPGRADE_STAGES.FORGE_INSTALL);
  });

  it('🔴 登记的是安装器产出的 jar 名，不是 server-<版本>.jar', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    const { spawn } = await import('child_process');
    spawn.mockImplementationOnce((command, args, options) => {
      fs.writeFileSync(path.join(options.cwd, 'forge-1.20.1-47.4.28-shim.jar'), 'SHIM');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 43434;
      proc.kill = vi.fn();
      spawnCalls.list.push({ command, args, options });
      queueMicrotask(() => proc.emit('exit', 0));
      return proc;
    });

    await service.upgrade('inst-1', '1.20.1', 'forge');

    // 硬编码 server-1.20.1.jar 会让实例指向一个不存在的文件
    expect(InstanceModel.update).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ jarFile: 'forge-1.20.1-47.4.28-shim.jar' }),
    );
    expect(manager._instance.jarFile).toBe('forge-1.20.1-47.4.28-shim.jar');
  });

  it('安装器退出码非 0 → 升级失败且未发生替换（DB 未写入新版本）', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    spawnBehavior.current = 'exit1';

    await expect(service.upgrade('inst-1', '1.20.1', 'forge')).rejects.toThrow(
      /Forge 安装器失败（退出码 1）/,
    );

    expect(InstanceModel.update).not.toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ mcVersion: '1.20.1' }),
    );
    expect(progressStages(manager)).not.toContain(UPGRADE_STAGES.VERIFY);
    expect(progressStages(manager)).toContain(UPGRADE_STAGES.ROLLED_BACK);
  });

  it('安装器退出码 0 但没产出本版本入口 jar → 报可读错误，不猜一个 jar', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    // 'ok' 但不写任何 jar：模拟产物形态不符。
    // 断言「给出路」（该换哪个版本）而非某句字面——文案会变，出路不会
    await expect(service.upgrade('inst-1', '1.20.1', 'forge')).rejects.toThrow(/较新的游戏版本/);
    expect(InstanceModel.update).not.toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ mcVersion: '1.20.1' }),
    );
  });

  it('安装失败时安装器文件被清理（任何终态都不留 forge-installer.jar）', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    spawnBehavior.current = 'exit1';

    await expect(service.upgrade('inst-1', '1.20.1', 'forge')).rejects.toThrow();
    expect(fs.existsSync(path.join(tmpDir, 'forge-installer.jar'))).toBe(false);
  });
});

// ── ②b 安装器超时下界 ──

describe('Forge 安装器超时', () => {
  it('🔴 不得短于实测安装耗时（守下界，不守魔数）', () => {
    // 判据是「不能短到必然超时」这个性质，不是「必须正好 900000」。
    // 实测一次全新 --installServer 要下载 100MB+ 的 libraries：1.21.4-54.1.22 约 5 分钟、
    // 1.20.1-47.4.28 约 2 分钟（同版本重装只要 6 秒）。取 300s 作为下界——低于它，
    // 正常线路上的安装就会被 kill 掉，用户拿到「升级失败」而其实什么都没错。
    // 微调不红；改回部署侧原来的 120s 会红。
    expect(FORGE_INSTALL_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });
});

// ── ③ 入口 jar 认领（纯函数，钉住判据） ──

describe('pickForgeLaunchJar 认领判据', () => {
  it('优先 shim', () => {
    // 非 shim 排在前：readdirSync 的返回顺序不保证，靠顺序「恰好选对」等于没锁
    expect(
      pickForgeLaunchJar(
        ['forge-1.21.4-54.1.22-server.jar', 'forge-1.21.4-54.1.22-shim.jar'],
        'forge-installer.jar',
        '1.21.4',
      ),
    ).toBe('forge-1.21.4-54.1.22-shim.jar');
  });

  it('🔴 按目标版本前缀过滤：别的版本残留不得被认成本次产物', () => {
    // 实测：先装 1.21.4 再装 1.20.1 后，根目录只剩旧的 1.21.4 shim。
    // 不带前缀过滤会把它当成本次产物 ⇒「升级到 1.20.1」实际启动 1.21.4 的 jar
    expect(
      pickForgeLaunchJar(['forge-1.21.4-54.1.22-shim.jar'], 'forge-installer.jar', '1.20.1'),
    ).toBeNull();
  });

  it('安装器自己不算启动 jar', () => {
    expect(
      pickForgeLaunchJar(
        ['forge-1.20.1-47.4.28-installer.jar'],
        'forge-1.20.1-47.4.28-installer.jar',
        '1.20.1',
      ),
    ).toBeNull();
  });

  it('没有 shim 时退回本版本的其他 forge-*.jar', () => {
    expect(
      pickForgeLaunchJar(['forge-1.20.1-47.4.28-universal.jar'], 'forge-installer.jar', '1.20.1'),
    ).toBe('forge-1.20.1-47.4.28-universal.jar');
  });

  it('空目录 → null（调用方据此报错，而不是拿一个空值去启动）', () => {
    expect(pickForgeLaunchJar([], 'forge-installer.jar', '1.20.1')).toBeNull();
  });
});

// ── ④ 取消语义 ──

describe('forge 安装阶段取消', () => {
  it('取消发生在安装器运行中 → 终止进程树并以 cancelled 收尾，不回滚已落定的 jar', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    spawnBehavior.current = 'hang';

    const pending = service.upgrade('inst-1', '1.20.1', 'forge');
    // 等安装阶段真正开始再取消
    for (let i = 0; i < 200 && spawnCalls.list.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const { cancelTask, TASK_KINDS } = await import('../src/utils/cancellable-task.js');
    cancelTask(TASK_KINDS.UPGRADE, 'inst-1');

    await expect(pending).resolves.toBeUndefined();
    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.CANCELLED);
    // 替换未发生 ⇒ 不该出现回滚档
    expect(stages).not.toContain(UPGRADE_STAGES.ROLLED_BACK);
    // 实例保持旧版本
    expect(manager._instance.jarFile).toBe('server-1.20.4.jar');
  });
});

// ── ⑤ 回滚后实例确实能起：不能只还原 jar ──

describe('forge 首启校验失败后的回滚', () => {
  it('回滚删掉本次产出的入口 jar，避免「DB 旧名 + 磁盘新 jar」并存', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    const { spawn } = await import('child_process');
    spawn.mockImplementationOnce((command, args, options) => {
      fs.writeFileSync(path.join(options.cwd, 'forge-1.20.1-47.4.28-shim.jar'), 'SHIM');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 43434;
      proc.kill = vi.fn();
      spawnCalls.list.push({ command, args, options });
      queueMicrotask(() => proc.emit('exit', 0));
      return proc;
    });
    // 首启崩：触发回滚
    manager._instance.start = vi.fn(() => {
      queueMicrotask(() =>
        serverManagerRef.current.emit('instance:status', {
          instanceId: 'inst-1',
          event: 'crash',
        }),
      );
    });

    await expect(service.upgrade('inst-1', '1.20.1', 'forge')).rejects.toThrow(
      /crashed during startup verification/,
    );

    // 新版本的入口 jar 必须被清掉：留着它与 DB/内存里的旧名不一致
    expect(fs.existsSync(path.join(tmpDir, 'forge-1.20.1-47.4.28-shim.jar'))).toBe(false);
    // 旧 jar 名与版本回写
    expect(manager._instance.jarFile).toBe('server-1.20.4.jar');
    expect(InstanceModel.update).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ jarFile: 'server-1.20.4.jar', mcVersion: '1.20.4' }),
    );
  });
});

// ── ⑥ 首启校验窗口：fabric/forge 的引导器比原版慢 ──

describe('首启校验窗口', () => {
  it('fabric/forge 用更长的校验窗口（引导器要先自举），原版仍是 120s', async () => {
    const service = new UpgradeService(createMockServerManager());
    const seen = [];
    service._startAndVerify = vi.fn(async (_id, opts) => {
      seen.push(opts.timeoutMs);
    });

    await service.upgrade('inst-1', '1.21.4', 'fabric');
    // 实测 fabric 冷启动到 Done 共 116s，贴着 120s 边缘 ⇒ 必须放宽
    expect(seen[0]).toBe(300_000);
  });

  it('原版保持 120s（不放宽，避免真的起不来时长时间挂进度）', async () => {
    const service = new UpgradeService(createMockServerManager());
    const seen = [];
    service._startAndVerify = vi.fn(async (_id, opts) => {
      seen.push(opts.timeoutMs);
    });
    jsonImpl.current = (url) => {
      if (String(url).includes('version_manifest')) {
        return Promise.resolve({
          versions: [
            { id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v.json' },
          ],
        });
      }
      return Promise.resolve({
        downloads: { server: { url: 'https://piston-data.mojang.com/server-1.21.4.jar' } },
      });
    };

    await service.upgrade('inst-1', '1.21.4', 'vanilla');
    expect(seen[0]).toBe(120_000);
  });
});
