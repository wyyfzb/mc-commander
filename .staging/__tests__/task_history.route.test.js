/**
 * 任务执行历史路由测试（issue #299）：GET /tasks/:id/history
 * - 任务不存在 → 40400 TASK_NOT_FOUND
 * - 正常查询 → 倒序历史 + 分页信封 + limit 钳制
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { findRecentByTaskMock } = vi.hoisted(() => ({
  findRecentByTaskMock: vi.fn(() => []),
}));

vi.mock('../db/scheduled_task.model.js', () => ({
  ScheduledTaskModel: {
    findById: vi.fn(),
  },
}));
vi.mock('../db/task_run_history.model.js', () => ({
  TaskRunHistoryModel: {
    findByTask: findRecentByTaskMock,
  },
}));

import { createTaskRoutes } from '../routes/tasks.js';
import { errorHandler } from '../middleware/error_handler.js';

describe('GET /tasks/:id/history（issue #299）', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/v1', createTaskRoutes({}, null));
    app.use(errorHandler);
  });

  it('任务不存在 → 40400', async () => {
    const { ScheduledTaskModel } = await import('../db/scheduled_task.model.js');
    ScheduledTaskModel.findById.mockReturnValue(null);

    const res = await request(app).get('/api/v1/tasks/404/history');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40405);
  });

  it('正常查询 → 分页信封返回倒序历史', async () => {
    const { ScheduledTaskModel } = await import('../db/scheduled_task.model.js');
    ScheduledTaskModel.findById.mockReturnValue({ id: 7, name: '每日重启' });
    findRecentByTaskMock.mockReturnValue([
      { id: 12, taskId: 7, runAt: '2026-09-02 12:05:00', status: 'success', error: null, durationMs: 900 },
      { id: 11, taskId: 7, runAt: '2026-09-02 12:00:00', status: 'failed', error: 'RCON 不可用', durationMs: 3000 },
    ]);

    const res = await request(app).get('/api/v1/tasks/7/history');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].status).toBe('success');
    expect(res.body.data[1].error).toBe('RCON 不可用');
    // 模型收到 (taskId, limit)，任务不存在时不会查历史
    expect(findRecentByTaskMock).toHaveBeenCalledWith(7, 20);
  });

  it('limit 钳制：超上限收 100，非法值回退 20', async () => {
    const { ScheduledTaskModel } = await import('../db/scheduled_task.model.js');
    ScheduledTaskModel.findById.mockReturnValue({ id: 7, name: '每日重启' });

    await request(app).get('/api/v1/tasks/7/history?limit=9999');
    expect(findRecentByTaskMock).toHaveBeenLastCalledWith(7, 100);

    await request(app).get('/api/v1/tasks/7/history?limit=abc');
    expect(findRecentByTaskMock).toHaveBeenLastCalledWith(7, 20);
  });
});
