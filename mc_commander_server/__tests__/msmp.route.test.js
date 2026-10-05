/**
 * 推送通道路由（挂载、契约校验、审计、404）。
 *
 * 只挂本路由而非全量 app：本文件要钉的是**这一层的接线**（body 校验、审计动作、
 * 状态读取落到 service），不是别的域的行为。业务组合的承重用例在 msmp.service.test.js。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { auditSpy } = vi.hoisted(() => ({ auditSpy: vi.fn() }));
vi.mock('../utils/audit.js', async (orig) => {
  const actual = await orig();
  return { ...actual, recordAudit: auditSpy };
});

const { createMsmpRoutes } = await import('../routes/msmp.js');
const { errorHandler } = await import('../middleware/error_handler.js');

function makeInstance(props = {}) {
  return {
    id: 'inst-1',
    serverPath: '/tmp/does-not-matter',
    isRunning: false,
    properties: { ...props },
    saveProperties(updates) {
      this.properties = { ...this.properties, ...updates };
    },
  };
}

function buildApp(instance) {
  const manager = { getInstance: (id) => (id === 'inst-1' ? instance : undefined) };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createMsmpRoutes(manager));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /instances/:id/push-channel', () => {
  it('返回磁盘现值', async () => {
    const app = buildApp(
      makeInstance({
        'management-server-enabled': 'true',
        'management-server-tls-enabled': 'false',
        'management-server-secret': 'a'.repeat(40),
      }),
    );
    const res = await request(app).get('/api/v1/instances/inst-1/push-channel');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      enabled: true,
      tlsEnabled: false,
      host: 'localhost',
      port: 0,
      secretConfigured: true,
    });
  });

  it('实例不存在 → 404', async () => {
    const res = await request(buildApp(makeInstance())).get('/api/v1/instances/nope/push-channel');
    expect(res.status).toBe(404);
  });
});

describe('POST /instances/:id/push-channel', () => {
  it('开启：回写结果并把审计动作记为 PUSH_CHANNEL_ENABLE', async () => {
    const inst = makeInstance();
    const res = await request(buildApp(inst))
      .post('/api/v1/instances/inst-1/push-channel')
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: true, secretGenerated: true });
    expect(inst.properties['management-server-enabled']).toBe('true');
    // 审计读的是 action 字段（recordAudit 收对象），别把 enabled 传成 action
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PUSH_CHANNEL_ENABLE', instanceId: 'inst-1' }),
    );
  });

  it('关闭：审计动作记为 PUSH_CHANNEL_DISABLE', async () => {
    const inst = makeInstance({ 'management-server-enabled': 'true' });
    await request(buildApp(inst))
      .post('/api/v1/instances/inst-1/push-channel')
      .send({ enabled: false });

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PUSH_CHANNEL_DISABLE' }),
    );
    expect(inst.properties['management-server-enabled']).toBe('false');
  });

  it('enabled 非布尔 → 400，且不落盘、不审计', async () => {
    const inst = makeInstance();
    const res = await request(buildApp(inst))
      .post('/api/v1/instances/inst-1/push-channel')
      .send({ enabled: 'yes' });

    expect(res.status).toBe(400);
    expect(auditSpy).not.toHaveBeenCalled();
    expect(inst.properties['management-server-enabled']).toBeUndefined();
  });

  it('缺 enabled → 400', async () => {
    const res = await request(buildApp(makeInstance()))
      .post('/api/v1/instances/inst-1/push-channel')
      .send({});
    expect(res.status).toBe(400);
  });

  it('实例不存在 → 404，不审计', async () => {
    const res = await request(buildApp(makeInstance()))
      .post('/api/v1/instances/nope/push-channel')
      .send({ enabled: true });
    expect(res.status).toBe(404);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
