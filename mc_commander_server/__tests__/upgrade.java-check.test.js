/**
 * 升级路径的 Java 校验（任务 8）。
 *
 * 承重点：跨 Java 大版本升级（1.20.x 的 Java 17 → 26.3 的 Java 25）此前会把 DB 与
 * 实例 jar 都改完，才在首启时崩掉——用户拿到的是「升完起不来」，而那时已是最难回退的
 * 时点。故校验**必须落在替换之前**：本文件最重要的一条断言不是「会报错」，而是
 * **报错时替换还没发生**（jar 未改、DB 未改、没有 replace 阶段事件）。
 *
 * 权威来源是 jar 内 `version.json` 的 `java_version`（服务端自带），不手写版本矩阵；
 * 本文件把该读取与 Java 探测都 mock 掉，测的是**接线与顺序**，不是版本矩阵本身。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { jsonImpl, streamImpl, jarInfo, javaState } = vi.hoisted(() => ({
  jsonImpl: { current: null },
  streamImpl: { current: null },
  jarInfo: { current: { id: '26.3', javaVersion: 25, protocolVersion: 769 } },
  javaState: { satisfied: false, replacement: '/usr/lib/jvm/java-25/bin/java' },
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

vi.mock('../db/index.js', () => ({ InstanceModel: { update: vi.fn() } }));

vi.mock('../utils/audit.js', () => ({
  recordAudit: vi.fn(),
  AuditActions: { INSTANCE_UPGRADE: 'INSTANCE_UPGRADE', INSTANCE_UPGRADE_ROLLBACK: 'X' },
}));

// 新 jar 的 java_version：受用例控制
vi.mock('../services/mc-server/jar-version.js', () => ({
  readJarVersionInfo: vi.fn(() => jarInfo.current),
}));

// Java 探测：受用例控制（真实实现会扫本机 /usr/lib/jvm，结果不可控）
vi.mock('../utils/java-detector.js', () => ({
  getRecommendedJavaVersion: vi.fn(() => '25'),
  isJavaSatisfied: vi.fn(() => javaState.satisfied),
  findJavaPathStrict: vi.fn(() => javaState.replacement),
}));

import { UpgradeService, UPGRADE_STAGES } from '../services/upgrade.service.js';
import { InstanceModel } from '../db/index.js';
import { isJavaSatisfied, findJavaPathStrict } from '../utils/java-detector.js';
import { readJarVersionInfo } from '../services/mc-server/jar-version.js';

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
    destroy() {},
  };
  stream._emit = (ev, ...args) => (listeners[ev] || []).forEach((cb) => cb(...args));
  return stream;
}

function createMockServerManager(overrides = {}) {
  const instance = {
    id: 'inst-1',
    name: 'Test Server',
    mcVersion: '1.20.4',
    jarFile: 'server-1.20.4.jar',
    javaPath: '/usr/lib/jvm/java-17/bin/java',
    serverPath: tmpDir,
    isRunning: false,
    start: vi.fn(() => {
      queueMicrotask(() =>
        serverManagerRef.current.emit('instance:status', { instanceId: 'inst-1', event: 'ready' }),
      );
    }),
    ...overrides,
  };
  const listeners = {};
  const emitted = [];
  const manager = {
    getInstance: vi.fn((id) => (id === instance.id ? instance : null)),
    on: vi.fn((event, fn) => {
      (listeners[event] = listeners[event] || []).push(fn);
    }),
    removeListener: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upgrade-java-'));
  // 旧 jar 存在：用于断言「中止时旧 jar 仍在、新 jar 未落位」
  fs.writeFileSync(path.join(tmpDir, 'server-1.20.4.jar'), 'old-jar-bytes');
  jsonImpl.versions = ['26.3'];
  jarInfo.current = { id: '26.3', javaVersion: 25, protocolVersion: 769 };
  javaState.satisfied = false;
  javaState.replacement = '/usr/lib/jvm/java-25/bin/java';
  // vanilla 详情 + 成功的下载流（写入目标文件）
  // 清单按请求回显目标版本（升级到哪个版本由用例决定，写死单条会让换版本的用例
  // 停在「版本不存在」而不是待测阶段）
  jsonImpl.current = (url) => {
    if (String(url).includes('version_manifest')) {
      return Promise.resolve({
        versions: (jsonImpl.versions || ['26.3']).map((id) => ({
          id,
          type: 'release',
          url: 'https://piston-meta.mojang.com/v.json',
        })),
      });
    }
    return Promise.resolve({
      downloads: { server: { url: 'https://piston-data.mojang.com/server.jar' } },
    });
  };
  // 与升级链路既有的「成功下载」夹具一致：进度事件 + 把文件流收尾（仅 emit 'end'
  // 不足以让 pipe 目标落盘，会停在下载中直到测试超时）
  streamImpl.current = () => {
    const stream = makeFakeStream();
    queueMicrotask(() => {
      stream._emit('downloadProgress', { percent: 1, transferred: 1, total: 1 });
      if (stream._file) stream._file.end();
    });
    return stream;
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('升级路径的 Java 校验', () => {
  it('当前 Java 满足 → 不动 javaPath，也不写 DB 的 javaPath', async () => {
    javaState.satisfied = true;
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);

    await service.upgrade('inst-1', '26.3', 'vanilla');

    expect(findJavaPathStrict).not.toHaveBeenCalled();
    expect(manager._instance.javaPath).toBe('/usr/lib/jvm/java-17/bin/java');
    const javaWrites = InstanceModel.update.mock.calls.filter(([, p]) => 'javaPath' in p);
    expect(javaWrites).toEqual([]);
  });

  it('当前 Java 不满足但有可替代版本 → 自动重选并落库', async () => {
    javaState.satisfied = false;
    javaState.replacement = '/usr/lib/jvm/java-25/bin/java';
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);

    await service.upgrade('inst-1', '26.3', 'vanilla');

    expect(isJavaSatisfied).toHaveBeenCalledWith('/usr/lib/jvm/java-17/bin/java', '25');
    expect(manager._instance.javaPath).toBe('/usr/lib/jvm/java-25/bin/java');
    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      javaPath: '/usr/lib/jvm/java-25/bin/java',
    });
  });

  it('不满足且无可选版本 → 抛错，且**替换尚未发生**（jar/DB/replace 阶段都没动）', async () => {
    javaState.satisfied = false;
    javaState.replacement = null; // 严格版返回 null ＝ 本机没有满足要求的 Java
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);

    await expect(service.upgrade('inst-1', '26.3', 'vanilla')).rejects.toThrow(/需要 Java 25/);

    // 这是本文件的核心断言：校验必须落在替换之前
    const replaceEvents = manager._emitted.filter((e) => e.data?.stage === UPGRADE_STAGES.REPLACE);
    expect(replaceEvents).toEqual([]);
    // 不得写入**新版本**的 jarFile/mcVersion（回滚路径会把旧值写回去，那是允许的）
    expect(InstanceModel.update).not.toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-26.3.jar',
      mcVersion: '26.3',
    });
    // 旧 jar 仍在且实例仍指向它（新 jar 已下载到磁盘，但那不影响「没换」这个事实：
    // 换的判据是 DB 与实例字段，而非文件是否存在）
    expect(fs.existsSync(path.join(tmpDir, 'server-1.20.4.jar'))).toBe(true);
    expect(manager._instance.jarFile).toBe('server-1.20.4.jar');
  });

  it('jar 未带 java_version → 退回推荐表，仍会做校验（不静默跳过）', async () => {
    jarInfo.current = { id: '26.3', javaVersion: null, protocolVersion: 769 };
    javaState.satisfied = false;
    javaState.replacement = '/usr/lib/jvm/java-25/bin/java';
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);

    await service.upgrade('inst-1', '26.3', 'vanilla');

    // 推荐表给出 25（mock），校验照做 ⇒ 触发重选
    expect(isJavaSatisfied).toHaveBeenCalledWith(expect.any(String), '25');
    expect(manager._instance.javaPath).toBe('/usr/lib/jvm/java-25/bin/java');
  });

  it('读 jar 版本信息返回 null → 仍走推荐表（不因读不到就放弃）', async () => {
    jarInfo.current = null;
    javaState.satisfied = true;
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);

    await service.upgrade('inst-1', '26.3', 'vanilla');

    expect(readJarVersionInfo).toHaveBeenCalled();
    expect(isJavaSatisfied).toHaveBeenCalledWith(expect.any(String), '25');
  });

  it('按 jar 内 java_version 判定（不是按 MC 版本号猜）', async () => {
    // 目标 MC 版本相同，但 jar 声明的 java_version 不同 ⇒ 判定输入应当随之变化
    // 目标版本与实例当前版本必须不同（同版本升级被路由层拒），故用 1.20.5
    jsonImpl.versions = ['1.20.5'];
    jarInfo.current = { id: '1.20.5', javaVersion: 17, protocolVersion: 766 };
    javaState.satisfied = true;
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);

    await service.upgrade('inst-1', '1.20.5', 'vanilla');

    expect(isJavaSatisfied).toHaveBeenCalledWith(expect.any(String), '17');
  });
});
