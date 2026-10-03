/**
 * http-client 契约测试
 *
 * 用真实 HTTP 服务器（127.0.0.1 + 随机端口）而非 mock fetch：本模块的价值全在
 * 「网络语义是否正确」——重试、超时、非 2xx、流式进度。mock 掉 fetch 就只能
 * 断言「我调用了自己写的函数」，测不出任何真实行为（那正是把缺陷锁成契约的路径）。
 * 服务端绑定环回地址，不触外网。
 */
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError, httpJson, httpPost, httpStream } from '../utils/http-client.js';

let server;
let base;
/** 每次请求的记录，用于断言重试次数与请求头 */
let hits;
/** 由各用例设置：按命中次数返回不同响应 */
let handler;

beforeEach(async () => {
  hits = [];
  handler = () => ({ status: 200, body: '{}' });
  server = http.createServer((req, res) => {
    hits.push({ url: req.url, method: req.method, headers: req.headers });
    const result = handler(req, hits.length);
    if (result === 'destroy') {
      req.socket.destroy();
      return;
    }
    res.writeHead(result.status, result.headers || {});
    res.end(result.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('httpJson', () => {
  it('解析 JSON 并透传 headers', async () => {
    handler = () => ({ status: 200, body: JSON.stringify({ ok: true, n: 42 }) });
    const data = await httpJson(`${base}/x`, { headers: { 'User-Agent': 'UA-Test' } });
    expect(data).toEqual({ ok: true, n: 42 });
    expect(hits[0].headers['user-agent']).toBe('UA-Test');
  });

  it('searchParams 拼进查询串，值为 null/undefined 的键被跳过', async () => {
    handler = () => ({ status: 200, body: '{}' });
    await httpJson(`${base}/s`, {
      searchParams: { offset: 0, limit: 20, facets: '["a"]', query: undefined, x: null },
    });
    const url = new URL(hits[0].url, base);
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('facets')).toBe('["a"]');
    expect(url.searchParams.has('query')).toBe(false);
    expect(url.searchParams.has('x')).toBe(false);
  });

  it('404 抛 HttpError 且保留 response.statusCode（市场按 404 判「条目不存在」依赖此形状）', async () => {
    handler = () => ({ status: 404, body: 'nope' });
    await expect(httpJson(`${base}/missing`)).rejects.toThrow(HttpError);
    await httpJson(`${base}/missing`).catch((err) => {
      expect(err.response.statusCode).toBe(404);
      expect(err.statusCode).toBe(404);
    });
  });

  it('404 不重试（确定性失败重试只会拖长失败时间）', async () => {
    handler = () => ({ status: 404, body: 'nope' });
    await expect(httpJson(`${base}/missing`, { retryLimit: 3 })).rejects.toThrow(HttpError);
    expect(hits).toHaveLength(1);
  });

  it('503 按 retryLimit 重试，最终成功后返回数据', async () => {
    handler = (_req, n) =>
      n < 3 ? { status: 503, body: 'busy' } : { status: 200, body: '{"ok":1}' };
    const data = await httpJson(`${base}/flaky`, { retryLimit: 3 });
    expect(data).toEqual({ ok: 1 });
    expect(hits).toHaveLength(3);
  });

  it('503 重试耗尽后抛 HttpError（不是静默返回空对象）', async () => {
    handler = () => ({ status: 503, body: 'busy' });
    await expect(httpJson(`${base}/down`, { retryLimit: 2 })).rejects.toThrow(HttpError);
    expect(hits).toHaveLength(3); // 首次 + 2 次重试
  });

  it('连接被重置（网络类错误）会重试', async () => {
    handler = (_req, n) => (n < 2 ? 'destroy' : { status: 200, body: '{"ok":2}' });
    const data = await httpJson(`${base}/reset`, { retryLimit: 2 });
    expect(data).toEqual({ ok: 2 });
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('超时抛错且 code 为 ETIMEDOUT（不挂死）', async () => {
    handler = () => ({ status: 200, body: '{}' });
    // 服务端不回包：用极短超时触发
    server.removeAllListeners('request');
    server.on('request', () => {
      /* 故意不响应 */
    });
    const err = await httpJson(`${base}/slow`, { timeoutMs: 120, retryLimit: 0 }).catch((e) => e);
    expect(err.code).toBe('ETIMEDOUT');
  });

  it('空响应体返回 null（不抛 JSON 解析错）', async () => {
    handler = () => ({ status: 200, body: '' });
    expect(await httpJson(`${base}/empty`)).toBeNull();
  });

  it('非 JSON 响应体抛出可读错误（含 URL）', async () => {
    handler = () => ({ status: 200, body: '<html>not json</html>' });
    const err = await httpJson(`${base}/html`).catch((e) => e);
    expect(err.message).toContain('Invalid JSON');
    expect(err.message).toContain('/html');
  });
});

describe('httpPost', () => {
  it('发送 JSON body 并返回 {statusCode, body}，非 2xx 不抛错', async () => {
    handler = () => ({ status: 500, body: 'server error' });
    const res = await httpPost(`${base}/hook`, { json: { event: 'ping' } });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe('server error');
    expect(hits[0].method).toBe('POST');
    expect(hits[0].headers['content-type']).toBe('application/json');
  });

  it('自定义头与 Content-Type 一并送达，body 为序列化后的 JSON', async () => {
    let received = null;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      let buf = '';
      req.on('data', (c) => (buf += c));
      req.on('end', () => {
        received = buf;
        hits.push({ headers: req.headers });
        res.writeHead(200);
        res.end('ok');
      });
    });
    await httpPost(`${base}/hook`, {
      json: { a: 1 },
      headers: { 'X-MC-Event': 'player_join' },
    });
    expect(JSON.parse(received)).toEqual({ a: 1 });
    expect(hits[0].headers['x-mc-event']).toBe('player_join');
  });

  it('网络错误仍然抛出（调用方需据此走重试循环）', async () => {
    handler = () => 'destroy';
    await expect(httpPost(`${base}/hook`, { json: {} })).rejects.toThrow();
  });
});

describe('httpStream', () => {
  it('推送完整字节并发出 downloadProgress（percent 按 content-length 计算）', async () => {
    const payload = 'x'.repeat(1000);
    handler = () => ({ status: 200, body: payload, headers: { 'Content-Length': '1000' } });
    const stream = httpStream(`${base}/file`);
    const chunks = [];
    const progress = [];
    stream.on('downloadProgress', (p) => progress.push(p));
    await new Promise((resolve, reject) => {
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe(payload);
    expect(progress.length).toBeGreaterThan(0);
    const last = progress.at(-1);
    expect(last.transferred).toBe(1000);
    expect(last.total).toBe(1000);
    expect(last.percent).toBeCloseTo(1, 5);
  });

  it('无 content-length 时 total 为 0、percent 为 0（由调用方按 transferred 展示）', async () => {
    handler = () => ({ status: 200, body: 'abc' }); // 未设 Content-Length → 分块
    const stream = httpStream(`${base}/chunked`);
    const progress = [];
    stream.on('downloadProgress', (p) => progress.push(p));
    await new Promise((resolve, reject) => {
      stream.on('data', () => {});
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    expect(progress.at(-1).total).toBe(0);
    expect(progress.at(-1).transferred).toBe(3);
    expect(progress.at(-1).percent).toBe(0);
  });

  it('非 2xx 通过 error 事件抛 HttpError（且带 statusCode）', async () => {
    handler = () => ({ status: 403, body: 'denied' });
    const stream = httpStream(`${base}/denied`);
    const err = await new Promise((resolve) => {
      stream.on('data', () => {});
      stream.on('end', () => resolve(null));
      stream.on('error', resolve);
    });
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(403);
  });

  it('5xx 会重试，且重试后成功可取到数据', async () => {
    handler = (_req, n) =>
      n < 2 ? { status: 502, body: 'bad gw' } : { status: 200, body: 'good' };
    const stream = httpStream(`${base}/retry`);
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe('good');
    expect(hits).toHaveLength(2);
  });

  it('destroy() 终止下载且不再发 error（调用方主动取消不算失败）', async () => {
    handler = () => ({
      status: 200,
      body: 'x'.repeat(100000),
      headers: { 'Content-Length': '100000' },
    });
    const stream = httpStream(`${base}/big`);
    let errored = null;
    stream.on('error', (e) => (errored = e));
    stream.on('data', () => stream.destroy());
    await new Promise((resolve) => stream.on('close', resolve));
    expect(errored).toBeNull();
  });
});

describe('生产调用点的选项透传（守卫：单测全量 mock 掉 http-client，此处补穿）', () => {
  // mock 掉 http-client 的测试证明不了「生产代码传的选项真的生效」——
  // 它们只证明「我调用了我以为的函数」。本组让真实模块接一个本地假上游，
  // 断言调用点传入的 retryLimit / timeoutMs 真的被客户端执行。
  it('retryLimit 真的限制重试次数（503 场景：limit=1 → 恰好 2 次请求）', async () => {
    handler = () => ({ status: 503, body: 'busy' });
    await expect(httpJson(`${base}/x`, { retryLimit: 1 })).rejects.toThrow(HttpError);
    expect(hits).toHaveLength(2);
  });

  it('retryLimit=0 时一次都不重试', async () => {
    handler = () => ({ status: 503, body: 'busy' });
    await expect(httpJson(`${base}/x`, { retryLimit: 0 })).rejects.toThrow(HttpError);
    expect(hits).toHaveLength(1);
  });

  it('timeoutMs 真的生效：远小于服务端延迟时超时', async () => {
    server.removeAllListeners('request');
    server.on('request', () => {
      /* 永不响应 */
    });
    const t0 = Date.now();
    const err = await httpJson(`${base}/slow`, { timeoutMs: 100, retryLimit: 0 }).catch((e) => e);
    expect(err.code).toBe('ETIMEDOUT');
    expect(Date.now() - t0).toBeLessThan(3000); // 没有挂死
  });
});
