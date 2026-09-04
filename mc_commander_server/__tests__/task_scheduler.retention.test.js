import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- 模块替身（mock 路径相对本测试文件，解析后与 SUT 的依赖同源）----
vi.mock('../config.js', () => ({
  default: {
    panelBackup: { enabled: false, cron: '0 4 * * *' },
    retentionPrune: { enabled: false, cron: '30 4 * * *', auditLogDays: 90, webhookDeliveryDays: 30 },
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
vi.mock('../db/audit.model.js', () => ({
  AuditLogModel: { prune: vi.fn(() => 0) },
}));
vi.mock('../db/webhook.model.js', () => ({
  WebhookModel: { pruneDeliveries: vi.fn(() => 0) },
}));
vi.mock('../services/backup.service.js', () => ({
  BackupService: class {
    constructor() {}
    createBackup = vi.fn(() => Promise.resolve({}));
  },
}));
vi.mock('../services/panel-backup.service.js', () => ({
  runPanelBackupCycle: vi.fn(),
}));

import { TaskScheduler } from '../services/task_scheduler.js';
import { AuditLogModel } from '../db/audit.model.js';
import { WebhookModel } from '../db/webhook.model.js';
import config from '../config.js';
import { logger } from '../utils/logger.js';

describe('TaskScheduler - append-only 表保留清理（issue #472：审计日志 / webhook 投递记录）', () => {
  let scheduler;
  let mockManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    config.retentionPrune.enabled = false;
    config.retentionPrune.cron = '30 4 * * *';
    config.retentionPrune.auditLogDays = 90;
    config.retentionPrune.webhookDeliveryDays = 30;
    mockManager = {
      getInstance: vi.fn(() => undefined),
      emit: vi.fn(),
    };
    scheduler = new TaskScheduler(mockManager);
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ---------- 启动接线 ----------

  it('start：开关关闭时不注册清理 cron 且不首执行（AuditLogModel.prune 零调用）', () => {
    config.retentionPrune.enabled = false;
    scheduler.start();
    expect(scheduler.retentionPruneCron).toBeNull();
    expect(AuditLogModel.prune).not.toHaveBeenCalled();
    expect(WebhookModel.pruneDeliveries).not.toHaveBeenCalled();
  });

  it('start：开关开启时先完成启动首执行（startup 触发），再注册清理 cron', () => {
    config.retentionPrune.enabled = true;
    AuditLogModel.prune.mockReturnValue(3);
    WebhookModel.pruneDeliveries.mockReturnValue(2);

    scheduler.start();

    // 首执行发生在 start() 同步段内（不等待首个 cron 触发点）
    expect(AuditLogModel.prune).toHaveBeenCalledTimes(1);
    expect(WebhookModel.pruneDeliveries).toHaveBeenCalledTimes(1);
    expect(scheduler.retentionPruneCron).not.toBeNull();
    expect(typeof scheduler.retentionPruneCron.stop).toBe('function');
  });

  it('stop：停清理 cron 并置 null', () => {
    config.retentionPrune.enabled = true;
    scheduler.start();
    expect(scheduler.retentionPruneCron).not.toBeNull();

    scheduler.stop();
    expect(scheduler.retentionPruneCron).toBeNull();
  });

  // ---------- 参数传递与返回值 ----------

  it('runRetentionPrune：config 天数透传给两张表（默认 90/30）', () => {
    config.retentionPrune.enabled = true;
    AuditLogModel.prune.mockReturnValue(0);
    WebhookModel.pruneDeliveries.mockReturnValue(0);

    scheduler.runRetentionPrune('startup');

    expect(AuditLogModel.prune).toHaveBeenCalledWith(90);
    expect(WebhookModel.pruneDeliveries).toHaveBeenCalledWith(30);
  });

  it('runRetentionPrune：config 自定义天数透传（AUDIT_LOG_RETENTION_DAYS 等环境变量映射）', () => {
    config.retentionPrune.enabled = true;
    config.retentionPrune.auditLogDays = 7;
    config.retentionPrune.webhookDeliveryDays = 14;
    AuditLogModel.prune.mockReturnValue(0);
    WebhookModel.pruneDeliveries.mockReturnValue(0);

    scheduler.runRetentionPrune();

    expect(AuditLogModel.prune).toHaveBeenCalledWith(7);
    expect(WebhookModel.pruneDeliveries).toHaveBeenCalledWith(14);
  });

  it('runRetentionPrune：成功路径返回双表删除计数且 failed 为空', () => {
    config.retentionPrune.enabled = true;
    AuditLogModel.prune.mockReturnValue(12);
    WebhookModel.pruneDeliveries.mockReturnValue(5);

    const result = scheduler.runRetentionPrune('cron');

    expect(result).toEqual({ auditDeleted: 12, webhookDeleted: 5, failed: [] });
  });

  // ---------- 失败路径（单表失败不拖累另一张） ----------

  it('runRetentionPrune：审计表失败时仍执行 webhook 清理，failed 归因 audit', () => {
    config.retentionPrune.enabled = true;
    AuditLogModel.prune.mockImplementation(() => {
      throw new Error('db locked');
    });
    WebhookModel.pruneDeliveries.mockReturnValue(4);

    const result = scheduler.runRetentionPrune('startup');

    expect(result.failed).toEqual(['audit']);
    expect(result.auditDeleted).toBe(0);
    expect(result.webhookDeleted).toBe(4);
    expect(logger.error).toHaveBeenCalledWith(
      '[RetentionPrune] audit_logs prune failed (startup):',
      'db locked'
    );
  });

  it('runRetentionPrune：webhook 表失败时 failed 归因 webhook 且成功表计数不受影响', () => {
    config.retentionPrune.enabled = true;
    AuditLogModel.prune.mockReturnValue(8);
    WebhookModel.pruneDeliveries.mockImplementation(() => {
      throw new Error('disk io error');
    });

    const result = scheduler.runRetentionPrune('cron');

    expect(result.failed).toEqual(['webhook']);
    expect(result.auditDeleted).toBe(8);
    expect(result.webhookDeleted).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      '[RetentionPrune] webhook_deliveries prune failed (cron):',
      'disk io error'
    );
  });

  it('runRetentionPrune：双表同时失败不抛出（调度主循环不被清理故障拖垮）', () => {
    config.retentionPrune.enabled = true;
    AuditLogModel.prune.mockImplementation(() => {
      throw new Error('a');
    });
    WebhookModel.pruneDeliveries.mockImplementation(() => {
      throw new Error('b');
    });

    expect(() => scheduler.runRetentionPrune()).not.toThrow();
    const result = scheduler.runRetentionPrune();
    expect(result.failed).toEqual(['audit', 'webhook']);
  });

  // ---------- cron 周期触发 ----------

  it('清理 cron 到点触发 runRetentionPrune（fake timers 驱动 croner 回调）', () => {
    config.retentionPrune.enabled = true;
    config.retentionPrune.cron = '* * * * *';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T10:30:45'));

    scheduler.start();
    // start() 内首执行已消耗 1 次；cron 到点（整分）再触发
    expect(AuditLogModel.prune).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60 * 1000);
    expect(AuditLogModel.prune).toHaveBeenCalledTimes(2);
    expect(WebhookModel.pruneDeliveries).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60 * 1000);
    expect(AuditLogModel.prune).toHaveBeenCalledTimes(3);
  });
});
