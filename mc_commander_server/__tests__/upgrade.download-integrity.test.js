/**
 * JAR 下载落地校验测试（issue 316）
 *
 * 覆盖：
 * ① guard 工具单测：hashFile 摘要计算 / assertDownloadIntegrity（null 跳过、
 *    匹配通过、不匹配 fail-closed 含期望与实际摘要）/ assertSizeWithinLimit
 *    （边界等值通过、超限抛错含字节数）
 * ② upgrade.service 集成：purpur 无上游摘要跳过校验；vanilla Piston manifest
 *    sha1 匹配通过；sha1 不匹配 → 残留清理 + failed 终态；体积超限（注入
 *    小上限）→ 断流 + 残留清理 + failed 终态
 *
 * 网络隔离：http-client 全量 mock（json/stream 行为按用例注入），保证 CI 离线确定性。
 * 摘要期望值一律动态计算（crypto.createHash），不写 hex 字面量。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── 可变 mock 实现（vi.hoisted：factory 内不得引用外部变量） ──
const { jsonImpl, streamImpl } = vi.hoisted(() => ({
  jsonImpl: { current: null },
  streamImpl: { current: null },
}));

vi.mock('../utils/http-client.js', () => ({
  // httpJson 的返回值即最终 JSON（无 .json 链）
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

vi.mock('../utils/audit.js', () => ({
  recordAudit: vi.fn(),
  AuditActions: {
    INSTANCE_UPGRADE: 'INSTANCE_UPGRADE',
    INSTANCE_UPGRADE_ROLLBACK: 'INSTANCE_UPGRADE_ROLLBACK',
  },
}));

import {
  JAR_DOWNLOAD_MAX_BYTES,
  JAR_HASH_ALGORITHMS,
  hashFile,
  assertDownloadIntegrity,
  assertSizeWithinLimit,
} from '../utils/jar-download-guard.js';
import { UpgradeService, UPGRADE_STAGES } from '../services/upgrade.service.js';
import { ErrorCodes, AppError } from '../utils/response.js';

// ── ① guard 工具单测（真实 fs） ──

let guardTmpDir;

beforeEach(() => {
  guardTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-jar-guard-'));
});

afterEach(() => {
  fs.rmSync(guardTmpDir, { recursive: true, force: true });
});

describe('jar-download-guard 工具', () => {
  it('hashFile 流式计算 sha256/sha1 与 crypto 直接计算一致', async () => {
    const filePath = path.join(guardTmpDir, 'payload.bin');
    const content = crypto.randomBytes(256);
    fs.writeFileSync(filePath, content);

    await expect(hashFile(filePath, 'sha256')).resolves.toBe(
      crypto.createHash('sha256').update(content).digest('hex'),
    );
    await expect(hashFile(filePath, 'sha1')).resolves.toBe(
      crypto.createHash('sha1').update(content).digest('hex'),
    );
  });

  it('JAR_DOWNLOAD_MAX_BYTES 常量为 512MB', () => {
    expect(JAR_DOWNLOAD_MAX_BYTES).toBe(512 * 1024 * 1024);
  });

  it('hashFile 流式计算 md5 与 crypto 直接计算一致（purpur 上游只给 md5）', async () => {
    const filePath = path.join(guardTmpDir, 'payload-md5.bin');
    const content = crypto.randomBytes(256);
    fs.writeFileSync(filePath, content);

    await expect(hashFile(filePath, 'md5')).resolves.toBe(
      crypto.createHash('md5').update(content).digest('hex'),
    );
  });

  it('JAR_HASH_ALGORITHMS 白名单只含 sha256/sha1/md5（未知算法必须被挡在比对之外）', () => {
    expect([...JAR_HASH_ALGORITHMS].sort()).toEqual(['md5', 'sha1', 'sha256']);
  });

  it('assertDownloadIntegrity：md5 摘要匹配通过、不匹配 fail-closed', async () => {
    const filePath = path.join(guardTmpDir, 'payload-md5-assert.bin');
    const content = crypto.randomBytes(256);
    fs.writeFileSync(filePath, content);
    const digest = crypto.createHash('md5').update(content).digest('hex');

    await expect(
      assertDownloadIntegrity(filePath, { algorithm: 'md5', digest }),
    ).resolves.toBeUndefined();

    await expect(
      assertDownloadIntegrity(filePath, { algorithm: 'md5', digest: 'f'.repeat(32) }),
    ).rejects.toThrow(/integrity check failed/);
  });

  it('assertDownloadIntegrity：expectedHash 为 null 或字段缺失时跳过（不抛）', async () => {
    const filePath = path.join(guardTmpDir, 'a.bin');
    fs.writeFileSync(filePath, 'whatever');
    await expect(assertDownloadIntegrity(filePath, null)).resolves.toBeUndefined();
    await expect(assertDownloadIntegrity(filePath, {})).resolves.toBeUndefined();
    await expect(
      assertDownloadIntegrity(filePath, { algorithm: 'sha256' }),
    ).resolves.toBeUndefined();
    await expect(assertDownloadIntegrity(filePath, { digest: 'abc' })).resolves.toBeUndefined();
  });

  it('assertDownloadIntegrity：摘要匹配通过', async () => {
    const filePath = path.join(guardTmpDir, 'ok.bin');
    const content = crypto.randomBytes(128);
    fs.writeFileSync(filePath, content);
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    await expect(
      assertDownloadIntegrity(filePath, { algorithm: 'sha256', digest }),
    ).resolves.toBeUndefined();
  });

  it('assertDownloadIntegrity：不匹配 fail-closed，错误含期望与实际摘要', async () => {
    const filePath = path.join(guardTmpDir, 'bad.bin');
    fs.writeFileSync(filePath, 'tampered');
    const expectedDigest = 'e'.repeat(64); // 动态构造，非真实字面量
    await expect(
      assertDownloadIntegrity(filePath, { algorithm: 'sha256', digest: expectedDigest }),
    ).rejects.toMatchObject({
      name: 'AppError',
      code: ErrorCodes.SERVER_ERROR.code,
    });
    await expect(
      assertDownloadIntegrity(filePath, { algorithm: 'sha256', digest: expectedDigest }),
    ).rejects.toThrow(/expected sha256=.*got .*/);
  });

  it('assertSizeWithinLimit：边界等值通过，超限抛错含实际字节数与上限', () => {
    expect(() => assertSizeWithinLimit(1024, 1024)).not.toThrow();
    expect(() => assertSizeWithinLimit(0, 1024)).not.toThrow();
    expect(() => assertSizeWithinLimit(2048, 1024)).toThrow(
      /2048 bytes received, exceeds size limit of 1024 bytes/,
    );
    expect(() => assertSizeWithinLimit(2048, 1024)).toThrow(AppError);
    // 默认参数走 512MB 常量
    expect(() => assertSizeWithinLimit(JAR_DOWNLOAD_MAX_BYTES + 1)).toThrow(/exceeds size limit/);
  });
});

// ── ② upgrade.service 集成（真实临时目录 + 真实 fs + fake stream） ──

let tmpDir;

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

const serverManagerRef = { current: null };

function createMockInstance(overrides = {}) {
  return {
    id: 'inst-1',
    name: 'Test Server',
    mcVersion: '1.20.4',
    jarFile: 'server-1.20.4.jar',
    serverPath: tmpDir,
    isRunning: false,
    start: vi.fn(() => {
      // 模拟首启 ready 事件（_startAndVerify 依赖）
      queueMicrotask(() =>
        serverManagerRef.current.emit('instance:status', {
          instanceId: 'inst-1',
          event: 'ready',
        }),
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

/** 模拟下载流：发一次进度后正常写完（文件内容 = 写入的 data 串，默认空） */
function streamSucceeds({ transferred = 1, total = 1, data = '' } = {}) {
  return () => {
    const stream = makeFakeStream();
    queueMicrotask(() => {
      // percent 忠实 httpStream 公式（total 未知记 0），使夹具在任何参数下都自洽
      stream._emit('downloadProgress', {
        percent: total > 0 ? transferred / total : 0,
        transferred,
        total,
      });
      if (data) stream._file.write(data);
      stream._file.end();
    });
    return stream;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-jar-dl-'));
  // purpur 现在会先查 /latest 取 md5 摘要；默认 mock 需能回答该查询，否则以 purpur
  // 为载体的用例会停在「offline」而非待测阶段。其余上游一律拒绝，保持隔离语义。
  jsonImpl.current = (url) => {
    if (String(url).includes('/purpur/')) return Promise.resolve({ build: '2416' });
    return Promise.reject(new Error('offline (mocked)'));
  };
  streamImpl.current = () => {
    const stream = makeFakeStream();
    queueMicrotask(() => stream._emit('error', new Error('download failed (mocked)')));
    return stream;
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function progressStages(serverManager) {
  return serverManager._emitted
    .filter((e) => e.event === 'instance:upgradeProgress')
    .map((e) => e.data.stage);
}

describe('upgrade.service 下载落地校验集成（issue 316）', () => {
  it('purpur：/latest 给出 md5 且匹配 → 校验通过完成升级', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);
    // fake 流写入空文件 → 期望摘要 = 空内容 md5（动态计算）
    const emptyMd5 = crypto.createHash('md5').update('').digest('hex');
    const realPurpur = jsonImpl.current;
    jsonImpl.current = (url) => {
      if (url.includes('/purpur/')) return Promise.resolve({ build: '2416', md5: emptyMd5 });
      return realPurpur(url);
    };
    streamImpl.current = streamSucceeds();

    await service.upgrade('inst-1', '1.21.4', 'purpur');

    expect(fs.readdirSync(tmpDir)).toContain('server-1.21.4.jar');
    expect(progressStages(serverManager)[progressStages(serverManager).length - 1]).toBe(
      UPGRADE_STAGES.COMPLETED,
    );
  });

  it('purpur：md5 不匹配 → 升级失败并清理残留（fail-closed）', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);
    const realPurpur = jsonImpl.current;
    jsonImpl.current = (url) => {
      if (url.includes('/purpur/')) return Promise.resolve({ build: '2416', md5: 'f'.repeat(32) });
      return realPurpur(url);
    };
    streamImpl.current = streamSucceeds();

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      /integrity check failed/,
    );
    expect(fs.readdirSync(tmpDir)).not.toContain('server-1.21.4.jar');
  });

  it('vanilla manifest 提供 sha1 且匹配：校验通过完成升级', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);
    // fake 流写入空文件（无 data）→ 期望摘要 = 空内容 sha1（动态计算）
    const emptySha1 = crypto.createHash('sha1').update('').digest('hex');
    jsonImpl.current = (url) => {
      if (url.includes('version_manifest')) {
        return Promise.resolve({
          versions: [
            { id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v.json' },
          ],
        });
      }
      return Promise.resolve({
        downloads: {
          server: { url: 'https://piston-data.mojang.com/server-1.21.4.jar', sha1: emptySha1 },
        },
      });
    };
    streamImpl.current = streamSucceeds();

    await service.upgrade('inst-1', '1.21.4', 'vanilla');

    expect(fs.readdirSync(tmpDir)).toContain('server-1.21.4.jar');
    expect(progressStages(serverManager)[progressStages(serverManager).length - 1]).toBe(
      UPGRADE_STAGES.COMPLETED,
    );
  });

  it('vanilla manifest sha1 不匹配：fail-closed，残留清理 + failed 终态', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);
    const forgedSha1 = 'a'.repeat(40); // 动态构造，与实际内容不符
    jsonImpl.current = (url) => {
      if (url.includes('version_manifest')) {
        return Promise.resolve({
          versions: [
            { id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v.json' },
          ],
        });
      }
      return Promise.resolve({
        downloads: {
          server: { url: 'https://piston-data.mojang.com/server-1.21.4.jar', sha1: forgedSha1 },
        },
      });
    };
    streamImpl.current = streamSucceeds();

    await expect(service.upgrade('inst-1', '1.21.4', 'vanilla')).rejects.toThrow(
      /Download integrity check failed: expected sha1=.*got .*/,
    );
    await expect(service.upgrade('inst-1', '1.21.4', 'vanilla')).rejects.toMatchObject({
      name: 'AppError',
      code: ErrorCodes.SERVER_ERROR.code,
    });

    const stages = progressStages(serverManager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);

    // 已下载部分被清理：实例目录无残留（旧 jar 本就不存在，回滚无副本）
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('体积超限（注入小上限）：断流清理 + 可读错误含实际字节数与上限', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager, { maxJarDownloadBytes: 10 });
    let destroyed = false;
    streamImpl.current = () => {
      const stream = makeFakeStream();
      stream.destroy = () => {
        destroyed = true;
      };
      queueMicrotask(() => {
        // transferred=11 > 上限 10：断言在进度广播前触发
        stream._emit('downloadProgress', { percent: 0, transferred: 11, total: 0 });
      });
      return stream;
    };

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      /11 bytes received, exceeds size limit of 10 bytes/,
    );
    expect(destroyed).toBe(true);

    const stages = progressStages(serverManager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('正常进度内不误伤：transferred 等于上限时不中断', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager, { maxJarDownloadBytes: 10 });
    streamImpl.current = streamSucceeds({ transferred: 10, total: 10 });

    await service.upgrade('inst-1', '1.21.4', 'purpur');
    expect(progressStages(serverManager)).toContain(UPGRADE_STAGES.COMPLETED);
  });
});
