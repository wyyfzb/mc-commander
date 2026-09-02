/**
 * Webhook 投递服务
 * - fire-and-forget：不阻塞业务流程
 * - HMAC-SHA256 签名（兼容 GitHub/Discord webhook 格式）
 * - 指数退避重试（1s → 5s → 25s，最多 3 次）
 * - 背压保护（单 webhook 最大 5 并发）
 */
import crypto from 'crypto';
import got from 'got';
import { WebhookModel } from '../db/index.js';
import { checkPublicUrl } from '../utils/url-guard.js';

// 19 种事件白名单
export const WEBHOOK_EVENT_TYPES = [
  'player.join',
  'player.leave',
  'player.death',
  'player.respawn',
  'player.chat',
  'player.sleep',
  'player.achievement',
  'instance.start',
  'instance.stop',
  'instance.crash',
  'instance.ready',
  'instance.save',
  'instance.restart',
  'backup.create',
  'backup.restore',
  'backup.delete',
  'server.start',
  'server.shutdown',
  'ping',
];

// 单 webhook 最大并发投递数
const MAX_CONCURRENT_PER_WEBHOOK = 5;

// 重试延迟（指数退避）
const RETRY_DELAYS = [1000, 5000, 25000];

// 响应体截断阈值
const MAX_RESPONSE_BODY_LENGTH = 4096;

/** 背压计数器：webhookId → 当前并发数 */
const _concurrentCount = new Map();

/** 投递失败去重：已通知的 webhookId 集合，成功投递后移除以恢复告警 */
const _webhookFailNotified = new Set();

export class WebhookService {
  /** serverManager 引用（由 setupWebhookDispatch 注入，供投递失败时 emit WS 事件） */
  static _serverManager = null;

  /**
   * 分发事件到所有匹配的 webhook（fire-and-forget）
   */
  static async dispatch(eventType, payload) {
    let webhooks;
    try {
      webhooks = WebhookModel.findAllEnabled();
    } catch (err) {
      console.warn(`[Webhook] Failed to fetch webhooks: ${err.message}`);
      return;
    }

    for (const webhook of webhooks) {
      // 事件过滤：webhook.events 为空 → 订阅全部
      if (webhook.events.length > 0 && !webhook.events.includes(eventType)) {
        continue;
      }
      // 实例过滤：webhook.instanceId 为空 → 订阅全部实例
      if (webhook.instanceId && payload.instanceId && webhook.instanceId !== payload.instanceId) {
        continue;
      }

      // 背压检查
      const current = _concurrentCount.get(webhook.id) || 0;
      if (current >= MAX_CONCURRENT_PER_WEBHOOK) {
        console.warn(`[Webhook] Backpressure: skipping webhook #${webhook.id} (${current} concurrent)`);
        continue;
      }

      // fire-and-forget：不 await，错误内部捕获
      this._deliver(webhook, eventType, payload).catch(err => {
        console.warn(`[Webhook] Unhandled delivery error for #${webhook.id}: ${err.message}`);
      });
    }
  }

  /**
   * 投递单个 webhook（含重试 + 背压 + 签名 + 投递日志）
   */
  static async _deliver(webhook, eventType, payload) {
    // SSRF 防护：投递前二次校验（兼容历史存量数据，创建/更新时已在路由层拦截）
    const guard = await checkPublicUrl(webhook.url);
    if (!guard.ok) {
      const deliveryId = WebhookModel.createDelivery({
        webhookId: webhook.id,
        eventType,
        instanceId: payload.instanceId || null,
        payload,
        status: 'failed',
      });
      WebhookModel.updateDelivery(deliveryId, {
        status: 'failed',
        responseBody: `Blocked by SSRF guard: ${guard.reason}`,
        durationMs: 0,
        attempts: 0,
      });
      return;
    }

    const deliveryId = WebhookModel.createDelivery({
      webhookId: webhook.id,
      eventType,
      instanceId: payload.instanceId || null,
      payload,
      status: 'pending',
    });

    // 背压计数
    _concurrentCount.set(webhook.id, (_concurrentCount.get(webhook.id) || 0) + 1);

    const startTime = Date.now();
    let lastError = null;
    let responseStatus = null;
    let responseBody = null;
    let attempts = 0;

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        attempts = attempt + 1;

        // 非首次重试前等待
        if (attempt > 0) {
          await this._sleep(RETRY_DELAYS[attempt - 1] || 25000);
        }

        try {
          const timestamp = Math.floor(Date.now() / 1000).toString();
          const payloadStr = JSON.stringify(payload);
          const signature = this._sign(webhook.secret, timestamp, payloadStr);

          const response = await got.post(webhook.url, {
            json: payload,
            headers: {
              'Content-Type': 'application/json',
              'X-MC-Event': eventType,
              'X-MC-Delivery': String(deliveryId),
              'X-MC-Timestamp': timestamp,
              'X-MC-Signature': signature,
            },
            timeout: { request: 15000 },
            throwHttpErrors: false,
            retry: { limit: 0 },
          });

          responseStatus = response.statusCode;
          responseBody = this._truncateBody(response.body);

          // 2xx 视为成功
          if (response.statusCode >= 200 && response.statusCode < 300) {
            WebhookModel.updateDelivery(deliveryId, {
              status: 'success',
              responseStatus,
              responseBody,
              durationMs: Date.now() - startTime,
              attempts,
            });
            // 成功投递：移除失败通知状态（恢复后续失败告警能力）
            _webhookFailNotified.delete(webhook.id);
            return;
          }

          // 4xx（非 429）不重试
          if (response.statusCode >= 400 && response.statusCode < 500 && response.statusCode !== 429) {
            lastError = new Error(`HTTP ${response.statusCode}`);
            break;
          }

          // 5xx / 429 / 网络错误 → 重试
          lastError = new Error(`HTTP ${response.statusCode}`);
        } catch (err) {
          lastError = err;
          // 网络错误 → 重试
        }
      }

      // 所有重试耗尽
      WebhookModel.updateDelivery(deliveryId, {
        status: 'failed',
        responseStatus,
        responseBody: responseBody || (lastError ? lastError.message : null),
        durationMs: Date.now() - startTime,
        attempts,
      });

      // 投递失败通知：同一 webhook 连续失败仅首次通知（去重防刷屏）
      if (!_webhookFailNotified.has(webhook.id) && WebhookService._serverManager) {
        _webhookFailNotified.add(webhook.id);
        WebhookService._serverManager.emit('instance:webhookDeliveryFailed', {
          instanceId: payload.instanceId || null,
          webhookId: webhook.id,
          webhookName: webhook.name,
          url: webhook.url,
          eventType,
          error: responseBody || (lastError ? lastError.message : 'Unknown error'),
        });
      }
    } finally {
      // 释放背压计数
      const current = _concurrentCount.get(webhook.id) || 0;
      _concurrentCount.set(webhook.id, Math.max(0, current - 1));
    }
  }

  /**
   * 测试投递（同步等待结果，供 API 调用）
   */
  static async testDelivery(webhookId) {
    const webhook = WebhookModel.findByIdInternal(webhookId);
    if (!webhook) return { success: false, error: 'Webhook not found' };

    // SSRF 防护：测试投递同样拦截私网/保留地址
    const guard = await checkPublicUrl(webhook.url);
    if (!guard.ok) {
      return { success: false, error: guard.reason };
    }

    const payload = {
      event: 'ping',
      instanceId: null,
      timestamp: new Date().toISOString(),
      message: 'Test delivery from MC Commander',
    };

    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const payloadStr = JSON.stringify(payload);
      const signature = this._sign(webhook.secret, timestamp, payloadStr);

      const response = await got.post(webhook.url, {
        json: payload,
        headers: {
          'Content-Type': 'application/json',
          'X-MC-Event': 'ping',
          'X-MC-Timestamp': timestamp,
          'X-MC-Signature': signature,
        },
        timeout: { request: 15000 },
        throwHttpErrors: false,
        retry: { limit: 0 },
      });

      return {
        success: response.statusCode >= 200 && response.statusCode < 300,
        statusCode: response.statusCode,
        body: this._truncateBody(response.body),
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /** HMAC-SHA256 签名：timestamp.payload 拼接 */
  static _sign(secret, timestamp, payload) {
    if (!secret) return '';
    const data = `${timestamp}.${payload}`;
    return `sha256=${crypto.createHmac('sha256', secret).update(data).digest('hex')}`;
  }

  static _truncateBody(body) {
    if (body == null) return null;
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    if (str.length <= MAX_RESPONSE_BODY_LENGTH) return str;
    return str.slice(0, MAX_RESPONSE_BODY_LENGTH) + '...(truncated)';
  }

  static _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── 事件桥接：将 MCServerManager 事件映射为 webhook 事件类型 ──

const EVENT_MAP = {
  'instance:playerJoin': 'player.join',
  'instance:playerLeave': 'player.leave',
  'instance:playerDeath': 'player.death',
  'instance:playerRespawn': 'player.respawn',
  'instance:playerChat': 'player.chat',
  'instance:playerSleep': 'player.sleep',
  'instance:achievement': 'player.achievement',
};

const STATUS_EVENT_MAP = {
  'started': 'instance.start',
  'stopped': 'instance.stop',
  'crash': 'instance.crash',
  'ready': 'instance.ready',
  'save': 'instance.save',
};

/**
 * 在 index.js 启动时调用，桥接 serverManager 事件到 WebhookService.dispatch
 */
export function setupWebhookDispatch(serverManager) {
  // 注入 serverManager 引用供投递失败通知使用
  WebhookService._serverManager = serverManager;

  // 玩家/成就等直接事件
  for (const [srcEvent, webhookEvent] of Object.entries(EVENT_MAP)) {
    serverManager.on(srcEvent, (data) => {
      WebhookService.dispatch(webhookEvent, data);
    });
  }

  // 状态事件（instance:status 含 event 子字段）
  serverManager.on('instance:status', (data) => {
    const webhookEvent = STATUS_EVENT_MAP[data.event];
    if (webhookEvent) {
      WebhookService.dispatch(webhookEvent, data);
    }
  });

  console.log('[Webhook] Event dispatch bridge initialized');
}