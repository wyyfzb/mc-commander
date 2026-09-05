import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskScheduler } from '../services/task_scheduler.js';

// mock DB 依赖，避免测试依赖真实数据库
vi.mock('../db/scheduled_task.model.js', () => ({
  ScheduledTaskModel: {
    getEnabledTasks: vi.fn(() => []),
  },
}));
vi.mock('../db/ban.model.js', () => ({
  BanModel: {
    findExpiredActive: vi.fn(() => []),
    deactivate: vi.fn(),
  },
}));
vi.mock('../services/backup.service.js', () => ({
  BackupService: class {
    createBackup() {}
  },
}));
import { BanModel } from '../db/ban.model.js';

describe('TaskScheduler - 临时封禁到期自动解封', () => {
  let scheduler;
  let mockManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockManager = {
      getInstance: vi.fn(),
    };
    scheduler = new TaskScheduler(mockManager);
  });

  it('无到期记录时不发送任何命令', () => {
    BanModel.findExpiredActive.mockReturnValue([]);

    scheduler.checkExpiredBans();

    expect(mockManager.getInstance).not.toHaveBeenCalled();
    expect(BanModel.deactivate).not.toHaveBeenCalled();
  });

  it('玩家型到期记录 → 执行 pardon 并停用记录', async () => {
    BanModel.findExpiredActive.mockReturnValue([
      { id: 1, instanceId: 's1', targetType: 'player', target: 'Steve' },
    ]);
    const instance = { isRunning: true, sendCommand: vi.fn(() => Promise.resolve('')) };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.checkExpiredBans();
    // deactivate 在 sendCommand 成功后异步执行
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockManager.getInstance).toHaveBeenCalledWith('s1');
    expect(instance.sendCommand).toHaveBeenCalledWith('pardon Steve');
    expect(BanModel.deactivate).toHaveBeenCalledWith(1);
  });

  it('IP 型到期记录 → 执行 pardon-ip', async () => {
    BanModel.findExpiredActive.mockReturnValue([
      { id: 2, instanceId: 's1', targetType: 'ip', target: '1.2.3.4' },
    ]);
    const instance = { isRunning: true, sendCommand: vi.fn(() => Promise.resolve('')) };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.checkExpiredBans();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(instance.sendCommand).toHaveBeenCalledWith('pardon-ip 1.2.3.4');
    expect(BanModel.deactivate).toHaveBeenCalledWith(2);
  });

  it('实例未运行时跳过（记录保留，下次轮询重试）', () => {
    BanModel.findExpiredActive.mockReturnValue([
      { id: 3, instanceId: 's1', targetType: 'player', target: 'Alex' },
    ]);
    const instance = { isRunning: false, sendCommand: vi.fn() };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.checkExpiredBans();

    expect(instance.sendCommand).not.toHaveBeenCalled();
    expect(BanModel.deactivate).not.toHaveBeenCalled();
  });

  it('实例不存在时跳过', () => {
    BanModel.findExpiredActive.mockReturnValue([
      { id: 4, instanceId: 's1', targetType: 'player', target: 'Alex' },
    ]);
    mockManager.getInstance.mockReturnValue(undefined);

    scheduler.checkExpiredBans();

    expect(BanModel.deactivate).not.toHaveBeenCalled();
  });

  it('sendCommand 失败时保留记录不崩', async () => {
    BanModel.findExpiredActive.mockReturnValue([
      { id: 5, instanceId: 's1', targetType: 'player', target: 'Steve' },
    ]);
    const instance = { isRunning: true, sendCommand: vi.fn(() => Promise.reject(new Error('RCON down'))) };
    mockManager.getInstance.mockReturnValue(instance);

    // checkExpiredBans 为同步函数，sendCommand 的 rejection 由内部 .catch 消化
    scheduler.checkExpiredBans();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(BanModel.deactivate).not.toHaveBeenCalled();
  });
});
