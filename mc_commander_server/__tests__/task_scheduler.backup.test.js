import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskScheduler } from '../services/task_scheduler.js';

// mock DB 依赖，避免测试依赖真实数据库
vi.mock('../db/scheduled_task.model.js', () => ({
  ScheduledTaskModel: {
    getEnabledTasks: vi.fn(() => []),
    updateLastRun: vi.fn(),
    updateLastRunStatus: vi.fn(),
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
    // 调度器备份分支互斥检查前先 reset 卡死记录：
    // 崩溃残留的 creating/restoring 在调度器路径同样需要自愈
    resetStaleInProgress: vi.fn(() => 0),
  },
}));
vi.mock('../services/backup.service.js', () => ({
  BackupService: class {
    constructor() {}
    createBackup = vi.fn(() => Promise.resolve({}));
  },
}));
import { ScheduledTaskModel } from '../db/scheduled_task.model.js';
import { BackupModel } from '../db/backup.model.js';

describe('TaskScheduler - backup 任务分支（互斥跳过 + 失败可见性）', () => {
  let scheduler;
  let mockManager;

  const baseTask = {
    id: 10,
    instanceId: 's1',
    name: '每日备份',
    type: 'backup',
    cronExpression: '0 3 * * *',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockManager = {
      getInstance: vi.fn(() => ({ isRunning: false, isRconConnected: false })),
      emit: vi.fn(),
    };
    scheduler = new TaskScheduler(mockManager);
    BackupModel.findAll.mockReturnValue({ total: 0 });
  });

  it('正常触发：创建备份（透传 taskId）+ 刷新 lastRunAt，success 由 executeBackup 回写', () => {
    scheduler.executeTask(baseTask);

    expect(BackupModel.findAll).toHaveBeenCalledWith({
      instanceId: 's1',
      status: 'creating',
    });
    expect(scheduler.backupService.createBackup).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'scheduled', createdBy: 'scheduler', taskId: 10 })
    );
    // 触发时只刷新时间戳（不带 status 第三参）
    expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(10, expect.any(String));
    // success 不再由调度器 .then 回写（createBackup resolve 早于快照完成，
    // 真实成败由 backup.service 的 executeBackup 经 taskId 回写）
    expect(ScheduledTaskModel.updateLastRunStatus).not.toHaveBeenCalled();
    expect(mockManager.emit).not.toHaveBeenCalledWith('instance:backupSkipped', expect.anything());
  });

  it('实例缺失时 backup 记 skipped（不零落库）', () => {
    mockManager.getInstance.mockReturnValue(undefined);
    scheduler.executeTask(baseTask);

    expect(scheduler.backupService.createBackup).not.toHaveBeenCalled();
    expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(10, expect.any(String), 'skipped');
  });

  it('备份进行中（creating）时跳过：发 backupSkipped 事件 + 结果落 skipped（防短周期 cron 刷屏，下周期重试）', () => {
    BackupModel.findAll.mockReturnValueOnce({ total: 1 });
    scheduler.executeTask(baseTask);

    // 跳过对用户可见（backupSkipped 事件）且消费本次触发（刷新 lastRunAt +
    // 结果落 skipped）：旧实现 skip 不刷新 lastRunAt——大世界备份耗时超 cron
    // 周期时每分钟重试并发一条跳过事件（落库+广播+前端刷新），通知刷屏；
    // 刷新后每个 cron 周期最多跳过一次，下周期仍会再尝试（重试语义保留）
    expect(scheduler.backupService.createBackup).not.toHaveBeenCalled();
    expect(mockManager.emit).toHaveBeenCalledWith(
      'instance:backupSkipped',
      expect.objectContaining({ instanceId: 's1', taskId: 10, content: expect.stringContaining('跳过') })
    );
    expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(10, expect.any(String), 'skipped');
  });

  it('恢复进行中（restoring）时同样跳过（restoring 状态机统一互斥）', () => {
    BackupModel.findAll.mockReturnValueOnce({ total: 0 }); // creating
    BackupModel.findAll.mockReturnValueOnce({ total: 1 }); // restoring
    scheduler.executeTask(baseTask);

    expect(scheduler.backupService.createBackup).not.toHaveBeenCalled();
    expect(mockManager.emit).toHaveBeenCalledWith('instance:backupSkipped', expect.anything());
  });

  it('创建失败：补发 backupFailed（phase=scheduled + content 携带原因，用户可见）+ 结果落 failed', async () => {
    scheduler.backupService.createBackup.mockRejectedValue(new Error('World directory not found'));
    scheduler.executeTask(baseTask);
    // 失败事件与状态回填在 .catch 中异步补发
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 修复前：仅记日志，setup 阶段失败无任何通知（唯一灾备手段失效时用户无感知）
    expect(mockManager.emit).toHaveBeenCalledWith(
      'instance:backupFailed',
      expect.objectContaining({
        instanceId: 's1',
        phase: 'scheduled',
        error: 'World directory not found',
        content: expect.stringContaining('备份失败'),
      })
    );
    expect(ScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(10, 'failed');
  });
});
