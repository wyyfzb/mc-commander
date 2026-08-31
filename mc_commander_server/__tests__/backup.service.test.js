import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../db/backup.model.js', () => ({
  BackupModel: {
    findAll: vi.fn(() => ({ total: 0 })),
    create: vi.fn(),
    update: vi.fn(),
    resetStaleInProgress: vi.fn(),
  },
}));

vi.mock('../db/scheduled_task.model.js', () => ({
  ScheduledTaskModel: {
    updateLastRunStatus: vi.fn(),
  },
}));

import { EventEmitter } from 'events';
import { BackupService } from '../services/backup.service.js';
import { ScheduledTaskModel } from '../db/scheduled_task.model.js';

describe('BackupService.createBackup - 世界目录缺失', () => {
  it('emit backupFailed 事件并抛错（定时备份路径需用户可见）', async () => {
    const manager = new EventEmitter();
    manager.getInstance = vi.fn(() => null);
    const failedEvents = [];
    manager.on('instance:backupFailed', (d) => failedEvents.push(d));

    const service = new BackupService(manager);

    await expect(
      service.createBackup('nonexistent-instance', { name: 'x' })
    ).rejects.toThrow('World directory not found');

    // 关键：世界目录缺失（setup 阶段同步抛错）也必须发 backupFailed 事件，
    // 定时备份路径若仅记日志，用户会对灾备失效无感知
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].instanceId).toBe('nonexistent-instance');
    expect(failedEvents[0].phase).toBe('setup');
    expect(failedEvents[0].error).toContain('World directory not found');
  });
});

// executeBackup 以真实成败回写任务 lastRunStatus——createBackup
// fire-and-forget 的 resolve 早于快照完成，任务状态必须由快照完成/失败点回写
describe('BackupService.executeBackup - 定时任务结果回写', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeService() {
    const manager = new EventEmitter();
    manager.getInstance = vi.fn(() => null);
    const service = new BackupService(manager);
    vi.spyOn(service, '_restoreSaveOn').mockResolvedValue();
    vi.spyOn(service, 'cleanupOldBackups').mockResolvedValue(0);
    return service;
  }

  it('成功：快照完成 + 校验通过 → updateLastRunStatus(taskId, success)', async () => {
    const service = makeService();
    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bu-exec-'));
    try {
      vi.spyOn(service, '_createSnapshot').mockImplementation(async (_id, dir) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'level.dat'), 'x');
      });
      vi.spyOn(service, '_verifySnapshot').mockResolvedValue();

      await service.executeBackup('s1', 999, snapshotDir, { taskId: 42 });

      expect(ScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(42, 'success');
    } finally {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });

  it('失败：_createSnapshot 抛错 → updateLastRunStatus(taskId, failed)', async () => {
    const service = makeService();
    vi.spyOn(service, '_createSnapshot').mockRejectedValue(new Error('rsync failed'));

    await expect(
      service.executeBackup('s1', 999, '/nonexistent-dir', { taskId: 42 })
    ).rejects.toThrow('rsync failed');

    expect(ScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(42, 'failed', 'rsync failed');
  });

  it('taskId 为空（手动备份）不回写任务状态', async () => {
    const service = makeService();
    vi.spyOn(service, '_createSnapshot').mockRejectedValue(new Error('boom'));

    await expect(
      service.executeBackup('s1', 999, '/nonexistent-dir')
    ).rejects.toThrow('boom');

    expect(ScheduledTaskModel.updateLastRunStatus).not.toHaveBeenCalled();
  });
});
