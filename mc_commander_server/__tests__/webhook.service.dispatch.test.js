/**
 * WebhookService 分发主链补测（issue #410）
 * 覆盖 dispatch → _deliver → 重试 → 落库 → 失败通知全链路：
 * 事件/实例过滤、背压（MAX_CONCURRENT_PER_WEBHOOK=5，丢弃落 skipped 投递记录）、指数退避（1s→5s，vi.useFakeTimers 锁定时序）、
 * 4xx 短路、重试耗尽落库（attempts/durationMs）、失败通知去重（首次通知/重复抑制/成功恢复）、
 * _sign HMAC-SHA256 契约（硬编码期望值）、_truncateBody 边界、SSRF 拦截落库、事件桥接映射。
 *
 * utils/http-client / url-guard / database / logger 全 mock：不触网，真实 better-sqlite3（:memory:）断言落库。
 *
 * 行为锚定说明（观察项，未改业务代码）：
 * - dispatch 入口无集中事件白名单校验：事件过滤语义在订阅方 webhook.events 字段
 *   （WEBHOOK_EVENT_TYPES 为配置层白名单，service 层不校验 eventType 合法性）——
 *   非法事件名对 events=[]（订阅全部）的 webhook 仍会投递，用例按现行为锚定；
 *   若需集中校验属业务变更，建议另行立项。
 * - 重试循环 attempt 上限 3，实际最多等待 2 次（1s→5s）；RETRY_DELAYS 第三档 25s
 *   仅为越界兜底（`RETRY_DELAYS[attempt-1] || 25000`），正常路径不可达，无法经公开行为触发。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { EventEmitter } from 'node:events';

const { postImpl, guardImpl, dbRef } = vi.hoisted(() => ({
  postImpl: { current: null },
  guardImpl: { current: null },
  dbRef: { current: null },
}));

// 三个具名导出都要给：SUT 用 ESM 具名导入，缺一个就是模块解析期报错（整个文件全红）
vi.mock('../utils/http-client.js', () => ({
  httpJson: vi.fn(),
  httpStream: vi.fn(),
  // 每次调用只调一次注入实现：本文件的重试次数断言（3 次 / 5 次）依赖这一点
  httpPost: (...args) => postImpl.current(...args),
}));

vi.mock('../utils/url-guard.js', () => ({
  checkPublicUrl: (...args) => guardImpl.current(...args),
}));

vi.mock('../db/database.js', () => ({
  getDb: () => dbRef.current,
  initDatabase: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), banner: vi.fn() },
}));

let db;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  dbRef.current = db;

  db.exec(`CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL,
    secret TEXT, platform TEXT NOT NULL DEFAULT 'generic', events TEXT DEFAULT '[]',
    instance_id TEXT, is_enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id INTEGER NOT NULL,
    event_type TEXT NOT NULL, instance_id TEXT, payload TEXT,
    status TEXT DEFAULT 'pending', response_status INTEGER, response_body TEXT,
    duration_ms INTEGER, attempts INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
  )`);

  guardImpl.current = async () => ({ ok: true });
  postImpl.current = async () => ({ statusCode: 200, body: 'ok' });
});

afterAll(() => {
  db?.close();
});

beforeEach(() => {
  dbRef.current = db;
  // 每用例清表：findAllEnabled 返回全表，历史 hooks 会污染投递计数断言
  db.prepare('DELETE FROM webhook_deliveries').run();
  db.prepare('DELETE FROM webhooks').run();
  guardImpl.current = async () => ({ ok: true });
  postImpl.current = async () => ({ statusCode: 200, body: 'ok' });
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.info).mockClear();
  WebhookService._serverManager = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  WebhookService._serverManager = null;
});

const { WebhookService, setupWebhookDispatch } = await import('../services/webhook.service.js');
const { WebhookModel } = await import('../db/webhook.model.js');
const { logger } = await import('../utils/logger.js');

/** 只取该 webhook 的投递记录（按创建序） */
function deliveriesOf(webhookId) {
  return db
    .prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id')
    .all(webhookId);
}

/** 创建测试 webhook（URL/secret 均为虚构值） */
function createHook(overrides = {}) {
  return WebhookModel.create({
    name: 'Dispatch Hook',
    url: 'https://hooks.example.com/steve',
    secret: `test-secret-${Math.random().toString(36).slice(2, 10)}`,
    events: ['player.join'],
    ...overrides,
  });
}

/** 驱动一次 _deliver 到终态（fake timers 下按重试间隔推进：1s→5s） */
async function runDeliverToFruition(hook, eventType = 'player.join', payload = {}) {
  const p = WebhookService._deliver(hook, eventType, payload);
  await vi.advanceTimersByTimeAsync(0); // guard 放行 + 第 1 次投递
  await vi.advanceTimersByTimeAsync(1000); // 第 1 次重试间隔
  await vi.advanceTimersByTimeAsync(5000); // 第 2 次重试间隔
  await p;
}

describe('WebhookService.dispatch 主流程（issue #410）', () => {
  it('事件过滤：仅 events 包含该事件的 webhook 被投递（白名单语义在订阅方）', async () => {
    const joined = createHook({ url: 'https://hooks.example.com/joined', events: ['player.join'] });
    const other = createHook({
      url: 'https://hooks.example.com/other',
      events: ['instance.start'],
    });
    postImpl.current = vi.fn(async () => ({ statusCode: 200, body: 'ok' }));

    await WebhookService.dispatch('player.join', { instanceId: 'inst-1' });
    await vi.waitFor(() => {
      expect(deliveriesOf(joined.id)).toHaveLength(1);
    });
    await new Promise((r) => setImmediate(r));
    // other 未订阅 player.join：不投递
    expect(deliveriesOf(other.id)).toHaveLength(0);
    expect(postImpl.current.mock.calls.map((c) => c[0])).toEqual([
      'https://hooks.example.com/joined',
    ]);

    // 对同一批 hook 分发其未订阅的事件：均不投递
    postImpl.current.mockClear();
    await WebhookService.dispatch('backup.create', { instanceId: 'inst-1' });
    await new Promise((r) => setImmediate(r));
    expect(postImpl.current).not.toHaveBeenCalled();
  });

  it('events 为空订阅全部事件：任意事件均投递', async () => {
    const hook = createHook({ events: [] });
    postImpl.current = vi.fn(async () => ({ statusCode: 200, body: 'ok' }));

    await WebhookService.dispatch('ping', { instanceId: null });
    await vi.waitFor(() => {
      expect(deliveriesOf(hook.id)).toHaveLength(1);
    });
    expect(postImpl.current).toHaveBeenCalledTimes(1);
  });

  it('实例过滤：instanceId 不匹配跳过，匹配则投递', async () => {
    const hook = createHook({ events: [], instanceId: 'inst-1' });
    postImpl.current = vi.fn(async () => ({ statusCode: 200, body: 'ok' }));

    await WebhookService.dispatch('player.join', { instanceId: 'inst-2' });
    await new Promise((r) => setImmediate(r));
    expect(postImpl.current).not.toHaveBeenCalled();
    expect(deliveriesOf(hook.id)).toHaveLength(0);

    await WebhookService.dispatch('player.join', { instanceId: 'inst-1' });
    await vi.waitFor(() => {
      expect(deliveriesOf(hook.id)).toHaveLength(1);
    });
  });

  it('非法 eventType（行为锚定）：入口无集中白名单校验，按订阅方 events 过滤', async () => {
    const strict = createHook({ url: 'https://hooks.example.com/strict', events: ['ping'] });
    const all = createHook({ url: 'https://hooks.example.com/all', events: [] });
    postImpl.current = vi.fn(async () => ({ statusCode: 200, body: 'ok' }));

    await WebhookService.dispatch('bogus.event', { instanceId: null });
    await vi.waitFor(() => {
      expect(deliveriesOf(all.id)).toHaveLength(1);
    });
    expect(deliveriesOf(strict.id)).toHaveLength(0);
    const urls = postImpl.current.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://hooks.example.com/all');
    expect(urls).not.toContain('https://hooks.example.com/strict');
  });

  it('fire-and-forget：dispatch 返回不等待投递完成，投递异步落库', async () => {
    const hook = createHook();
    let release;
    postImpl.current = vi.fn(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );

    await WebhookService.dispatch('player.join', { instanceId: 'inst-1' });
    // 让 guard 校验完成、请求发出（guard 为 async，需 flush 微任务）
    await new Promise((r) => setImmediate(r));
    // dispatch 已返回：请求已发出但投递未完成（仍为 pending，调用方未被阻塞）
    expect(postImpl.current).toHaveBeenCalledTimes(1);
    expect(deliveriesOf(hook.id)[0].status).toBe('pending');

    release({ statusCode: 200, body: 'ok' });
    await vi.waitFor(() => {
      expect(deliveriesOf(hook.id)[0].status).toBe('success');
    });
  });

  it('findAllEnabled 抛错：warn 日志 + 安全返回，不发起任何投递', async () => {
    const hook = createHook();
    postImpl.current = vi.fn(async () => ({ statusCode: 200, body: 'ok' }));
    dbRef.current = {
      prepare: () => {
        throw new Error('db down');
      },
    };

    await expect(WebhookService.dispatch('player.join', {})).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch webhooks'));
    expect(postImpl.current).not.toHaveBeenCalled();
    expect(deliveriesOf(hook.id)).toHaveLength(0);
  });

  it('投递链路未预期异常被 fire-and-forget catch 兜底（Unhandled delivery error）', async () => {
    const hook = createHook();
    // SSRF 拦截路径的 createDelivery 遇到不可序列化 payload（循环引用）→ _deliver reject
    guardImpl.current = async () => ({ ok: false, reason: '私网地址被拒绝' });
    postImpl.current = vi.fn(async () => ({ statusCode: 200, body: 'ok' }));
    const circular = {};
    circular.self = circular;

    await expect(WebhookService.dispatch('player.join', circular)).resolves.toBeUndefined();
    await new Promise((r) => setImmediate(r));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Unhandled delivery error'));
    expect(deliveriesOf(hook.id)).toHaveLength(0);
  });
});

describe('WebhookService._deliver 重试链路（issue #410）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('重试耗尽落 failed：attempts=3、间隔时序 1s→5s 被 fake timers 锁定', async () => {
    const hook = createHook();
    postImpl.current = vi.fn(async () => ({ statusCode: 500, body: 'boom' }));

    const p = WebhookService._deliver(hook, 'player.join', { instanceId: 'inst-1' });
    await vi.advanceTimersByTimeAsync(0); // 第 1 次投递（500）
    expect(postImpl.current).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); // 1s 间隔后第 2 次投递
    expect(postImpl.current).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000); // 5s 间隔后第 3 次投递
    expect(postImpl.current).toHaveBeenCalledTimes(3);
    await p;

    const rows = deliveriesOf(hook.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
    expect(row.response_status).toBe(500);
    expect(row.response_body).toBe('boom');
    expect(typeof row.duration_ms).toBe('number');
  });

  it('重试后成功：第 2 次尝试 2xx 即落 success 并恢复告警资格', async () => {
    const hook = createHook();
    postImpl.current = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 500, body: 'boom' })
      .mockResolvedValueOnce({ statusCode: 200, body: 'ok' });

    const p = WebhookService._deliver(hook, 'player.join', { instanceId: 'inst-1' });
    await vi.advanceTimersByTimeAsync(0); // 第 1 次 500
    await vi.advanceTimersByTimeAsync(1000); // 1s 后第 2 次 200 → 成功
    await p;

    const rows = deliveriesOf(hook.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].response_status).toBe(200);
    expect(postImpl.current).toHaveBeenCalledTimes(2);
  });

  it('4xx（非 429）短路不重试：attempts=1 直接落 failed', async () => {
    const hook = createHook();
    postImpl.current = vi.fn(async () => ({ statusCode: 404, body: 'Not Found' }));

    const p = WebhookService._deliver(hook, 'player.join', { instanceId: 'inst-1' });
    await vi.advanceTimersByTimeAsync(0); // 第 1 次 404 → break
    await p;

    expect(postImpl.current).toHaveBeenCalledTimes(1);
    const rows = deliveriesOf(hook.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].response_status).toBe(404);
    expect(rows[0].response_body).toBe('Not Found');
  });

  it('429 与 5xx 同走重试路径：429 不被短路', async () => {
    const hook = createHook();
    postImpl.current = vi.fn(async () => ({ statusCode: 429, body: 'rate limited' }));

    const p = WebhookService._deliver(hook, 'player.join', { instanceId: 'inst-1' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    expect(postImpl.current).toHaveBeenCalledTimes(3);
    expect(deliveriesOf(hook.id)[0].status).toBe('failed');
    expect(deliveriesOf(hook.id)[0].attempts).toBe(3);
  });

  it('网络异常进入重试：抛错后重试成功落 success（attempts=2）', async () => {
    const hook = createHook();
    postImpl.current = vi
      .fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({ statusCode: 200, body: 'ok' });

    const p = WebhookService._deliver(hook, 'player.join', { instanceId: 'inst-1' });
    await vi.advanceTimersByTimeAsync(0); // 第 1 次 throw
    await vi.advanceTimersByTimeAsync(1000); // 重试成功
    await p;

    expect(postImpl.current).toHaveBeenCalledTimes(2);
    const rows = deliveriesOf(hook.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].attempts).toBe(2);
  });

  it('重试耗尽且网络异常：response_body 记错误信息', async () => {
    const hook = createHook();
    postImpl.current = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await runDeliverToFruition(hook, 'player.join', { instanceId: 'inst-1' });

    expect(postImpl.current).toHaveBeenCalledTimes(3);
    const rows = deliveriesOf(hook.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].attempts).toBe(3);
    expect(rows[0].response_body).toBe('ECONNREFUSED');
    expect(rows[0].response_status).toBeNull();
  });

  it('请求头契约：X-MC-Event / X-MC-Delivery / X-MC-Timestamp / X-MC-Signature（签名可独立复算）', async () => {
    const hook = createHook({ events: ['player.join'] });
    const payload = { instanceId: 'inst-1', player: 'Steve' };
    const t0 = Math.floor(Date.now() / 1000);
    const payloadStr = JSON.stringify(payload);
    const expectedSig = `sha256=${crypto
      .createHmac('sha256', hook.secret)
      .update(`${t0}.${payloadStr}`)
      .digest('hex')}`;
    postImpl.current = vi.fn(async () => ({ statusCode: 200, body: 'ok' }));

    const p = WebhookService._deliver(hook, 'player.join', payload);
    await vi.advanceTimersByTimeAsync(0);
    await p;

    expect(postImpl.current).toHaveBeenCalledTimes(1);
    const [url, opts] = postImpl.current.mock.calls[0];
    expect(url).toBe(hook.url);
    expect(opts.headers['X-MC-Event']).toBe('player.join');
    expect(opts.headers['X-MC-Timestamp']).toBe(String(t0));
    expect(opts.headers['X-MC-Signature']).toBe(expectedSig);
    expect(opts.headers['X-MC-Delivery']).toBe(String(deliveriesOf(hook.id)[0].id));
    expect(opts.json).toEqual(payload);
  });
});

describe('WebhookService 投递失败通知去重（issue #410）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('同一 webhook 连续失败仅首次通知，重复失败被抑制', async () => {
    const hook = createHook();
    const sm = { emit: vi.fn() };
    WebhookService._serverManager = sm;
    postImpl.current = async () => ({ statusCode: 500, body: 'boom' });

    await runDeliverToFruition(hook, 'player.join', { instanceId: 'inst-1' });
    expect(sm.emit).toHaveBeenCalledTimes(1);
    const [event, data] = sm.emit.mock.calls[0];
    expect(event).toBe('instance:webhookDeliveryFailed');
    expect(data).toMatchObject({
      instanceId: 'inst-1',
      webhookId: hook.id,
      webhookName: hook.name,
      url: hook.url,
      eventType: 'player.join',
      error: 'boom',
    });

    await runDeliverToFruition(hook, 'player.join', { instanceId: 'inst-1' });
    expect(sm.emit).toHaveBeenCalledTimes(1);
  });

  it('成功投递恢复告警资格：失败→成功→再失败共通知 2 次', async () => {
    const hook = createHook();
    const sm = { emit: vi.fn() };
    WebhookService._serverManager = sm;
    postImpl.current = async () => ({ statusCode: 500, body: 'boom' });

    await runDeliverToFruition(hook, 'player.join', { instanceId: 'inst-1' });
    expect(sm.emit).toHaveBeenCalledTimes(1);

    postImpl.current = async () => ({ statusCode: 200, body: 'ok' });
    await runDeliverToFruition(hook, 'player.join', { instanceId: 'inst-1' });
    expect(sm.emit).toHaveBeenCalledTimes(1); // 成功不通知

    postImpl.current = async () => ({ statusCode: 500, body: 'boom' });
    await runDeliverToFruition(hook, 'player.join', { instanceId: 'inst-1' });
    expect(sm.emit).toHaveBeenCalledTimes(2); // 恢复告警
  });

  it('无 serverManager 注入时失败不通知也不抛错', async () => {
    const hook = createHook();
    WebhookService._serverManager = null;
    postImpl.current = async () => ({ statusCode: 500, body: 'boom' });

    await expect(runDeliverToFruition(hook, 'player.join', {})).resolves.toBeUndefined();
    expect(deliveriesOf(hook.id)[0].status).toBe('failed');
  });
});

describe('WebhookService 背压保护（issue #410）', () => {
  it('同一 webhook 第 6 个并发投递被拒（MAX_CONCURRENT_PER_WEBHOOK=5），完成后计数释放', async () => {
    const hook = createHook();
    const gates = [];
    postImpl.current = vi.fn(() => new Promise((r) => gates.push(r)));

    for (let i = 0; i < 6; i++) {
      await WebhookService.dispatch('player.join', { instanceId: 'inst-1' });
      // 让 fire-and-forget 的 _deliver 确定性地完成计数（走到挂起的 httpPost）
      await new Promise((r) => setImmediate(r));
    }

    expect(postImpl.current).toHaveBeenCalledTimes(5);
    // 前 5 个事件 pending 挂起；第 6 个事件背压丢弃落 skipped 记录（issue 526 可观测性）
    const rows = deliveriesOf(hook.id);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(5);
    const skippedRows = rows.filter((r) => r.status === 'skipped');
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].response_body).toBe('backpressure: 5 concurrent');
    expect(skippedRows[0].attempts).toBe(0);
    expect(skippedRows[0].duration_ms).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Backpressure'));

    // 释放全部挂起投递 → 全部成功落库，背压计数归零（finally 释放）
    gates.forEach((g) => g({ statusCode: 200, body: 'ok' }));
    await vi.waitFor(() => {
      expect(deliveriesOf(hook.id).filter((r) => r.status === 'success')).toHaveLength(5);
    });

    // 计数已释放：再次 dispatch 正常投递（skipped 丢弃记录不占投递槽）
    postImpl.current = async () => ({ statusCode: 200, body: 'ok' });
    await WebhookService.dispatch('player.join', { instanceId: 'inst-1' });
    await vi.waitFor(() => {
      expect(deliveriesOf(hook.id).filter((r) => r.status === 'success')).toHaveLength(6);
    });
    await vi.waitFor(() => {
      expect(deliveriesOf(hook.id).filter((r) => r.status === 'skipped')).toHaveLength(1);
    });
  });

  it('背压丢弃落 skipped 投递记录：event/instance/payload 可查，attempts=0 durationMs=0，不发起投递（issue 526）', async () => {
    const hook = createHook({ events: ['player.join'] });
    const gates = [];
    postImpl.current = vi.fn(() => new Promise((r) => gates.push(r)));

    // 占满 5 个并发槽
    for (let i = 0; i < 5; i++) {
      await WebhookService.dispatch('player.join', { instanceId: 'inst-1' });
      await new Promise((r) => setImmediate(r));
    }
    // 第 6 个事件被背压丢弃
    await WebhookService.dispatch('player.join', { instanceId: 'inst-1', player: 'Steve' });
    await new Promise((r) => setImmediate(r));

    expect(postImpl.current).toHaveBeenCalledTimes(5);
    const skippedRows = deliveriesOf(hook.id).filter((r) => r.status === 'skipped');
    expect(skippedRows).toHaveLength(1);
    const row = skippedRows[0];
    expect(row.webhook_id).toBe(hook.id);
    expect(row.event_type).toBe('player.join');
    expect(row.instance_id).toBe('inst-1');
    expect(JSON.parse(row.payload)).toEqual({ instanceId: 'inst-1', player: 'Steve' });
    expect(row.response_body).toBe('backpressure: 5 concurrent');
    expect(row.attempts).toBe(0);
    expect(row.duration_ms).toBe(0);
    expect(row.response_status).toBeNull();

    gates.forEach((g) => g({ statusCode: 200, body: 'ok' }));
    await new Promise((r) => setImmediate(r));
  });

  it('背压持续期间每个被丢弃事件各落一条记录；槽释放后恢复投递（issue 526）', async () => {
    const hook = createHook();
    const gates = [];
    postImpl.current = vi.fn(() => new Promise((r) => gates.push(r)));

    for (let i = 0; i < 5; i++) {
      await WebhookService.dispatch('player.join', {});
      await new Promise((r) => setImmediate(r));
    }
    // 槽占满期间再丢 2 个事件：各落一条 skipped 记录
    await WebhookService.dispatch('player.join', { seq: 6 });
    await new Promise((r) => setImmediate(r));
    await WebhookService.dispatch('player.join', { seq: 7 });
    await new Promise((r) => setImmediate(r));

    const skippedRows = deliveriesOf(hook.id).filter((r) => r.status === 'skipped');
    expect(skippedRows).toHaveLength(2);
    expect(JSON.parse(skippedRows[0].payload)).toEqual({ seq: 6 });
    expect(JSON.parse(skippedRows[1].payload)).toEqual({ seq: 7 });
    expect(skippedRows[0].response_body).toBe('backpressure: 5 concurrent');
    expect(skippedRows[1].response_body).toBe('backpressure: 5 concurrent');

    // 释放后计数归零：恢复投递（waitFor 等 success 落库 + flush 让 finally 减计数完成）
    gates.forEach((g) => g({ statusCode: 200, body: 'ok' }));
    await vi.waitFor(() => {
      expect(deliveriesOf(hook.id).filter((r) => r.status === 'success')).toHaveLength(5);
    });
    await new Promise((r) => setImmediate(r));
    postImpl.current = async () => ({ statusCode: 200, body: 'ok' });
    await WebhookService.dispatch('player.join', { seq: 8 });
    await vi.waitFor(() => {
      expect(deliveriesOf(hook.id).filter((r) => r.status === 'success')).toHaveLength(6);
    });
  });

  it('落记录抛错不中断 dispatch：退化为仅告警，事件仍被跳过不投递（issue 526）', async () => {
    const hook = createHook();
    const gates = [];
    postImpl.current = vi.fn(() => new Promise((r) => gates.push(r)));

    for (let i = 0; i < 5; i++) {
      await WebhookService.dispatch('player.join', {});
      await new Promise((r) => setImmediate(r));
    }

    // 仅 skipped 记录落库抛错：被 catch 兜底，dispatch 正常完成
    const cdOriginal = WebhookModel.createDelivery.bind(WebhookModel);
    vi.spyOn(WebhookModel, 'createDelivery').mockImplementation((data) => {
      if (data.status === 'skipped') throw new Error('disk full');
      return cdOriginal(data);
    });

    await expect(WebhookService.dispatch('player.join', { seq: 6 })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to record skipped delivery'),
    );
    expect(postImpl.current).toHaveBeenCalledTimes(5); // 事件仍被跳过，不发起投递
    expect(deliveriesOf(hook.id).filter((r) => r.status === 'skipped')).toHaveLength(0);

    // 释放挂起投递，避免悬空 promise 跨用例落库
    gates.forEach((g) => g({ statusCode: 200, body: 'ok' }));
    await new Promise((r) => setImmediate(r));
  });
});

describe('WebhookService.dispatch SSRF 拦截（issue #410）', () => {
  it('dispatch 路径私网 URL 被拦截：落 failed 记录（attempts=0、durationMs=0）且不发起投递', async () => {
    const hook = createHook();
    guardImpl.current = async () => ({ ok: false, reason: '私网地址被拒绝' });
    postImpl.current = vi.fn(async () => ({ statusCode: 200, body: 'ok' }));

    await WebhookService.dispatch('player.join', { instanceId: 'inst-1' });
    await vi.waitFor(() => {
      expect(deliveriesOf(hook.id)).toHaveLength(1);
    });

    const row = deliveriesOf(hook.id)[0];
    expect(row.status).toBe('failed');
    expect(row.response_body).toBe('Blocked by SSRF guard: 私网地址被拒绝');
    expect(row.attempts).toBe(0);
    expect(row.duration_ms).toBe(0);
    expect(postImpl.current).not.toHaveBeenCalled();
  });
});

describe('WebhookService._sign 与 _truncateBody（issue #410）', () => {
  it('_sign：固定输入的 HMAC-SHA256 输出可复算（硬编码期望值）', () => {
    expect(WebhookService._sign('test-secret-key', '1700000000', '{"event":"ping"}')).toBe(
      'sha256=9326beadedfdb706c389ab1eef12c2b20fb29b38a3ed7702d93e012f2e1f6485',
    );
    expect(WebhookService._sign('another-secret', '1234567890', '{"a":1}')).toBe(
      'sha256=96b6c9801ddb056ebdaf85c2ee2b8f932f6f672560a1a942c3583426f207a7e0',
    );
  });

  it('_sign：secret 为空返回空串（不签名）', () => {
    expect(WebhookService._sign(null, '1700000000', '{}')).toBe('');
    expect(WebhookService._sign('', '1700000000', '{}')).toBe('');
  });

  it('_truncateBody：null 透传、对象序列化、4096 边界截断', () => {
    expect(WebhookService._truncateBody(null)).toBeNull();
    expect(WebhookService._truncateBody(undefined)).toBeNull();
    expect(WebhookService._truncateBody('short')).toBe('short');
    expect(WebhookService._truncateBody({ ok: true })).toBe('{"ok":true}');
    expect(WebhookService._truncateBody('a'.repeat(4096))).toBe('a'.repeat(4096));
    expect(WebhookService._truncateBody('a'.repeat(4097))).toBe(
      'a'.repeat(4096) + '...(truncated)',
    );
  });
});

describe('setupWebhookDispatch 事件桥接（issue #410）', () => {
  it('EVENT_MAP 全量映射：玩家/成就源事件分发到对应 webhook 事件', () => {
    const dispatchSpy = vi.spyOn(WebhookService, 'dispatch').mockResolvedValue();
    const sm = new EventEmitter();
    setupWebhookDispatch(sm);
    expect(WebhookService._serverManager).toBe(sm);

    const map = {
      'instance:playerJoin': 'player.join',
      'instance:playerLeave': 'player.leave',
      'instance:playerDeath': 'player.death',
      'instance:playerRespawn': 'player.respawn',
      'instance:playerChat': 'player.chat',
      'instance:playerSleep': 'player.sleep',
      'instance:achievement': 'player.achievement',
    };
    let n = 0;
    for (const [src, target] of Object.entries(map)) {
      sm.emit(src, { seq: n });
      expect(dispatchSpy).toHaveBeenLastCalledWith(target, { seq: n });
      n += 1;
    }
    expect(dispatchSpy).toHaveBeenCalledTimes(n);
  });

  it('STATUS_EVENT_MAP：状态事件按 event 子字段分发，未知状态不分发', () => {
    const dispatchSpy = vi.spyOn(WebhookService, 'dispatch').mockResolvedValue();
    const sm = new EventEmitter();
    setupWebhookDispatch(sm);

    const map = {
      started: 'instance.start',
      stopped: 'instance.stop',
      crash: 'instance.crash',
      ready: 'instance.ready',
      save: 'instance.save',
    };
    for (const [status, target] of Object.entries(map)) {
      sm.emit('instance:status', { event: status, instanceId: 'inst-1' });
      expect(dispatchSpy).toHaveBeenLastCalledWith(target, {
        event: status,
        instanceId: 'inst-1',
      });
    }
    expect(dispatchSpy).toHaveBeenCalledTimes(Object.keys(map).length);

    sm.emit('instance:status', { event: 'unknown-status', instanceId: 'inst-1' });
    expect(dispatchSpy).toHaveBeenCalledTimes(Object.keys(map).length);
  });
});
