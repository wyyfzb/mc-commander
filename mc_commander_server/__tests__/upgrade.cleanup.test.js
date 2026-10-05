/**
 * 升级成功路径旧 jar 清理 + 备份/回滚复制异步化行为级补测（#520）
 *
 * 覆盖 upgrade.service.js 两处实现问题修复后的行为契约：
 * ① 成功路径删除被替换旧版本 jar（失败/回滚路径保留回滚源）；同版本
 *    直调服务层时 oldJarPath === newJarPath 守卫不误删新 jar
 * ② replace 阶段备份与 _doRollback 恢复两处 copyFileSync → 异步
 *    fs.promises.copyFile（不再阻塞事件循环）；_doRollback finally await
 *    unlink：回滚完成（含临时备份清理）后才 resolve，调用方不提前 cleanup
 * ③ 连续两次升级模拟后实例目录仅保留当前版本 jar
 *
 * 网络隔离：http-client 全量 mock（CI 离线确定性）；真实临时目录 + 真实 fs，
 * 复制/删除落盘行为可断言（禁止占位断言）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── 可变 mock 实现（vi.hoisted：factory 内不得引用外部变量） ──
const { jsonImpl, streamImpl } = vi.hoisted(() => ({
  jsonImpl: { current: null },
  streamImpl: { current: null },
}));

// 升级流程会校验目标版本的 Java 要求，而 Java 探测在真机上扫描 /usr/lib/jvm：
// 结果随环境变化，还会额外写一次 javaPath（打乱对 InstanceModel.update 的断言）。
// 本文件不测 Java 校验（那由 upgrade.java-check.test.js 专门覆盖），故固定为「总是满足」。
vi.mock('../utils/java-detector.js', () => ({
  getRecommendedJavaVersion: vi.fn(() => '21'),
  isJavaSatisfied: vi.fn(() => true),
  findJavaPathStrict: vi.fn(() => null),
  findJavaPath: vi.fn(() => 'java'),
  getAllJavaVersions: vi.fn(() => []),
}));

vi.mock('../utils/http-client.js', () => ({
  httpJson: vi.fn((...args) => jsonImpl.current(...args)),
  httpStream: vi.fn((...args) => streamImpl.current(...args)),
  httpPost: vi.fn(),
}));

vi.mock('../services/backup.service.js', () => ({
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

vi.mock('../db/index.js', () => ({
  InstanceModel: { update: vi.fn() },
}));

import { UpgradeService, UPGRADE_STAGES } from '../services/upgrade.service.js';
import { InstanceModel } from '../db/index.js';

// ── 桩 serverManager（真实临时目录作为 serverPath） ──

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

function createMockInstance(overrides = {}) {
  return {
    id: 'inst-1',
    name: 'Test Server',
    mcVersion: '1.20.4',
    jarFile: 'server-1.20.4.jar',
    serverPath: tmpDir,
    isRunning: false,
    start: vi.fn(() => {}),
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
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((f) => f !== fn);
      }
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

/** 下载流正常写完：数据由 downloadData 外部变量控制（连续升级用不同内容） */
let downloadData = 'NEW_JAR_CONTENT';

function streamSucceeds() {
  return () => {
    const stream = makeFakeStream();
    queueMicrotask(() => {
      stream._emit('downloadProgress', { percent: 1, transferred: 1, total: 1 });
      stream._file.write(downloadData);
      stream._file.end();
    });
    return stream;
  };
}

/** 首启即 ready 的实例桩 */
function startEmitsReady() {
  return vi.fn(() => {
    queueMicrotask(() =>
      serverManagerRef.current.emit('instance:status', {
        instanceId: 'inst-1',
        event: 'ready',
      }),
    );
  });
}

/** 首启即 crash 的实例桩 */
function startEmitsCrash() {
  return vi.fn(() => {
    queueMicrotask(() =>
      serverManagerRef.current.emit('instance:status', {
        instanceId: 'inst-1',
        event: 'crash',
      }),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upgrade-clean-'));
  // purpur 现在会先查 /latest 取 md5 摘要；默认 mock 需能回答该查询，否则以 purpur
  // 为载体的用例会停在「offline」而非待测阶段。其余上游一律拒绝，保持隔离语义。
  jsonImpl.current = (url) => {
    if (String(url).includes('/purpur/')) return Promise.resolve({ build: '2416' });
    return Promise.reject(new Error('offline (mocked)'));
  };
  downloadData = 'NEW_JAR_CONTENT';
  streamImpl.current = streamSucceeds();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function progressStages(serverManager) {
  return serverManager._emitted
    .filter((e) => e.event === 'instance:upgradeProgress')
    .map((e) => e.data.stage);
}

const OLD_JAR = () => path.join(tmpDir, 'server-1.20.4.jar');
const BACKUP_JAR = () => path.join(tmpDir, '._upgrade_backup_server-1.20.4.jar');

// ── ① 成功路径：被替换旧版本 jar 清理 ──

describe('成功路径：被替换旧版本 jar 清理（#520 实锤①）', () => {
  it('升级成功后旧 jar 本体已删除、当前 jar 内容为新版、备份副本已清理', async () => {
    const manager = createMockServerManager({ start: startEmitsReady() });
    const service = new UpgradeService(manager);
    fs.writeFileSync(OLD_JAR(), 'OLD_JAR_CONTENT');

    await service.upgrade('inst-1', '1.21.4', 'purpur');

    // 旧 jar 本体：成功路径 fire-and-forget unlink，waitFor 等待落盘
    await vi.waitFor(() => expect(fs.existsSync(OLD_JAR())).toBe(false));
    // 当前 jar：下载的新内容完整保留
    expect(fs.readFileSync(path.join(tmpDir, 'server-1.21.4.jar'), 'utf8')).toBe('NEW_JAR_CONTENT');
    // 回滚源副本：成功后同样清理
    await vi.waitFor(() => expect(fs.existsSync(BACKUP_JAR())).toBe(false));
    // 进度收官：COMPLETED
    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.COMPLETED);
    // DB 已指向新版本
    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-1.21.4.jar',
      mcVersion: '1.21.4',
    });
  });

  it('连续两次升级：实例目录最终仅保留最新版本 jar（无残留旧版本/备份副本）', async () => {
    const manager = createMockServerManager({ start: startEmitsReady() });
    const service = new UpgradeService(manager);
    fs.writeFileSync(OLD_JAR(), 'V_1.20.4_CONTENT');

    // 第一次升级 1.20.4 → 1.21.4（instance.mcVersion/jarFile 由服务内部更新）
    downloadData = 'V_1.21.4_CONTENT';
    await service.upgrade('inst-1', '1.21.4', 'purpur');
    await vi.waitFor(() => expect(fs.existsSync(OLD_JAR())).toBe(false));

    // 第二次升级 1.21.4 → 1.21.6：oldJarFile 已是第一次升级产物 server-1.21.4.jar
    downloadData = 'V_1.21.6_CONTENT';
    await service.upgrade('inst-1', '1.21.6', 'purpur');
    await vi.waitFor(() =>
      expect(fs.existsSync(path.join(tmpDir, 'server-1.21.4.jar'))).toBe(false),
    );

    // 目录终态：仅剩当前版本 jar，无任何 ._upgrade_backup_ 残留
    const jars = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jar'));
    expect(jars).toEqual(['server-1.21.6.jar']);
    expect(fs.readFileSync(path.join(tmpDir, 'server-1.21.6.jar'), 'utf8')).toBe(
      'V_1.21.6_CONTENT',
    );
    expect(fs.readdirSync(tmpDir).some((f) => f.startsWith('._upgrade_backup_'))).toBe(false);
  });

  it('同版本直调服务层（绕过路由 UPGRADE_VERSION_SAME 校验）：oldJarPath 与 newJarPath 相同时守卫不误删当前 jar', async () => {
    // instance.mcVersion 与目标版本一致：oldJarFile === newJarName === server-1.20.4.jar
    const manager = createMockServerManager({ start: startEmitsReady() });
    const service = new UpgradeService(manager);
    fs.writeFileSync(OLD_JAR(), 'OLD_JAR_CONTENT');

    await service.upgrade('inst-1', '1.20.4', 'purpur');

    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.COMPLETED);
    // 守卫生效：同路径时跳过 unlink，当前 jar（即下载的新 jar）保留新内容
    expect(fs.existsSync(OLD_JAR())).toBe(true);
    expect(fs.readFileSync(OLD_JAR(), 'utf8')).toBe('NEW_JAR_CONTENT');
    // 备份副本照常清理
    await vi.waitFor(() => expect(fs.existsSync(BACKUP_JAR())).toBe(false));
  });
});

// ── ② 失败/回滚路径：回滚源可用性与 await 语义 ──

describe('失败/回滚路径：旧 jar 保留与回滚完成语义（#520）', () => {
  it('首启 crash 回滚后旧 jar 本体保留且内容不变（失败路径不删）', async () => {
    const manager = createMockServerManager({ start: startEmitsCrash() });
    const service = new UpgradeService(manager);
    fs.writeFileSync(OLD_JAR(), 'OLD_JAR_CONTENT');

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      'Server crashed during startup verification',
    );

    // 旧 jar 本体：失败/回滚路径不删
    expect(fs.existsSync(OLD_JAR())).toBe(true);
    expect(fs.readFileSync(OLD_JAR(), 'utf8')).toBe('OLD_JAR_CONTENT');
    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
  });

  it('回滚完成（含临时备份清理）后才向上推进：await 语义下 reject 时临时备份已不在磁盘', async () => {
    const manager = createMockServerManager({ start: startEmitsCrash() });
    const service = new UpgradeService(manager);
    fs.writeFileSync(OLD_JAR(), 'OLD_JAR_CONTENT');

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      'Server crashed during startup verification',
    );

    // _doRollback finally await unlink：调用方收到 reject 时清理已同步完成，
    // 无需 waitFor（修复前 fire-and-forget 需轮询，此为 await 语义的直接证据）
    expect(fs.existsSync(BACKUP_JAR())).toBe(false);
    // 回滚恢复语义（#539）：旧 jar 本体内容=备份旧内容，错位副本（新名）已删，
    // 实例目录旧版本 jar 本体唯一
    expect(fs.readFileSync(OLD_JAR(), 'utf8')).toBe('OLD_JAR_CONTENT');
    expect(fs.existsSync(path.join(tmpDir, 'server-1.21.4.jar'))).toBe(false);
  });
});

// ── ③ 复制异步化：API 选择与调用语义（#520 实锤②） ──

describe('复制异步化：零 copyFileSync、promises.copyFile 参数正确', () => {
  it('升级全程（含回滚）零 fs.copyFileSync；备份走 .part 原子改名、回滚一次异步复制', async () => {
    const manager = createMockServerManager({ start: startEmitsCrash() });
    const service = new UpgradeService(manager);
    fs.writeFileSync(OLD_JAR(), 'OLD_JAR_CONTENT');

    const syncCopySpy = vi.spyOn(fs, 'copyFileSync');
    const asyncCopySpy = vi.spyOn(fs.promises, 'copyFile');
    const renameSpy = vi.spyOn(fs.promises, 'rename');

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      'Server crashed during startup verification',
    );

    // 同步 API 已彻底退出升级链路
    expect(syncCopySpy).not.toHaveBeenCalled();

    // 异步复制恰好两次：replace 阶段备份 + 回滚恢复（目标=旧 jar 本体路径，#539）。
    // 备份先写 .part 再改名：复制不可中断（取消/失败都可能落在复制中），
    // 只有原子改名才能保证 rollback 源要么不存在、要么是完整副本
    expect(asyncCopySpy).toHaveBeenCalledTimes(2);
    expect(asyncCopySpy).toHaveBeenNthCalledWith(1, OLD_JAR(), `${BACKUP_JAR()}.part`);
    expect(renameSpy).toHaveBeenCalledWith(`${BACKUP_JAR()}.part`, BACKUP_JAR());
    expect(asyncCopySpy).toHaveBeenNthCalledWith(2, BACKUP_JAR(), OLD_JAR());

    // 复制语义（内容恢复）由真实 fs 保证：旧 jar 本体内容 = 备份的旧内容
    expect(fs.readFileSync(OLD_JAR(), 'utf8')).toBe('OLD_JAR_CONTENT');
  });
});
