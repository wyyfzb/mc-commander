/**
 * 性能诊断路由测试。
 *
 * 只钉这一层的接线：body 契约校验、四类失败的码映射、成功响应的契约形状。
 * 采集细节与解析正确性由 perf-collect.test.js / perf-parse.test.js 承担。
 *
 * 四类失败映射的判据是「用户下一步动作不同」：没开 RCON 要去设置里开（503 + RCON_UNAVAILABLE）、
 * 版本不支持只能升级（400 + 可读中文）、实例没跑要先去启动（400）、超时则可以重试（500）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { collectSpy } = vi.hoisted(() => ({ collectSpy: vi.fn() }));

vi.mock('../src/services/mc-server/perf-collect.js', async (orig) => {
  const actual = await orig();
  return { ...actual, collectSnapshot: collectSpy };
});

const { createPerfRoutes } = await import('../src/routes/perf.js');
const { errorHandler } = await import('../src/middleware/error_handler.js');
const { PerfCaptureError } = await import('../src/services/mc-server/perf-collect.js');

/** 与 perfSnapshotResponseSchema 同形的成功样本（数值取自 26.3 真服空跑） */
const OK_SNAPSHOT = {
  kind: 'perf',
  collectedAt: '2026-11-01T06:43:50.000Z',
  windowMs: 10013,
  verdict: {
    level: 'healthy',
    headline: '没发现瓶颈：耗时与内存都还有余量',
    detail: '单刻平均耗时 0.1 ms（预算 50 ms）；堆峰值 197 MiB，占上限 19.2%。',
    findings: [{ label: '单刻平均耗时', value: '0.1 ms', hint: null }],
  },
  perf: {
    mcVersion: '26.3',
    javaVersion: '25.0.5',
    cpus: 4,
    processCpuPercent: 17.55,
    tick: {
      averageMs: 0.129312,
      p99Ms: 0.2,
      maxMs: 0.25,
      samples: 100,
      tickSpan: 201,
      timeSpanMs: 10013,
      ticksPerSecond: 20.07,
    },
    heap: {
      usedPeakMiB: 197.01,
      usedStartMiB: 194.91,
      usedEndMiB: 197.01,
      maxMiB: 1024,
      usedPeakPercent: 19.24,
      samples: 201,
    },
    hotspots: [{ name: 'unspecified', sharePercent: 93.66 }],
    dimensions: [{ name: 'overworld', chunks: 0, entities: 0 }],
  },
  jfr: null,
  archivePath: 'debug/profiling/2026-11-01_14_43_13-world-26_3.zip',
  parseWarnings: [],
};

function buildApp(instance) {
  const manager = { getInstance: (id) => (id === 'inst-1' ? instance : undefined) };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createPerfRoutes(manager));
  app.use(errorHandler);
  return app;
}

const instance = { id: 'inst-1', serverPath: '/tmp/does-not-matter' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /instances/:id/perf/snapshot', () => {
  it('成功时返回快照与契约字段', async () => {
    collectSpy.mockResolvedValue(OK_SNAPSHOT);
    const res = await request(buildApp(instance))
      .post('/api/v1/instances/inst-1/perf/snapshot')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.verdict.headline).toContain('没发现瓶颈');
    expect(res.body.data.perf.tick.averageMs).toBeCloseTo(0.129312, 6);
  });

  it('kind 缺省走 perf', async () => {
    collectSpy.mockResolvedValue(OK_SNAPSHOT);
    await request(buildApp(instance)).post('/api/v1/instances/inst-1/perf/snapshot').send({});
    expect(collectSpy).toHaveBeenCalledWith(expect.anything(), { kind: 'perf' });
  });

  it('kind=jfr 透传到采集层', async () => {
    collectSpy.mockResolvedValue({ ...OK_SNAPSHOT, kind: 'jfr', perf: null, jfr: null });
    await request(buildApp(instance))
      .post('/api/v1/instances/inst-1/perf/snapshot')
      .send({ kind: 'jfr' });
    expect(collectSpy).toHaveBeenCalledWith(expect.anything(), { kind: 'jfr' });
  });

  it('kind 非法值 → 400 校验失败', async () => {
    const res = await request(buildApp(instance))
      .post('/api/v1/instances/inst-1/perf/snapshot')
      .send({ kind: 'jmx' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(collectSpy).not.toHaveBeenCalled();
  });

  it('实例不存在 → 404', async () => {
    const res = await request(buildApp(instance))
      .post('/api/v1/instances/nope/perf/snapshot')
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40401);
  });

  it('实例未运行 → 400 INSTANCE_NOT_RUNNING', async () => {
    collectSpy.mockRejectedValue(new PerfCaptureError('not-running', '实例未在运行'));
    const res = await request(buildApp(instance))
      .post('/api/v1/instances/inst-1/perf/snapshot')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40002);
  });

  it('RCON 不可用 → 503 RCON_UNAVAILABLE（用户要去设置里开，不是重试）', async () => {
    collectSpy.mockRejectedValue(new PerfCaptureError('no-rcon', 'RCON 未启用或连接已断开'));
    const res = await request(buildApp(instance))
      .post('/api/v1/instances/inst-1/perf/snapshot')
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(50302);
  });

  it('版本不支持 → 400 + 独立码 40018，message 是可执行的中文说明', async () => {
    collectSpy.mockRejectedValue(
      new PerfCaptureError(
        'unsupported',
        '该服务端版本不支持性能快照（/perf），请升级到带 /perf 的版本',
      ),
    );
    const res = await request(buildApp(instance))
      .post('/api/v1/instances/inst-1/perf/snapshot')
      .send({});
    expect(res.status).toBe(400);
    // 必须是独立码：前端靠它隐藏重试入口，混进通用入参错误就分不出「能重试」与「不能重试」
    expect(res.body.code).toBe(40018);
    expect(res.body.code).not.toBe(40000);
    expect(res.body.message).toContain('不支持');
    expect(res.body.message).toMatch(/[\u4e00-\u9fa5]/);
  });

  it('采集超时 → 500，message 原样带出（用户据此判断能不能重试）', async () => {
    collectSpy.mockRejectedValue(new PerfCaptureError('timeout', '等待性能快照包超时（30 秒）'));
    const res = await request(buildApp(instance))
      .post('/api/v1/instances/inst-1/perf/snapshot')
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.code).toBe(50000);
    expect(res.body.message).toContain('超时');
  });

  it('采集层的意外异常不吞：走错误中间件', async () => {
    collectSpy.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp(instance))
      .post('/api/v1/instances/inst-1/perf/snapshot')
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.code).toBe(50000);
  });
});
