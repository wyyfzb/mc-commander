/**
 * 定时任务 CRUD 路由补测（issue #411）：routes/tasks.js 8 端点中 7 个此前零测试
 * （仅 GET /tasks/:id/history 由 task_history.route.test.js 覆盖）。
 *
 * 范式沿用 task_history.route.test.js / status.test.js：vi.mock 数据模型层
 * （ScheduledTaskModel / TaskRunHistoryModel）隔离 SQLite，supertest + 内存
 * express 组装真实路由；recordAudit 半覆盖 mock 捕获审计断言（AuditActions
 * 保留真实枚举值）；zod 请求契约与 croner 表达式校验走真实实现——被锁定的
 * 正是生产行为本身：请求侧契约 400（40000）/ TASK_NOT_FOUND（40405）/
 * INVALID_CRON_EXPRESSION（40004）/ INSTANCE_NOT_FOUND（40401）/ 审计落库 /
 * taskScheduler 注入与缺省两分支。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db/scheduled_task.model.js', () => ({
  ScheduledTaskModel: {
    findAll: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/task_run_history.model.js', () => ({
  TaskRunHistoryModel: {
    findByTask: vi.fn(() => []),
  },
}));

// mock recordAudit 捕获审计断言；AuditActions 保留真实枚举值
vi.mock('../utils/audit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordAudit: vi.fn() };
});

import { createTaskRoutes } from '../routes/tasks.js';
import { ScheduledTaskModel } from '../db/scheduled_task.model.js';
import { recordAudit } from '../utils/audit.js';
import { errorHandler } from '../middleware/error_handler.js';

/** schema 全形状任务行（scheduledTaskSchema 可 parse，响应契约观测不漂移） */
function makeTask(overrides = {}) {
  return {
    id: 7,
    instanceId: 'inst-1',
    name: '每日重启',
    type: 'restart',
    cronExpression: '0 0 * * *',
    command: null,
    isEnabled: true,
    lastRunAt: null,
    lastRunStatus: 'never',
    lastRunError: null,
    nextRunAt: null,
    createdAt: '2026-09-01 00:00:00',
    updatedAt: '2026-09-01 00:00:00',
    ...overrides,
  };
}

/** 组装真实路由 + 全局 errorHandler（与生产一致） */
function buildApp({ getInstance = vi.fn(), taskScheduler = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createTaskRoutes({ getInstance }, taskScheduler));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /instances/:instanceId/tasks（实例任务列表）', () => {
  it('过滤参数与默认分页透传 + 分页信封', async () => {
    ScheduledTaskModel.findAll.mockReturnValue({ tasks: [makeTask()], total: 1 });
    const app = buildApp();

    const res = await request(app).get(
      '/api/v1/instances/inst-1/tasks?type=restart&isEnabled=true',
    );

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('每日重启');
    expect(res.body.pagination).toEqual({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(ScheduledTaskModel.findAll).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      page: 1,
      pageSize: 20,
      type: 'restart',
      isEnabled: true,
    });
  });

  it('findAll 抛错 → 全局 errorHandler 500(50000)', async () => {
    ScheduledTaskModel.findAll.mockImplementation(() => {
      throw new Error('db down');
    });
    const app = buildApp();

    const res = await request(app).get('/api/v1/instances/inst-1/tasks');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe(50000);
  });

  it('自定义分页与 isEnabled=false 分支；totalPages 向上取整', async () => {
    ScheduledTaskModel.findAll.mockReturnValue({ tasks: [], total: 101 });
    const app = buildApp();

    const res = await request(app).get(
      '/api/v1/instances/inst-1/tasks?page=2&pageSize=50&isEnabled=false',
    );

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ total: 101, page: 2, pageSize: 50, totalPages: 3 });
    expect(ScheduledTaskModel.findAll).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      page: 2,
      pageSize: 50,
      type: undefined,
      isEnabled: false,
    });
  });
});

describe('GET /tasks（全量分页列表）', () => {
  it('默认分页信封 + 不携带 instanceId 过滤', async () => {
    ScheduledTaskModel.findAll.mockReturnValue({
      tasks: [makeTask({ id: 8, name: '每晚备份', type: 'backup' })],
      total: 25,
    });
    const app = buildApp();

    const res = await request(app).get('/api/v1/tasks');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toEqual({ total: 25, page: 1, pageSize: 20, totalPages: 2 });
    expect(ScheduledTaskModel.findAll).toHaveBeenCalledWith({
      instanceId: undefined,
      page: 1,
      pageSize: 20,
      type: undefined,
      isEnabled: undefined,
    });
  });

  it('type/isEnabled 过滤透传（与实例列表同参语义）', async () => {
    ScheduledTaskModel.findAll.mockReturnValue({ tasks: [], total: 0 });
    const app = buildApp();

    const res = await request(app).get('/api/v1/tasks?type=backup&isEnabled=true');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(ScheduledTaskModel.findAll).toHaveBeenCalledWith({
      instanceId: undefined,
      page: 1,
      pageSize: 20,
      type: 'backup',
      isEnabled: true,
    });
  });

  it('findAll 抛错 → 全局 errorHandler 500(50000)', async () => {
    ScheduledTaskModel.findAll.mockImplementation(() => {
      throw new Error('db down');
    });
    const app = buildApp();

    const res = await request(app).get('/api/v1/tasks');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe(50000);
  });
});

describe('GET /tasks/:id（任务详情）', () => {
  it('存在 → 200 返回任务行', async () => {
    ScheduledTaskModel.findById.mockReturnValue(makeTask({ id: 7 }));
    const app = buildApp();

    const res = await request(app).get('/api/v1/tasks/7');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.id).toBe(7);
    expect(ScheduledTaskModel.findById).toHaveBeenCalledWith('7');
  });

  it('不存在 → 404 TASK_NOT_FOUND(40405)', async () => {
    ScheduledTaskModel.findById.mockReturnValue(null);
    const app = buildApp();

    const res = await request(app).get('/api/v1/tasks/404');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40405);
  });
});

describe('POST /instances/:instanceId/tasks（创建）', () => {
  const validPayload = { name: '每日重启', type: 'restart', cronExpression: '0 0 * * *' };

  it('合法 payload 全链路：isEnabled 缺省默认启用 + 审计 TASK_CREATE 落库', async () => {
    ScheduledTaskModel.create.mockReturnValue(makeTask({ id: 9 }));
    const getInstance = vi.fn().mockReturnValue({ id: 'inst-1', name: '生存服' });
    const app = buildApp({ getInstance });

    const res = await request(app).post('/api/v1/instances/inst-1/tasks').send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.code).toBe(0);
    expect(res.body.data.id).toBe(9);
    expect(getInstance).toHaveBeenCalledWith('inst-1');
    expect(ScheduledTaskModel.create).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      name: '每日重启',
      type: 'restart',
      cronExpression: '0 0 * * *',
      command: undefined,
      isEnabled: true, // isEnabled !== false 分支：缺省即启用
    });
    expect(recordAudit).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      action: 'TASK_CREATE',
      targetType: 'task',
      targetId: '9',
      detail: { name: '每日重启', type: 'restart' },
    });
  });

  it('显式 isEnabled=false 与 command 透传', async () => {
    ScheduledTaskModel.create.mockReturnValue(
      makeTask({ id: 10, name: '每晚广播', type: 'command', command: 'say hi', isEnabled: false }),
    );
    const getInstance = vi.fn().mockReturnValue({ id: 'inst-1' });
    const app = buildApp({ getInstance });

    const res = await request(app).post('/api/v1/instances/inst-1/tasks').send({
      name: '每晚广播',
      type: 'command',
      cronExpression: '*/5 * * * *',
      command: 'say hi',
      isEnabled: false,
    });

    expect(res.status).toBe(201);
    expect(ScheduledTaskModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ isEnabled: false, command: 'say hi' }),
    );
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it('type 非法枚举 → 400 zod 契约拒绝(40000)，结构化 details，不建任务不落审计', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/api/v1/instances/inst-1/tasks')
      .send({ ...validPayload, type: 'teleport' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details[0]).toMatchObject({ path: 'type' });
    expect(ScheduledTaskModel.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('cron 表达式非法（zod 通过、croner 拒绝）→ 40004，先于实例查询拒绝', async () => {
    const getInstance = vi.fn();
    const app = buildApp({ getInstance });

    const res = await request(app)
      .post('/api/v1/instances/inst-1/tasks')
      .send({ ...validPayload, cronExpression: 'not-a-cron' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40004);
    expect(getInstance).not.toHaveBeenCalled(); // 廉价校验前置：非法表达式不触发实例查询
    expect(ScheduledTaskModel.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('name 空/纯空白 → 400 zod 契约拒绝(40000)，不建无名任务', async () => {
    const app = buildApp();

    for (const name of ['', '   ']) {
      const res = await request(app)
        .post('/api/v1/instances/inst-1/tasks')
        .send({ ...validPayload, name });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(40000);
      expect(res.body.details[0]).toMatchObject({ path: 'name' });
    }
    expect(ScheduledTaskModel.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('实例不存在 → 404 INSTANCE_NOT_FOUND(40401)', async () => {
    const getInstance = vi.fn().mockReturnValue(null);
    const app = buildApp({ getInstance });

    const res = await request(app).post('/api/v1/instances/inst-1/tasks').send(validPayload);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40401);
    expect(ScheduledTaskModel.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe('PUT /tasks/:id（更新）', () => {
  it('合法更新：update 收到归一化 body + 审计 TASK_UPDATE（无 detail）', async () => {
    ScheduledTaskModel.findById.mockReturnValue(makeTask({ id: 7, instanceId: 'inst-2' }));
    ScheduledTaskModel.update.mockReturnValue(makeTask({ id: 7, name: '新名字' }));
    const app = buildApp();

    const res = await request(app).put('/api/v1/tasks/7').send({ name: '新名字' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.name).toBe('新名字');
    expect(ScheduledTaskModel.update).toHaveBeenCalledWith('7', { name: '新名字' });
    expect(recordAudit).toHaveBeenCalledWith({
      instanceId: 'inst-2',
      action: 'TASK_UPDATE',
      targetType: 'task',
      targetId: '7',
    });
  });

  it('更新携带非法 cronExpression → 40004，update 不发生', async () => {
    ScheduledTaskModel.findById.mockReturnValue(makeTask());
    const app = buildApp();

    const res = await request(app).put('/api/v1/tasks/7').send({ cronExpression: '* * * *' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40004);
    expect(ScheduledTaskModel.update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('任务不存在 → 404 TASK_NOT_FOUND(40405)，update 不发生', async () => {
    ScheduledTaskModel.findById.mockReturnValue(null);
    const app = buildApp();

    const res = await request(app).put('/api/v1/tasks/404').send({ name: '新名字' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40405);
    expect(ScheduledTaskModel.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /tasks/:id（删除）', () => {
  it('成功：删除 + 审计 TASK_DELETE', async () => {
    ScheduledTaskModel.findById.mockReturnValue(makeTask({ id: 7, instanceId: 'inst-3' }));
    const app = buildApp();

    const res = await request(app).delete('/api/v1/tasks/7');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toBeNull();
    expect(ScheduledTaskModel.delete).toHaveBeenCalledWith('7');
    expect(recordAudit).toHaveBeenCalledWith({
      instanceId: 'inst-3',
      action: 'TASK_DELETE',
      targetType: 'task',
      targetId: '7',
    });
  });

  it('不存在 → 404 TASK_NOT_FOUND(40405)，不删除', async () => {
    ScheduledTaskModel.findById.mockReturnValue(null);
    const app = buildApp();

    const res = await request(app).delete('/api/v1/tasks/404');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40405);
    expect(ScheduledTaskModel.delete).not.toHaveBeenCalled();
  });
});

describe('POST /tasks/:id/run（立即执行）', () => {
  it('taskScheduler 注入：await runTask + 审计 TASK_EXECUTE', async () => {
    ScheduledTaskModel.findById.mockReturnValue(makeTask({ id: 7, instanceId: 'inst-1' }));
    const runTask = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({ taskScheduler: { runTask } });

    const res = await request(app).post('/api/v1/tasks/7/run');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.message).toBe('Task execution triggered');
    expect(runTask).toHaveBeenCalledWith(7);
    expect(recordAudit).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      action: 'TASK_EXECUTE',
      targetType: 'task',
      targetId: '7',
    });
  });

  it('taskScheduler 缺省（null）：跳过调度联动，审计仍落库', async () => {
    ScheduledTaskModel.findById.mockReturnValue(makeTask({ id: 8, instanceId: 'inst-1' }));
    const app = buildApp({ taskScheduler: null });

    const res = await request(app).post('/api/v1/tasks/8/run');

    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TASK_EXECUTE', targetId: '8' }),
    );
  });

  it('任务不存在 → 404 TASK_NOT_FOUND(40405)，不触发执行', async () => {
    ScheduledTaskModel.findById.mockReturnValue(null);
    const runTask = vi.fn();
    const app = buildApp({ taskScheduler: { runTask } });

    const res = await request(app).post('/api/v1/tasks/404/run');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40405);
    expect(runTask).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('runTask 抛错 → 全局 errorHandler 500(50000)，审计不落', async () => {
    ScheduledTaskModel.findById.mockReturnValue(makeTask({ id: 7 }));
    const runTask = vi.fn().mockRejectedValue(new Error('boom'));
    const app = buildApp({ taskScheduler: { runTask } });

    const res = await request(app).post('/api/v1/tasks/7/run');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe(50000);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
