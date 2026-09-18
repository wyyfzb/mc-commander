/**
 * 升级取消服务端行为面：
 * - 取消窗口各异（备份等待中 / 下载中 / 替换之后的首启校验中）各有正确的收尾
 * - 「替换前取消不需要回滚」与「替换后取消必须回滚」是两种口径，终态文案据实区分
 * - 校验阶段启动的实例必须被停掉（用户取消不该在后台留下他没启动过的服务器）
 * - 取消不自动恢复升级前备份（那是失败路径的行为）；注册表随之释放（幂等 + 可再升级）
 * 数据全部为虚构占位（1.2.3.4 / 演示实例）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const testState = vi.hoisted(() => ({
  tmpDir: null,
  /** hang = 下载挂起（停在下载阶段等取消）；success = 写完即结束（可推进到 verify）；failure = 立即报错 */
  streamBehavior: 'hang',
  /** true = 备份永不回执（停在备份等待阶段等取消） */
  backupHang: false,
}));

/** 下载流桩：hang 模式永不结束（把升级停在下载阶段），failure 模式立即 error */
vi.mock('got', () => ({
  default: Object.assign(vi.fn(() => Promise.reject(new Error('offline (mocked)'))), {
    stream: vi.fn(() => {
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
      stream._emit = (ev, ...args) => (listeners[ev] || []).forEach((cb) => cb(...args));
      if (testState.streamBehavior === 'failure') {
        queueMicrotask(() => stream._emit('error', new Error('download failed (mocked)')));
      } else if (testState.streamBehavior === 'success') {
        // 真正落盘并 end：只有 end 才触发 file.on('finish') → 摘要校验 → 推进到 verify
        queueMicrotask(() => {
          stream._emit('downloadProgress', { percent: 1, transferred: 1, total: 1 });
          stream._file.end();
        });
      }
      return stream;
    }),
  }),
}));

/** 备份服务桩：createBackup 触发完成事件（除非处于 backup-hang 模式）；restore 记录调用 */
vi.mock('../services/backup.service.js', () => ({
  BackupService: class {
    constructor(serverManager) {
      this.serverManager = serverManager;
      this.restoreCalls = 0;
    }
    async createBackup(instanceId) {
      if (!testState.backupHang) {
        queueMicrotask(() => this.serverManager.emit('instance:backupComplete', { instanceId, backupId: 'bk-mock' }));
      }
      return 'bk-mock';
    }
    async restoreBackup() {
      this.restoreCalls += 1;
      return { restored: true };
    }
  },
}));

vi.mock('../db/index.js', () => ({ InstanceModel: { update: vi.fn() } }));
vi.mock('../utils/audit.js', () => ({
  recordAudit: vi.fn(),
  AuditActions: { INSTANCE_UPGRADE: 'INSTANCE_UPGRADE', INSTANCE_UPGRADE_ROLLBACK: 'INSTANCE_UPGRADE_ROLLBACK' },
}));

const { createUpgradeRoutes } = await import('../routes/upgrade.js');
const { UpgradeService, UPGRADE_STAGES } = await import('../services/upgrade.service.js');
const { cancelTask, TASK_KINDS } = await import('../utils/cancellable-task.js');
const { InstanceModel } = await import('../db/index.js');

const OLD_JAR_NAME = 'server-1.20.4.jar';

function createMockServerManager(instanceOverrides = {}) {
  const instance = {
    id: 'inst-1',
    name: '演示实例',
    mcVersion: '1.20.4',
    jarFile: OLD_JAR_NAME,
    serverPath: testState.tmpDir,
    isRunning: false,
    start: vi.fn(),
    stop: vi.fn(),
    stopGracefully: vi.fn(async () => {}),
    ...instanceOverrides,
  };
  const listeners = {};
  const emitted = [];
  return {
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
}

function createApp(serverManager) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'admin' };
    next();
  });
  app.use('/api/v1', createUpgradeRoutes(serverManager));
  return app;
}

function progressEvents(manager) {
  return manager._emitted.filter((e) => e.event === 'instance:upgradeProgress').map((e) => e.data);
}

function stages(manager) {
  return progressEvents(manager).map((p) => p.stage);
}

/** 取最后一条终态事件 */
function terminalEvent(manager) {
  const events = progressEvents(manager);
  return events[events.length - 1];
}

/** 等到出现指定阶段（升级流程是异步的） */
async function waitForStage(manager, stage, { tries = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (stages(manager).includes(stage)) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`waitForStage: 未观察到阶段 ${stage}`);
}

beforeEach(() => {
  testState.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-upgrade-cancel-'));
  testState.streamBehavior = 'hang';
  testState.backupHang = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(testState.tmpDir, { recursive: true, force: true });
});

describe('POST /instances/:id/upgrade/cancel 受理语义', () => {
  it('无在途升级：409 UPGRADE_NOT_IN_PROGRESS（不静默成功）', async () => {
    const manager = createMockServerManager();
    const request = supertest(createApp(manager));
    const res = await request.post('/api/v1/instances/inst-1/upgrade/cancel');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40908);
  });

  it('受理在途升级：200 + cancelled，且按实例 id 精确匹配（别的实例不受影响）', async () => {
    const manager = createMockServerManager();
    const request = supertest(createApp(manager));
    const service = new UpgradeService(manager);
    const upgrading = service.upgrade('inst-1', '1.21.4', 'purpur');
    await waitForStage(manager, 'download');

    const wrong = await request.post('/api/v1/instances/inst-other/upgrade/cancel');
    expect(wrong.status).toBe(409);

    const res = await request.post('/api/v1/instances/inst-1/upgrade/cancel');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ instanceId: 'inst-1', cancelled: true });
    await upgrading;
  });
});

describe('取消窗口与收尾口径', () => {
  it('备份等待中取消：无替换也无回滚，终态 cancelled 且说明实例保持旧版本', async () => {
    testState.backupHang = true;
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    const upgrading = service.upgrade('inst-1', '1.21.4', 'purpur');
    await waitForStage(manager, 'backup');

    const cancelled = cancelTask(TASK_KINDS.UPGRADE, 'inst-1');
    expect(cancelled).toBe(true);
    await upgrading;

    const terminal = terminalEvent(manager);
    expect(terminal.stage).toBe(UPGRADE_STAGES.CANCELLED);
    expect(terminal.detail).toContain('保持 1.20.4');
    expect(stages(manager)).not.toContain(UPGRADE_STAGES.ROLLED_BACK);
    // 取消不是故障：不记 restore、不写回 DB
    expect(service.backupService.restoreCalls).toBe(0);
    expect(InstanceModel.update).not.toHaveBeenCalled();
    expect(service.isUpgrading('inst-1')).toBe(false);
  });

  it('下载中取消：断流并删除半成品，终态 cancelled（替换前不需要回滚）', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    const upgrading = service.upgrade('inst-1', '1.21.4', 'purpur');
    await waitForStage(manager, 'download');

    expect(cancelTask(TASK_KINDS.UPGRADE, 'inst-1')).toBe(true);
    await upgrading;

    const terminal = terminalEvent(manager);
    expect(terminal.stage).toBe(UPGRADE_STAGES.CANCELLED);
    expect(terminal.detail).toContain('保持 1.20.4');
    expect(stages(manager)).not.toContain(UPGRADE_STAGES.ROLLED_BACK);
    // 下载半成品不留在实例目录（新增 jar 名与 .part 都不该存在）
    expect(fs.existsSync(path.join(testState.tmpDir, 'server-1.21.4.jar'))).toBe(false);
    expect(fs.readdirSync(testState.tmpDir).some((f) => f.endsWith('.part'))).toBe(false);
  });

  it('替换复制窗口内取消（新 jar 已下载）：清掉下载产物与 .part，实例保持旧版本', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    const oldJarPath = path.join(testState.tmpDir, OLD_JAR_NAME);
    fs.writeFileSync(oldJarPath, 'OLD_JAR_CONTENT');
    testState.streamBehavior = 'success';

    // 复制旧 jar 期间安排取消（复制不可中断，取消在复制结束后经 await 边界生效）：
    // 该窗口内新 jar 已完整落盘，是本用例要覆盖的清理缺口
    const realCopy = fs.promises.copyFile;
    const copySpy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      const result = await realCopy(...args);
      cancelTask(TASK_KINDS.UPGRADE, 'inst-1');
      return result;
    });

    const upgrading = service.upgrade('inst-1', '1.21.4', 'purpur');
    await upgrading;
    copySpy.mockRestore();

    const terminal = terminalEvent(manager);
    expect(terminal.stage).toBe(UPGRADE_STAGES.CANCELLED);
    expect(terminal.detail).toContain('保持 1.20.4');
    expect(stages(manager)).not.toContain(UPGRADE_STAGES.ROLLED_BACK);
    // 磁盘回到升级前：只剩旧 jar，新 jar 与 .part 都不留
    expect(fs.readdirSync(testState.tmpDir).sort()).toEqual([OLD_JAR_NAME]);
    expect(fs.readFileSync(oldJarPath, 'utf8')).toBe('OLD_JAR_CONTENT');
    expect(InstanceModel.update).not.toHaveBeenCalled();
  });

  it('首启校验中取消：回滚到旧版本 + 停掉校验用的实例 + 不自动恢复备份', async () => {
    const manager = createMockServerManager({
      // start 后不发射 ready：升级停在 verify 阶段等取消
      start: vi.fn(),
    });
    const service = new UpgradeService(manager);
    fs.writeFileSync(path.join(testState.tmpDir, OLD_JAR_NAME), 'OLD_JAR_CONTENT');
    testState.streamBehavior = 'success'; // 让下载走完，把升级推进到「替换完成、校验中」

    const upgrading = service.upgrade('inst-1', '1.21.4', 'purpur');
    await waitForStage(manager, 'verify');

    expect(cancelTask(TASK_KINDS.UPGRADE, 'inst-1')).toBe(true);
    await upgrading;

    // 实例被启动过又被停稳（stopGracefully 置 _manualStop 并等进程退出，回滚才安全）
    expect(manager._instance.start).toHaveBeenCalled();
    expect(manager._instance.stopGracefully).toHaveBeenCalled();
    // 替换后取消 ⇒ 必须回滚：jarFile/mcVersion 回写旧值，旧 jar 内容恢复
    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      jarFile: OLD_JAR_NAME,
      mcVersion: '1.20.4',
    });
    expect(manager._instance.jarFile).toBe(OLD_JAR_NAME);
    expect(manager._instance.mcVersion).toBe('1.20.4');
    expect(fs.readFileSync(path.join(testState.tmpDir, OLD_JAR_NAME), 'utf8')).toBe('OLD_JAR_CONTENT');

    const terminal = terminalEvent(manager);
    expect(terminal.stage).toBe(UPGRADE_STAGES.CANCELLED);
    expect(terminal.detail).toContain('已回滚到 1.20.4');
    // 取消全程不发 rolled_back：该档在 WS 层映射为「升级失败」并落库（通知中心严重档），
    // 复用会把自己主动取消显示成故障
    expect(stages(manager)).not.toContain(UPGRADE_STAGES.ROLLED_BACK);
    // 取消不触发世界恢复（失败路径才恢复）：避免「取消」变成看不见的分钟级长任务
    expect(service.backupService.restoreCalls).toBe(0);
    expect(service.isUpgrading('inst-1')).toBe(false);
  });

  it('替换落定后立刻取消（校验未开始）：仍走回滚而不是被吞成失败', async () => {
    const manager = createMockServerManager({ start: vi.fn() });
    const service = new UpgradeService(manager);
    fs.writeFileSync(path.join(testState.tmpDir, OLD_JAR_NAME), 'OLD_JAR_CONTENT');
    testState.streamBehavior = 'success';

    // 在 DB 切换那一刻注入取消：这是「替换已落定、校验尚未开始」的窗口，
    // 只有明确补了 await 边界判据才会被认成取消（漏了就会被 _startAndVerify 兜住后
    // 以「升级失败」收场，并触发一次取消本不该有的世界恢复）
    const updateSpy = vi.spyOn(InstanceModel, 'update').mockImplementation(() => {
      cancelTask(TASK_KINDS.UPGRADE, 'inst-1');
    });

    const upgrading = service.upgrade('inst-1', '1.21.4', 'purpur');
    await upgrading;
    updateSpy.mockRestore();

    const terminal = terminalEvent(manager);
    expect(terminal.stage).toBe(UPGRADE_STAGES.CANCELLED);
    expect(terminal.detail).toContain('已回滚到 1.20.4');
    expect(manager._instance.jarFile).toBe(OLD_JAR_NAME);
    expect(service.backupService.restoreCalls).toBe(0);
  });

  it('取消后注册表释放：重复取消回 40908，且可再次发起升级', async () => {
    const manager = createMockServerManager();
    const request = supertest(createApp(manager));
    const service = new UpgradeService(manager);
    const upgrading = service.upgrade('inst-1', '1.21.4', 'purpur');
    await waitForStage(manager, 'download');
    await request.post('/api/v1/instances/inst-1/upgrade/cancel');
    await upgrading;

    const again = await request.post('/api/v1/instances/inst-1/upgrade/cancel');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe(40908);

    // 再次升级：注册表已释放，不会被 UPGRADE_IN_PROGRESS 拦
    testState.streamBehavior = 'failure';
    const res = await request.post('/api/v1/instances/inst-1/upgrade').send({ mcVersion: '1.21.4', type: 'purpur' });
    expect(res.status).toBe(202);
    // 等这次升级走完（下载立即失败 → failed 终态）再断言，避免跨用例残留
    await vi.waitFor(() => expect(stages(manager)).toContain(UPGRADE_STAGES.FAILED));
  });
});
