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
    resetStaleInProgress: vi.fn(() => 0),
  },
}));
vi.mock('../services/backup.service.js', () => ({
  BackupService: class {
    createBackup = vi.fn(() => Promise.resolve({}));
  },
}));
import { ScheduledTaskModel } from '../db/scheduled_task.model.js';

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TaskScheduler - executeTask 完整结果语义', () => {
  let scheduler;
  let mockManager;

  const makeTask = (overrides) => ({
    id: 100,
    instanceId: 's1',
    name: '测试任务',
    type: 'start',
    cronExpression: '0 3 * * *',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockManager = {
      getInstance: vi.fn(),
      emit: vi.fn(),
    };
    scheduler = new TaskScheduler(mockManager);
  });

  it('start 同步成功 → 结果落 success', () => {
    const instance = { isRunning: false, start: vi.fn() };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.executeTask(makeTask({ type: 'start' }));

    expect(instance.start).toHaveBeenCalled();
    expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(100, expect.any(String), 'success');
  });

  it('stop 同步成功 → 结果落 success', () => {
    const instance = { isRunning: true, stop: vi.fn() };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.executeTask(makeTask({ type: 'stop' }));

    expect(instance.stop).toHaveBeenCalled();
    expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(100, expect.any(String), 'success');
  });

  it('start 同步 throw → 结果落 failed 且刷新 last_run_at（失败也消费本次触发）', () => {
    const instance = {
      isRunning: false,
      start: vi.fn(() => {
        throw new Error('EULA 未接受');
      }),
    };
    mockManager.getInstance.mockReturnValue(instance);

    // executeTask 内部捕获同步 throw，不向外抛
    expect(() => scheduler.executeTask(makeTask({ type: 'start' }))).not.toThrow();

    // updateLastRun 落库即同时写 last_run_at=CURRENT_TIMESTAMP，保证失败也记录触发时间
    expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(100, expect.any(String), 'failed');
  });

  it('command resolve → 触发先刷新时间戳（不写 status），异步回填 success', async () => {
    const instance = { isRunning: true, sendCommand: vi.fn(() => Promise.resolve('ok')) };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.executeTask(makeTask({ type: 'command', command: 'say 你好' }));

    expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(100, expect.any(String));
    await flushAsync();
    expect(ScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(100, 'success');
  });

  it('command reject → 异步回填 failed（不崩）', async () => {
    const instance = { isRunning: true, sendCommand: vi.fn(() => Promise.reject(new Error('RCON 不可用'))) };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.executeTask(makeTask({ type: 'command', command: 'list' }));
    await flushAsync();

    expect(ScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(100, 'failed');
  });

  it('command reject → 发出 instance:taskFailed 事件（含任务名与错误摘要）', async () => {
    const instance = { isRunning: true, sendCommand: vi.fn(() => Promise.reject(new Error('RCON 不可用'))) };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.executeTask(makeTask({ type: 'command', command: 'list', name: '每日公告' }));
    await flushAsync();

    expect(mockManager.emit).toHaveBeenCalledWith(
      'instance:taskFailed',
      expect.objectContaining({
        instanceId: 's1',
        taskId: 100,
        taskName: '每日公告',
        taskType: 'command',
        error: 'RCON 不可用',
      }),
    );
  });

  it('command resolve → 不发 taskFailed（仅失败时通知）', async () => {
    const instance = { isRunning: true, sendCommand: vi.fn(() => Promise.resolve('ok')) };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.executeTask(makeTask({ type: 'command', command: 'list' }));
    await flushAsync();

    const failedCalls = mockManager.emit.mock.calls.filter(([e]) => e === 'instance:taskFailed');
    expect(failedCalls).toHaveLength(0);
  });

  it('command 实例未运行/无命令 → 未真正下发，结果落 skipped', () => {
    mockManager.getInstance.mockReturnValue({ isRunning: false, sendCommand: vi.fn() });

    scheduler.executeTask(makeTask({ type: 'command', command: 'list' }));

    expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(100, expect.any(String), 'skipped');
  });

  it('未知任务类型 → 结果落 failed', () => {
    scheduler.executeTask(makeTask({ type: 'unknown-type' }));

    expect(ScheduledTaskModel.updateLastRun).toHaveBeenCalledWith(100, expect.any(String), 'failed');
  });

  it('未知任务类型 → 发出 instance:taskFailed 事件', () => {
    scheduler.executeTask(makeTask({ type: 'unknown-type' }));

    expect(mockManager.emit).toHaveBeenCalledWith(
      'instance:taskFailed',
      expect.objectContaining({
        taskId: 100,
        taskType: 'unknown-type',
        error: expect.stringContaining('未知任务类型'),
      }),
    );
  });

  it('start 同步 throw → 发出 instance:taskFailed 事件', () => {
    const instance = {
      isRunning: false,
      start: vi.fn(() => {
        throw new Error('EULA 未接受');
      }),
    };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.executeTask(makeTask({ type: 'start' }));

    expect(mockManager.emit).toHaveBeenCalledWith(
      'instance:taskFailed',
      expect.objectContaining({
        taskId: 100,
        taskType: 'start',
        error: 'EULA 未接受',
      }),
    );
  });

  it('start/stop/restart 成功 → 不发 taskFailed（触发结果语义）', () => {
    const instance = { isRunning: false, start: vi.fn() };
    mockManager.getInstance.mockReturnValue(instance);

    scheduler.executeTask(makeTask({ type: 'start' }));

    const failedCalls = mockManager.emit.mock.calls.filter(([e]) => e === 'instance:taskFailed');
    expect(failedCalls).toHaveLength(0);
  });
});
