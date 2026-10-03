/**
 * HTTP 客户端（http-client）
 *
 * 只覆盖本项目实际用到的三种形态：取 JSON、POST JSON、流式下载。
 * 之所以不引入通用 HTTP 库：本项目的下载链路只需要「带 user-agent 的 GET」，
 * 而通用库会把缓存、重定向策略、cookie、代理等整套能力一并带进依赖树——
 * 用不到的代码同样是**要维护、要审计、要跟进公告**的代码。
 *
 * 重试与超时语义按本项目既有行为固定，不再暴露开关（调用点只有两种取值）：
 * - 重试仅限幂等方法（GET）；POST 由调用方自己的循环负责，此处不重试。
 * - 可重试条件是「网络类错误码」或「响应码在 RETRYABLE_STATUS 内」。
 *   404/401 这类确定性失败**不重试**（重试不会改变结果，只会拖长失败时间）。
 * - 退避为 2^n 秒并加抖动，上界 backoffLimitMs。
 *
 * 非 2xx 的失败统一抛 HttpError，并保留 `response.statusCode` 形状，
 * 使既有的「按响应码分支」调用方（如市场 404 → 条目不存在）无需改写。
 */
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 非 2xx 时抛出；`response.statusCode` 是调用方唯一需要读取的字段 */
export class HttpError extends Error {
  constructor(message, { statusCode, url, method = 'GET', body = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.method = method;
    this.url = url;
    // 与 got 的 HTTPError 同形：上游错误分支读 err.response.statusCode 判定 404
    this.response = { statusCode, body };
    this.statusCode = statusCode;
  }
}

/** 网络类瞬时故障（可重试） */
const RETRYABLE_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'EADDRINUSE',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** 上游临时故障（可重试）；404/401 等确定性失败不在此列 */
const RETRYABLE_STATUS = new Set([408, 413, 429, 500, 502, 503, 504, 521, 522, 524]);

const DEFAULT_BACKOFF_LIMIT_MS = 10_000;
const DEFAULT_RETRY_LIMIT = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 2^n 秒退避 + 抖动（错开并发重试，避免同一时刻再次打满上游） */
function backoffDelay(attempt) {
  const base = Math.min(2 ** (attempt - 1) * 1000, DEFAULT_BACKOFF_LIMIT_MS);
  return base + Math.random() * 100;
}

/**
 * 判断网络类错误是否值得重试。
 * 响应码的重试判据不在此处——它在 requestWithRetry 里直接读 RETRYABLE_STATUS
 * （此处曾留一个 statusCode 形参，无调用者传入，属死代码，已删）。
 */
function isRetryable(err) {
  // fetch 把底层网络故障包成 `TypeError: fetch failed`，真实错误码在 cause 链上
  // （实测 socket 被对端关闭时顶层无 code，cause.code 才是 UND_ERR_SOCKET）。
  // 只看顶层会把「连接重置」误判为不可重试，等于重试逻辑对最常见的瞬时故障失效。
  for (let e = err; e; e = e.cause) {
    if (RETRYABLE_ERROR_CODES.has(e.code)) return true;
  }
  return false;
}

/** 把 searchParams 拼进 URL（值为 undefined/null 的键跳过） */
function buildUrl(url, searchParams) {
  if (!searchParams) return url;
  const u = new URL(url);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined || value === null) continue;
    u.searchParams.set(key, String(value));
  }
  return u.toString();
}

/**
 * 单次 fetch，把超时与网络错误统一成 Error（调用方只看 code/statusCode）。
 * `timeoutMs` 是**整个请求**的上限（含读取响应体），不是分阶段超时。
 */
async function fetchOnce(url, { method, headers, body, timeoutMs, signal }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // 调用方信号（用户取消）与超时信号任一触发都应中止：AbortSignal.any 在 Node 20+ 可用
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetch(url, { method, headers, body, signal: combined, redirect: 'follow' });
  } catch (err) {
    // AbortSignal.timeout 触发时 fetch 抛的是 TimeoutError/AbortError，转成可识别的 code
    if (err?.name === 'TimeoutError' || timeoutSignal.aborted) {
      const timeoutErr = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutErr.code = 'ETIMEDOUT';
      throw timeoutErr;
    }
    throw err;
  }
}

/**
 * 带重试的请求，返回原始 Response（流式下载需要未消费的 body）。
 * 重试只覆盖「建立连接/拿到响应头」阶段；响应体读取中途断开由调用方处理，
 * 因为此处无法安全重放一个已经开始写入磁盘的流。
 */
async function requestWithRetry(url, opts) {
  const { retryLimit = DEFAULT_RETRY_LIMIT, method = 'GET' } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
    try {
      const response = await fetchOnce(url, { ...opts, method });
      if (!response.ok && RETRYABLE_STATUS.has(response.status) && attempt <= retryLimit) {
        // 必须消费或取消响应体，否则连接不会释放
        await response.body?.cancel().catch(() => {});
        await sleep(backoffDelay(attempt));
        continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (attempt > retryLimit || !isRetryable(err)) throw err;
      await sleep(backoffDelay(attempt));
    }
  }
  throw lastErr;
}

/**
 * GET 并解析 JSON。非 2xx 抛 HttpError（`err.response.statusCode` 可用）。
 * @param {string} url
 * @param {{headers?: object, timeoutMs?: number, retryLimit?: number, searchParams?: object, signal?: AbortSignal}} [options]
 * @returns {Promise<any>}
 */
export async function httpJson(url, options = {}) {
  const {
    headers,
    timeoutMs = 15_000,
    retryLimit = DEFAULT_RETRY_LIMIT,
    searchParams,
    signal,
  } = options;
  const finalUrl = buildUrl(url, searchParams);
  const response = await requestWithRetry(finalUrl, {
    headers,
    timeoutMs,
    retryLimit,
    signal,
    method: 'GET',
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(`Response code ${response.status} (${response.statusText})`, {
      statusCode: response.status,
      url: finalUrl,
      body: text,
    });
  }
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON from ${finalUrl}: ${err.message}`);
  }
}

/**
 * POST JSON，返回 `{ statusCode, body }`（body 为字符串）。
 * **不因非 2xx 抛错**——webhook 投递需要按响应码决定是否重试，由调用方判定。
 * @returns {Promise<{statusCode: number, body: string}>}
 */
export async function httpPost(url, options = {}) {
  const { json, headers, timeoutMs = 15_000 } = options;
  const response = await fetchOnce(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: json === undefined ? undefined : JSON.stringify(json),
    timeoutMs,
    signal: options.signal,
  });
  return { statusCode: response.status, body: await response.text() };
}

/**
 * 流式 GET。返回 Node Readable，并额外发出 `downloadProgress` 事件
 * （`{ percent, transferred, total }`，每个 chunk 一次，由调用方自行节流）。
 *
 * 非 2xx 通过 `error` 事件抛出 HttpError（而非同步抛出）：调用方都是在
 * `.on('error')` 里做清理，保持「错误只走一条通道」比同步/异步混用更不易漏。
 * @returns {import('node:stream').Readable & {destroy: Function}}
 */
export function httpStream(url, options = {}) {
  const { headers, timeoutMs = 120_000, retryLimit = DEFAULT_RETRY_LIMIT, signal } = options;
  // PassThrough 而非裸 Readable：调用方用 pipe() 接写流，而 pipe 的目标必须是可写流。
  // 裸 Readable 会在 pipe 时抛 `dest.write is not a function`（实测）。
  const out = new PassThrough();
  let cancelled = false;
  out.on('close', () => {
    cancelled = true;
  });

  (async () => {
    const response = await requestWithRetry(url, {
      headers,
      timeoutMs,
      retryLimit,
      signal,
      method: 'GET',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(`Response code ${response.status} (${response.statusText})`, {
        statusCode: response.status,
        url,
      });
    }
    // Content-Length 可能缺失（分块传输/代理）：total 为 0 时由调用方按 transferred 展示
    const total = Number(response.headers.get('content-length')) || 0;
    let transferred = 0;
    const source = Readable.fromWeb(response.body);
    source.on('data', (chunk) => {
      transferred += chunk.length;
      out.emit('downloadProgress', {
        percent: total > 0 ? transferred / total : 0,
        transferred,
        total,
      });
    });
    // pipeline 负责错误传播与两侧清理；不用 source.pipe(out) 是因为 pipe 不转发错误，
    // 上游中断会变成无人处理的 'error' 事件（进程级 unhandled）
    await pipeline(source, out);
  })().catch((err) => {
    if (!cancelled) out.destroy(err);
  });

  return out;
}
