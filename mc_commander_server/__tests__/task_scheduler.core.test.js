import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- 模块替身（mock 路径相对本测试文件，解析后与 SUT 的依赖同源）----
// config 替身提供 logger 容错所需字段（logLevel/dataDir，见 utils/logger.js 头注释），
// panelBackup 开关由各用例按需切换（beforeEach 重置回 false）
vi.mock('../config.js', () => ({
  default: {
    panelBackup: { enabled: false, cron: '0 4 * * *' },
    retentionPrune: {
      enabled: false,
      cron: '30 4 * * *',
      auditLogDays: 90,
      webhookDeliveryDays: 30,
    },
    backupInProgressTimeoutMs: 30 * 60 * 1000,
    logLevel: 'debug',
    dataDir: './data',
  },
}));
vi.mock('../db/scheduled_task.model.js', () => ({
  ScheduledTaskModel: {
    getEnabledTasks: vi.fn(() => []),
    updateLastRun: vi.fn(),
    updateLastRunStatus: vi.fn(),
    findById: vi.fn(),
  },
}));
vi.mock('../db/ban.model.js', () => ({
  BanModel: {
    findExpiredActive: vi.fn(() => []),
    deactivate: vi.fn(),
  },
}));
vi.mock('../db/backup.model.js', () => ({
  BackupModel: {
    findAll: vi.fn(() => ({ total: 0 })),
    resetStaleInProgress: vi.fn(() => 0),
  },
}));
vi.mock('../services/backup.service.js', () => ({
  BackupService: class {
    constructor() {}
    createBackup = vi.fn(() => Promise.resolve({}));
  },
}));
vi.mock('../services/panel-backup.service.js', () => ({
  runPanelBackupCycle: vi.fn(),
  getLatestSnapshotTime: vi.fn(() => null),
}));
vi.mock('../db/audit.model.js', () => ({
  AuditLogModel: { prune: vi.fn(() => 0) },
}));
vi.mock('../db/webhook.model.js', () => ({
  WebhookModel: { pruneDeliveries: vi.fn(() => 0) },
}));

import { TaskScheduler, findMissedTrigger } from '../services/task_scheduler.js';
import { ScheduledTaskModel } from '../db/scheduled_task.model.js';
import { BanModel } from '../db/ban.model.js';
import { runPanelBackupCycle, getLatestSnapshotTime } from '../services/panel-backup.service.js';
import config from '../config.js';
import { logger } from '../utils/logger.js';
import { toDbUtcString } from '../utils/db-time.js';
import { asInstance } from './helpers/msmp-instance.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TaskScheduler - 调度主链（启停 / 主循环 / 解封 / 任务分派）', () => {
  let scheduler;
  let mockManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // 静音日志（同时供 catch 分支断言调用参数；restore 在 afterEach 归还原实现）
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    config.panelBackup.enabled = false;
    config.panelBackup.cron = '0 4 * * *';
    mockManager = {
      getInstance: vi.fn(() => undefined),
      getRunningInstances: vi.fn(() => []),
      emit: vi.fn(),
    };
    scheduler = new TaskScheduler(mockManager);
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ---------- 启停生命周期 ----------

  describe('start / stop 生命周期', () => {
    it('start：注册 60s 轮询 + 补跑检查 + 立即执行首轮 + 同秒重复 start 不重复注册', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T10:30:45'));

      scheduler.start();
      scheduler.start(); // running 守卫：第二次调用应直接 return

      expect(scheduler.running).toBe(true);
      // 启动各拉一次：补跑检查 + 主循环首轮（无错过任务时补跑为空转）
      expect(ScheduledTaskModel.getEnabledTasks).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(60 * 1000);
      expect(ScheduledTaskModel.getEnabledTasks).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(60 * 1000);
      expect(ScheduledTaskModel.getEnabledTasks).toHaveBeenCalledTimes(4);
    });

    it('start：面板快照开关关闭时不注册快照 cron（panelBackupCron 保持 null）', () => {
      config.panelBackup.enabled = false;
      scheduler.start();
      expect(scheduler.panelBackupCron).toBeNull();
    });

    it('stop：清轮询定时器 + 停快照 cron 并置 null', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T10:30:45'));
      config.panelBackup.enabled = true;
      config.panelBackup.cron = '0 4 * * *';

      scheduler.start();
      expect(scheduler.panelBackupCron).not.toBeNull();

      scheduler.stop();
      expect(scheduler.running).toBe(false);
      expect(scheduler.interval).toBeNull();
      expect(scheduler.panelBackupCron).toBeNull();

      const callsAfterStop = ScheduledTaskModel.getEnabledTasks.mock.calls.length;
      vi.advanceTimersByTime(5 * 60 * 1000);
      // 轮询已清：快进 5 分钟不再触发新一轮检查
      expect(ScheduledTaskModel.getEnabledTasks.mock.calls.length).toBe(callsAfterStop);
    });

    it('stop：未 start 时调用安全（interval 与 cron 均为空仍不抛）', () => {
      expect(() => scheduler.stop()).not.toThrow();
      expect(scheduler.running).toBe(false);
    });
  });

  // ---------- 面板库每日快照 ----------

  describe('面板库每日快照（独立 croner 实例）', () => {
    it('开关开启且表达式合法：注册快照 cron（不进用户定时任务体系）', () => {
      config.panelBackup.enabled = true;
      scheduler.startPanelBackupCron();
      expect(scheduler.panelBackupCron).not.toBeNull();
      expect(typeof scheduler.panelBackupCron.stop).toBe('function');
    });

    it('快照 cron 到点触发 runPanelBackup（fake timers 驱动 croner 回调）', async () => {
      config.panelBackup.enabled = true;
      config.panelBackup.cron = '* * * * *';
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T10:30:45'));
      runPanelBackupCycle.mockResolvedValue({
        filePath: '/tmp/panel/panel-20260904.tar.gz',
        sizeBytes: 1024,
        deletedCount: 0,
      });

      scheduler.startPanelBackupCron();
      // 虚拟时间跨过 10:31:00 分钟边界：croner 调度回调在 fake timers 下触发
      await vi.advanceTimersByTimeAsync(61 * 1000);

      expect(runPanelBackupCycle).toHaveBeenCalledTimes(1);
    });

    it('表达式非法：注册失败仅记日志（快照故障不干扰调度主循环）', () => {
      config.panelBackup.enabled = true;
      config.panelBackup.cron = 'not-a-cron';
      scheduler.startPanelBackupCron();
      expect(scheduler.panelBackupCron).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'Panel backup cron register failed:',
        expect.any(String),
      );
    });

    it('runPanelBackup：快照成功记含文件名/体积/清理数的日志', async () => {
      runPanelBackupCycle.mockResolvedValue({
        filePath: '/tmp/panel/panel-20260904.tar.gz',
        sizeBytes: 2048,
        deletedCount: 3,
      });
      await scheduler.runPanelBackup();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('snapshot ok: panel-20260904.tar.gz'),
      );
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('(2 KB), cleaned 3'));
    });

    it('runPanelBackup：快照失败仅记日志不抛（调度循环隔离）', async () => {
      runPanelBackupCycle.mockRejectedValue(new Error('disk full'));
      await expect(scheduler.runPanelBackup()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith('[PanelBackup] snapshot failed:', 'disk full');
    });
  });

  // ---------- 调度主循环 ----------

  describe('checkAndRunTasks 调度主循环', () => {
    it('同一分钟内重复调用被守卫拦截（不重复拉取任务）', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T10:30:45'));

      scheduler.checkAndRunTasks();
      scheduler.checkAndRunTasks(); // 同分钟：直接 return
      expect(ScheduledTaskModel.getEnabledTasks).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-09-04T10:31:01'));
      scheduler.checkAndRunTasks();
      expect(ScheduledTaskModel.getEnabledTasks).toHaveBeenCalledTimes(2);
    });

    it('每轮先做到期临时封禁检查（checkExpiredBans 前置）', () => {
      scheduler.checkAndRunTasks();
      expect(BanModel.findExpiredActive).toHaveBeenCalledTimes(1);
    });

    it('cron 匹配当前分钟则执行任务（秒非零的触发时刻已对齐分钟边界）', () => {
      // 系统时间秒=30：croner 严格匹配会因秒数误判 false，
      // 调度器须清零秒/毫秒后再匹配（L88-92 修复语义的回归保护）
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T10:30:30'));
      const inst = { isRunning: true, restart: vi.fn() };
      mockManager.getInstance.mockReturnValue(inst);
      ScheduledTaskModel.getEnabledTasks.mockReturnValue([
        { id: 1, instanceId: 's1', name: '每日重启', type: 'restart', cronExpression: '* * * * *' },
      ]);

      scheduler.checkAndRunTasks();

      expect(inst.restart).toHaveBeenCalledTimes(1);
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'success',
      );
    });

    it('cron 不匹配当前分钟则不执行（9 月不会命中 1 月 1 日的表达式）', () => {
      ScheduledTaskModel.getEnabledTasks.mockReturnValue([
        { id: 2, instanceId: 's1', name: '新年任务', type: 'restart', cronExpression: '0 0 1 1 *' },
      ]);

      scheduler.checkAndRunTasks();

      expect(ScheduledTaskModel.updateLastRun).not.toHaveBeenCalled();
      expect(mockManager.emit).not.toHaveBeenCalledWith('instance:taskExecute', expect.anything());
    });

    it('单个任务表达式非法：仅该任务跳过，后续任务继续检查', () => {
      const inst = { isRunning: true, restart: vi.fn() };
      mockManager.getInstance.mockReturnValue(inst);
      ScheduledTaskModel.getEnabledTasks.mockReturnValue([
        { id: 3, instanceId: 's1', name: '坏表达式', type: 'restart', cronExpression: 'bad-cron' },
        { id: 4, instanceId: 's1', name: '好任务', type: 'restart', cronExpression: '* * * * *' },
      ]);

      scheduler.checkAndRunTasks();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error checking task 3'),
        expect.anything(),
      );
      expect(inst.restart).toHaveBeenCalledTimes(1); // 只有任务 4 执行
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        4,
        expect.any(String),
        'success',
      );
    });

    it('任务列表拉取失败：整体捕获不向调用方抛出（interval 回调不被打断）', () => {
      ScheduledTaskModel.getEnabledTasks.mockImplementation(() => {
        throw new Error('db down');
      });
      expect(() => scheduler.checkAndRunTasks()).not.toThrow();
      expect(logger.error).toHaveBeenCalledWith(
        'Error checking scheduled tasks:',
        expect.any(Error),
      );
    });
  });

  // ---------- 临时封禁到期自动解封 ----------

  describe('checkExpiredBans 到期自动解封', () => {
    const ipBan = { id: 7, instanceId: 's1', targetType: 'ip', target: '1.2.3.4' };
    const playerBan = { id: 8, instanceId: 's1', targetType: 'player', target: 'Steve' };

    it('无到期记录：不查询实例也不发送命令', () => {
      BanModel.findExpiredActive.mockReturnValue([]);
      scheduler.checkExpiredBans();
      expect(mockManager.getInstance).not.toHaveBeenCalled();
    });

    it('IP 封禁到期：实例运行中下发 pardon-ip，成功后解封记录失效', async () => {
      const inst = asInstance({ isRunning: true, sendCommand: vi.fn(() => Promise.resolve()) });
      mockManager.getInstance.mockReturnValue(inst);
      BanModel.findExpiredActive.mockReturnValue([ipBan]);

      scheduler.checkExpiredBans();
      await flush();

      expect(mockManager.getInstance).toHaveBeenCalledWith('s1');
      expect(inst.sendCommand).toHaveBeenCalledWith('pardon-ip 1.2.3.4');
      expect(BanModel.deactivate).toHaveBeenCalledWith(7);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Auto-pardoned ip 1.2.3.4'));
    });

    it('玩家封禁到期：下发原版 pardon 命令', async () => {
      const inst = asInstance({ isRunning: true, sendCommand: vi.fn(() => Promise.resolve()) });
      mockManager.getInstance.mockReturnValue(inst);
      BanModel.findExpiredActive.mockReturnValue([playerBan]);

      scheduler.checkExpiredBans();
      await flush();

      expect(inst.sendCommand).toHaveBeenCalledWith('pardon Steve');
      expect(BanModel.deactivate).toHaveBeenCalledWith(8);
    });

    it('实例未运行：跳过且记录保持生效（实例启动后下一轮再处理）', () => {
      const inst = asInstance({ isRunning: false, sendCommand: vi.fn() });
      mockManager.getInstance.mockReturnValue(inst);
      BanModel.findExpiredActive.mockReturnValue([ipBan]);

      scheduler.checkExpiredBans();

      expect(inst.sendCommand).not.toHaveBeenCalled();
      expect(BanModel.deactivate).not.toHaveBeenCalled();
    });

    it('实例已删除（getInstance 返回空）：跳过处理', () => {
      mockManager.getInstance.mockReturnValue(undefined);
      BanModel.findExpiredActive.mockReturnValue([ipBan]);

      scheduler.checkExpiredBans();

      expect(BanModel.deactivate).not.toHaveBeenCalled();
    });

    it('全服封禁（无 instanceId）：不查实例直接跳过', () => {
      BanModel.findExpiredActive.mockReturnValue([
        { id: 9, instanceId: null, targetType: 'ip', target: '1.2.3.4' },
      ]);

      scheduler.checkExpiredBans();

      expect(mockManager.getInstance).not.toHaveBeenCalled();
      expect(BanModel.deactivate).not.toHaveBeenCalled();
    });

    it('命令下发失败：保留记录下轮重试（不 deactivate）', async () => {
      const inst = asInstance({
        isRunning: true,
        sendCommand: vi.fn(() => Promise.reject(new Error('rcon down'))),
      });
      mockManager.getInstance.mockReturnValue(inst);
      BanModel.findExpiredActive.mockReturnValue([ipBan]);

      scheduler.checkExpiredBans();
      await flush();

      expect(BanModel.deactivate).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to auto-pardon 1.2.3.4'),
        'rcon down',
      );
    });

    it('到期记录扫描失败：整体捕获不抛出', () => {
      BanModel.findExpiredActive.mockImplementation(() => {
        throw new Error('db down');
      });
      expect(() => scheduler.checkExpiredBans()).not.toThrow();
      expect(logger.error).toHaveBeenCalledWith(
        'Error checking expired temp bans:',
        expect.any(Error),
      );
    });
  });

  // ---------- executeTask 任务类型分派 ----------

  describe('executeTask 任务类型分派', () => {
    // croner 沙箱：paused 实例仅做匹配/计算，不产生真实调度
    const baseTask = { id: 1, instanceId: 's1', name: '任务', cronExpression: '* * * * *' };

    it('restart：实例存在则执行 restart 并落 success（触发结果而非最终状态）', () => {
      const inst = { isRunning: true, restart: vi.fn() };
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'restart' });

      expect(inst.restart).toHaveBeenCalledTimes(1);
      expect(mockManager.emit).toHaveBeenCalledWith(
        'instance:taskExecute',
        expect.objectContaining({
          instanceId: 's1',
          taskId: 1,
          taskName: '任务',
          taskType: 'restart',
        }),
      );
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'success',
      );
    });

    it('restart：实例缺失不炸，仍落 success（restart 延迟 3s 启动，成败由实例反映）', () => {
      mockManager.getInstance.mockReturnValue(undefined);

      scheduler.executeTask({ ...baseTask, type: 'restart' });

      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'success',
      );
    });

    it('start：实例未运行才启动（幂等保护）', () => {
      const inst = { isRunning: false, start: vi.fn() };
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'start' });

      expect(inst.start).toHaveBeenCalledTimes(1);
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'success',
      );
    });

    it('start：实例已运行则跳过启动', () => {
      const inst = { isRunning: true, start: vi.fn() };
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'start' });

      expect(inst.start).not.toHaveBeenCalled();
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'success',
      );
    });

    it('stop：实例运行中才停止', () => {
      const inst = { isRunning: true, stop: vi.fn() };
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'stop' });

      expect(inst.stop).toHaveBeenCalledTimes(1);
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'success',
      );
    });

    it('stop：实例未运行则不下发', () => {
      const inst = { isRunning: false, stop: vi.fn() };
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'stop' });

      expect(inst.stop).not.toHaveBeenCalled();
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'success',
      );
    });

    it('command：运行中下发命令，成功回调回填 success 与耗时', async () => {
      const inst = asInstance({ isRunning: true, sendCommand: vi.fn(() => Promise.resolve()) });
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'command', command: 'say hi' });
      // 触发时先刷新时间戳（结果由异步回调回填）
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(1, expect.any(String));

      await flush();
      expect(inst.sendCommand).toHaveBeenCalledWith('say hi');
      expect(ScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(
        1,
        'success',
        null,
        expect.any(Number),
      );
    });

    it('command：下发失败回填 failed 并补发 taskFailed 事件（Error 对象取 message）', async () => {
      const inst = asInstance({
        isRunning: true,
        sendCommand: vi.fn(() => Promise.reject(new Error('rcon down'))),
      });
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'command', command: 'say hi' });
      await flush();

      expect(ScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(
        1,
        'failed',
        'rcon down',
        expect.any(Number),
      );
      expect(mockManager.emit).toHaveBeenCalledWith(
        'instance:taskFailed',
        expect.objectContaining({
          taskId: 1,
          error: 'rcon down',
        }),
      );
    });

    it('command：失败原因为非 Error 值时回退 String(err)', async () => {
      const inst = asInstance({
        isRunning: true,
        sendCommand: vi.fn(() => Promise.reject('plain failure')),
      });
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'command', command: 'say hi' });
      await flush();

      expect(ScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(
        1,
        'failed',
        'plain failure',
        expect.any(Number),
      );
    });

    it('command：实例未运行按 skipped 计（本次触发被消费，不重试刷屏）', () => {
      const inst = asInstance({ isRunning: false, sendCommand: vi.fn() });
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'command', command: 'say hi' });

      expect(inst.sendCommand).not.toHaveBeenCalled();
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'skipped',
      );
    });

    it('command：命令内容为空按 skipped 计', () => {
      const inst = asInstance({ isRunning: true, sendCommand: vi.fn() });
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'command', command: '' });

      expect(inst.sendCommand).not.toHaveBeenCalled();
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'skipped',
      );
    });

    it('backup：任务名为空时备份名不拼接前缀（name 透传 undefined）', () => {
      mockManager.getInstance.mockReturnValue({ isRunning: true });

      scheduler.executeTask({ ...baseTask, type: 'backup', name: '' });

      expect(scheduler.backupService.createBackup).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({
          name: undefined,
          type: 'scheduled',
          createdBy: 'scheduler',
          taskId: 1,
        }),
      );
    });

    it('未知任务类型：告警 + 落 failed + 补发 taskFailed 事件', () => {
      scheduler.executeTask({ ...baseTask, type: 'mystery' });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unknown task type: mystery'),
      );
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'failed',
        expect.stringContaining('未知任务类型'),
        expect.any(Number),
      );
      expect(mockManager.emit).toHaveBeenCalledWith(
        'instance:taskFailed',
        expect.objectContaining({
          taskType: 'mystery',
          error: expect.stringContaining('未知任务类型'),
        }),
      );
    });

    it('同步失败（start 抛 EULA 类错误）：失败落库 + taskFailed 事件', () => {
      const inst = {
        isRunning: false,
        start: vi.fn(() => {
          throw new Error('eula.txt missing');
        }),
      };
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'start' });

      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'failed',
        'eula.txt missing',
        expect.any(Number),
      );
      expect(mockManager.emit).toHaveBeenCalledWith(
        'instance:taskFailed',
        expect.objectContaining({
          error: 'eula.txt missing',
          content: expect.stringContaining('任务「任务」执行失败'),
        }),
      );
    });

    it('同步失败抛非 Error 值：失败信息回退 String(err)', () => {
      const inst = {
        isRunning: false,
        start: vi.fn(() => {
          throw 'plain failure';
        }),
      };
      mockManager.getInstance.mockReturnValue(inst);

      scheduler.executeTask({ ...baseTask, type: 'start' });

      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'failed',
        'plain failure',
        expect.any(Number),
      );
    });

    it('backup：任务未绑定实例（instanceId 为空）不查实例直接 skipped', () => {
      scheduler.executeTask({ ...baseTask, instanceId: null, type: 'backup' });

      // L172 三元 false 路径：无 instanceId 不触发 getInstance，直接落 skipped
      expect(mockManager.getInstance).not.toHaveBeenCalled();
      expect(scheduler.backupService.createBackup).not.toHaveBeenCalled();
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'skipped',
      );
    });

    it('无 serverManager 通道：实例查询失败走 catch（emitTaskFailed 守卫 return）', () => {
      const bare = new TaskScheduler(undefined);

      // instanceId 非空但 serverManager 为空：getInstance 读取抛 TypeError → catch 落库
      expect(() => bare.executeTask({ ...baseTask, type: 'start' })).not.toThrow();
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'failed',
        expect.any(String),
        expect.any(Number),
      );
      bare.stop();
    });
  });

  // ---------- 手动触发与下次运行时间 ----------

  describe('runTask / getNextRunTime', () => {
    it('runTask：命中任务即执行并返回 true', () => {
      const inst = { isRunning: true, restart: vi.fn() };
      mockManager.getInstance.mockReturnValue(inst);
      ScheduledTaskModel.findById.mockReturnValue({
        id: 5,
        instanceId: 's1',
        name: '手动任务',
        type: 'restart',
        cronExpression: '* * * * *',
      });

      const result = scheduler.runTask(5);

      expect(result).toBe(true);
      expect(inst.restart).toHaveBeenCalledTimes(1);
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        5,
        expect.any(String),
        'success',
      );
    });

    it('runTask：任务不存在抛出', () => {
      ScheduledTaskModel.findById.mockReturnValue(null);
      expect(() => scheduler.runTask(99)).toThrow('Task not found');
    });

    it('getNextRunTime：有效表达式返回下一次运行时间', () => {
      ScheduledTaskModel.findById.mockReturnValue({ id: 5, cronExpression: '0 3 * * *' });
      const next = scheduler.getNextRunTime(5);
      expect(next).toBeInstanceOf(Date);
    });

    it('getNextRunTime：表达式非法返回 null（不抛出）', () => {
      ScheduledTaskModel.findById.mockReturnValue({ id: 5, cronExpression: 'bad-cron' });
      expect(scheduler.getNextRunTime(5)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid cron expression'),
        expect.any(Error),
      );
    });

    it('getNextRunTime：任务不存在抛出', () => {
      ScheduledTaskModel.findById.mockReturnValue(null);
      expect(() => scheduler.getNextRunTime(99)).toThrow('Task not found');
    });
  });

  // ---------- 停机补跑（catch-up） ----------

  describe('findMissedTrigger（补跑窗口判定）', () => {
    const now = new Date('2026-09-13T09:10:30');

    it('窗口内存在错过的触发：返回最早一次（基线 48h 前 → 首个错过的 04:00 为前日）', () => {
      const missed = findMissedTrigger(
        '0 4 * * *',
        toDbUtcString(new Date(now.getTime() - 48 * 3600e3)),
        now,
      );
      expect(missed).not.toBeNull();
      expect(missed.getHours()).toBe(4);
      expect(missed.getDate()).toBe(12);
    });

    it('上界排除当前分钟：触发恰为当前分钟时不判为错过（主循环兜底，防同分钟双触发）', () => {
      const nowInTriggerMinute = new Date('2026-09-13T04:00:30');
      const missed = findMissedTrigger(
        '0 4 * * *',
        toDbUtcString(new Date(nowInTriggerMinute.getTime() - 24 * 3600e3)),
        nowInTriggerMinute,
      );
      expect(missed).toBeNull();
    });

    it('includeCurrentMinute：触发分钟在当前时刻之前即判为错过（面板快照无主循环兜底）', () => {
      const nowInTriggerMinute = new Date('2026-09-13T04:00:30');
      const missed = findMissedTrigger(
        '0 4 * * *',
        toDbUtcString(new Date(nowInTriggerMinute.getTime() - 24 * 3600e3)),
        nowInTriggerMinute,
        { includeCurrentMinute: true },
      );
      expect(missed.getHours()).toBe(4);
      expect(missed.getDate()).toBe(13);
    });

    it('基线恰为上次触发时刻：该触发视为已消费（严格晚于，含当前分钟的宽窗口也不补）', () => {
      const nowInTriggerMinute = new Date('2026-09-13T04:00:30');
      // 基线 = 当前分钟起点（今天 04:00 刚消费）→ nextRun 严格晚于基线 = 明日 04:00，
      // 与「上界排除当前分钟」用例不同排布：这里即使放宽上界也不命中
      const missed = findMissedTrigger(
        '0 4 * * *',
        toDbUtcString(new Date('2026-09-13T04:00:00')),
        nowInTriggerMinute,
        { includeCurrentMinute: true },
      );
      expect(missed).toBeNull();
    });

    it('基线为空 / 非法表达式 / 基线在未来：一律 null', () => {
      expect(findMissedTrigger('0 4 * * *', null, now)).toBeNull();
      expect(findMissedTrigger('not a cron', toDbUtcString(now), now)).toBeNull();
      expect(findMissedTrigger('0 4 * * *', new Date(now.getTime() + 3600e3), now)).toBeNull();
    });
  });

  describe('用户任务停机补跑', () => {
    /** 统计补跑日志条数（与主循环触发区分） */
    const catchUpLogs = () =>
      logger.info.mock.calls.filter(([msg]) => String(msg).includes('while panel was down')).length;

    it('停机期间错过的触发：启动补跑一次并消费（last_run_at 刷新）', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-13T09:10:30'));
      ScheduledTaskModel.getEnabledTasks.mockReturnValue([
        {
          id: 1,
          name: '每日备份',
          type: 'backup',
          cronExpression: '0 4 * * *',
          lastRunAt: toDbUtcString(new Date(Date.now() - 48 * 3600e3)),
          instanceId: 'demo',
        },
      ]);
      const executeSpy = vi.spyOn(scheduler, 'executeTask');

      scheduler.start();

      // 当分 09:10 不匹配 04:00 → executeTask 只来自补跑
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
      expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'skipped',
      );
    });

    it('错过的多次触发合并为一次（高频 cron 不逐分钟回放）', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-13T09:10:30'));
      ScheduledTaskModel.getEnabledTasks.mockReturnValue([
        {
          id: 2,
          name: '每分钟报时',
          type: 'command',
          cronExpression: '* * * * *',
          lastRunAt: toDbUtcString(new Date(Date.now() - 5 * 60e3)),
          instanceId: 'demo',
          command: 'say hi',
        },
      ]);
      const executeSpy = vi.spyOn(scheduler, 'executeTask');

      scheduler.start();

      // 补跑 1 次（09:05–09:09 五个错过分钟合并）+ 主循环当前分钟 1 次 = 2
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(catchUpLogs()).toBe(1);
    });

    it('从未运行的任务以 created_at 为基线：不会在启动时凭空触发', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-13T09:10:30'));
      ScheduledTaskModel.getEnabledTasks.mockReturnValue([
        {
          id: 3,
          name: '未跑过',
          type: 'backup',
          cronExpression: '0 4 * * *',
          lastRunAt: null,
          createdAt: toDbUtcString(new Date()),
          instanceId: 'demo',
        },
      ]);
      const executeSpy = vi.spyOn(scheduler, 'executeTask');

      scheduler.start();

      expect(executeSpy).not.toHaveBeenCalled();
      expect(catchUpLogs()).toBe(0);
    });

    it('当前分钟的触发只由主循环执行：补跑不与主循环同分钟双触发', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-13T04:00:30'));
      ScheduledTaskModel.getEnabledTasks.mockReturnValue([
        {
          id: 4,
          name: '每日任务',
          type: 'backup',
          cronExpression: '0 4 * * *',
          lastRunAt: toDbUtcString(new Date(Date.now() - 24 * 3600e3)),
          instanceId: 'demo',
        },
      ]);
      const executeSpy = vi.spyOn(scheduler, 'executeTask');

      scheduler.start();

      // 昨天 04:00 已消费 → 窗口内无错过；今天 04:00 = 当前分钟 → 主循环独占
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(catchUpLogs()).toBe(0);
    });

    it('补跑检查失败仅记日志：不阻塞主循环注册', () => {
      ScheduledTaskModel.getEnabledTasks.mockImplementation(() => {
        throw new Error('db locked');
      });
      expect(() => scheduler.catchUpMissedTriggers()).not.toThrow();
      expect(logger.error).toHaveBeenCalledWith(
        'Error loading tasks for catch-up:',
        expect.any(Error),
      );
    });
  });

  describe('面板快照停机补跑', () => {
    it('最新快照已错过触发点：启动补跑一次（补跑调用同步发起，无需异步等待）', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-13T09:10:30'));
      config.panelBackup.enabled = true;
      config.panelBackup.cron = '0 4 * * *';
      getLatestSnapshotTime.mockReturnValue(Date.now() - 48 * 3600e3);

      scheduler.start();

      expect(runPanelBackupCycle).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('panel snapshot missed trigger'),
      );
    });

    it('启动恰在触发分钟内：includeCurrentMinute 接线使错过的触发仍被补跑', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-13T04:00:30'));
      config.panelBackup.enabled = true;
      config.panelBackup.cron = '0 4 * * *';
      // 昨日 04:00 之后的今日 04:00 触发点已被停机吞掉；croner 注册（04:00:30）
      // 只调度明天 → 补跑若不含当前分钟就会漏掉今天这次
      getLatestSnapshotTime.mockReturnValue(Date.now() - 24 * 3600e3);

      scheduler.start();

      expect(runPanelBackupCycle).toHaveBeenCalledTimes(1);
    });

    it('基线读取故障仅记日志：不打断 start() 后续的 cron 注册', () => {
      config.panelBackup.enabled = true;
      getLatestSnapshotTime.mockImplementation(() => {
        throw new Error('EACCES');
      });

      expect(() => scheduler.start()).not.toThrow();
      expect(logger.error).toHaveBeenCalledWith('Panel backup catch-up check failed:', 'EACCES');
      // 异常隔离：主循环与快照 cron 照常注册
      expect(scheduler.interval).not.toBeNull();
      expect(scheduler.panelBackupCron).not.toBeNull();
    });

    it('最新快照新鲜（本次触发点未到）：不补跑', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-13T09:10:30'));
      config.panelBackup.enabled = true;
      getLatestSnapshotTime.mockReturnValue(Date.now() - 5 * 60e3);

      scheduler.start();

      expect(runPanelBackupCycle).not.toHaveBeenCalled();
    });

    it('从无快照不补跑（全新安装首次快照留给 cron 触发点）；开关关闭同样不补跑', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-13T09:10:30'));
      getLatestSnapshotTime.mockReturnValue(null);

      scheduler.start();
      expect(runPanelBackupCycle).not.toHaveBeenCalled();

      // 开关关闭：catchUpPanelBackup 直接短路
      config.panelBackup.enabled = false;
      getLatestSnapshotTime.mockReturnValue(Date.now() - 48 * 3600e3);
      const fresh = new TaskScheduler(mockManager);
      fresh.start();
      fresh.stop();
      expect(runPanelBackupCycle).not.toHaveBeenCalled();
    });
  });
});
