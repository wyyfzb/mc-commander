/**
 * Webhook 投递服务
 * - fire-and-forget：不阻塞业务流程
 * - HMAC-SHA256 签名（兼容 GitHub/Discord webhook 格式）
 * - 国内渠道预设：飞书/钉钉/企微群机器人、Server酱/PushPlus 个人推送
 *   （各平台签名协议与消息体特化，platform 字段驱动 + URL 域名兜底）
 * - 指数退避重试（1s → 5s → 25s，最多 3 次）
 * - 背压保护（单 webhook 最大 5 并发）
 */
import crypto from 'crypto';
import { WebhookModel } from '../db/index.js';
import { httpPost } from '../utils/http-client.js';
import { checkPublicUrl } from '../utils/url-guard.js';
import { logger } from '../utils/logger.js';

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
      logger.warn(`[Webhook] Failed to fetch webhooks: ${err.message}`);
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
        logger.warn(
          `[Webhook] Backpressure: skipping webhook #${webhook.id} (${current} concurrent)`,
        );
        // 背压丢弃落投递记录（与 SSRF 拦截路径观测粒度对齐）：attempts=0 标记投递从未尝试，
        // responseBody 携带丢弃原因与当时并发数，排障时区分「事件未产生」与「背压丢弃」。
        // 落记录失败不中断分发循环——可观测性增强不得引入新的投递失败面
        try {
          const deliveryId = WebhookModel.createDelivery({
            webhookId: webhook.id,
            eventType,
            instanceId: payload.instanceId || null,
            payload,
            status: 'skipped',
          });
          // createDelivery 对 attempts 有 || 1 兜底，0 须经 updateDelivery 显式落库
          WebhookModel.updateDelivery(deliveryId, {
            responseBody: `backpressure: ${current} concurrent`,
            durationMs: 0,
            attempts: 0,
          });
        } catch (err) {
          logger.warn(
            `[Webhook] Failed to record skipped delivery for #${webhook.id}: ${err.message}`,
          );
        }
        continue;
      }

      // fire-and-forget：不 await，错误内部捕获
      this._deliver(webhook, eventType, payload).catch((err) => {
        logger.warn(`[Webhook] Unhandled delivery error for #${webhook.id}: ${err.message}`);
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
          // 渠道预设：平台特化格式（含官方签名/消息体）；generic 维持原 payload
          const platformRequest = this._buildPlatformRequest(webhook, eventType, payload);
          const requestBody = platformRequest ? platformRequest.body : payload;
          const requestUrl = platformRequest ? platformRequest.url : webhook.url;

          const response = await httpPost(requestUrl, {
            json: requestBody,
            headers: {
              'Content-Type': 'application/json',
              'X-MC-Event': eventType,
              'X-MC-Delivery': String(deliveryId),
              'X-MC-Timestamp': timestamp,
              'X-MC-Signature': signature,
            },
            timeoutMs: 15000,
            // 重试由本服务的 RETRY_DELAYS 循环负责（间隔与落库时机都在那里）；
            // httpPost 本身不做重试，否则 4xx 短路判定会被内层重试绕过
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
          if (
            response.statusCode >= 400 &&
            response.statusCode < 500 &&
            response.statusCode !== 429
          ) {
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
   * 成功与非 2xx/网络异常路径均落一条 event_type=ping 的投递记录（排障可回查；
   * ping 为测试专用事件标记，不触发用户配置事件分发）
   */
  static async testDelivery(webhookId) {
    const webhook = WebhookModel.findByIdInternal(webhookId);
    if (!webhook) return { success: false, error: 'Webhook not found' };

    // SSRF 防护：测试投递同样拦截私网/保留地址（拦截发生在投递尝试前，不落投递记录）
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
    const startTime = Date.now();

    try {
      // 平台特化格式（与真实事件投递同路径）：飞书/钉钉等对通用 payload 会因
      // 缺 msg_type/签名不符拒收，测试投递必须按渠道预设构造，否则按钮永远失真
      const platformRequest = this._buildPlatformRequest(webhook, 'ping', payload);
      const requestBody = platformRequest ? platformRequest.body : payload;
      const requestUrl = platformRequest ? platformRequest.url : webhook.url;

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const payloadStr = JSON.stringify(payload);
      const signature = this._sign(webhook.secret, timestamp, payloadStr);

      const response = await httpPost(requestUrl, {
        json: requestBody,
        headers: {
          'Content-Type': 'application/json',
          'X-MC-Event': 'ping',
          'X-MC-Timestamp': timestamp,
          'X-MC-Signature': signature,
        },
        timeoutMs: 15000,
      });

      const success = response.statusCode >= 200 && response.statusCode < 300;
      const body = this._truncateBody(response.body);

      // 落投递历史（与真实事件投递并列可查）
      WebhookModel.createDelivery({
        webhookId,
        eventType: 'ping',
        instanceId: null,
        payload,
        status: success ? 'success' : 'failed',
        responseStatus: response.statusCode,
        responseBody: body,
        durationMs: Date.now() - startTime,
        attempts: 1,
      });

      return { success, statusCode: response.statusCode, body };
    } catch (err) {
      // 网络异常同样落历史（responseStatus 为空，响应体记错误信息）
      WebhookModel.createDelivery({
        webhookId,
        eventType: 'ping',
        instanceId: null,
        payload,
        status: 'failed',
        responseStatus: null,
        responseBody: err.message,
        durationMs: Date.now() - startTime,
        attempts: 1,
      });
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
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 平台判定：webhooks.platform 显式字段（迁移 v11 已按 URL 推断过存量行，generic=纯用户显式选择） */
  static _resolvePlatform(webhook) {
    return webhook.platform && webhook.platform !== 'generic' ? webhook.platform : 'generic';
  }

  /** 通用消息文案：title=事件短句；text=带来源前缀的完整文本（IM 群机器人用） */
  static _platformMessage(eventType, payload) {
    const d = payload ?? {};
    const EVENT_TEXT = {
      'player.join': () => `${d.name ?? '玩家'} 加入了游戏`,
      'player.leave': () => `${d.name ?? '玩家'} 离开了游戏`,
      'player.death': () => `${d.name ?? '玩家'} ${d.cause ?? '死亡'}`,
      'player.respawn': () => `${d.name ?? '玩家'} 已重生`,
      'player.chat': () => `${d.name ?? '玩家'}: ${d.message ?? ''}`,
      'player.sleep': () => `${d.name ?? '玩家'} ${d.sleeping ? '入睡了' : '醒来了'}`,
      'player.achievement': () => `${d.name ?? '玩家'} 获得成就 [${d.advancement ?? ''}]`,
      'instance.start': () => '服务器已启动',
      'instance.stop': () => '服务器已停止',
      'instance.crash': () => `服务器意外退出${d.autoRestart ? '，正在自动重启' : ''}`,
      'instance.ready': () => '服务器已就绪',
      'instance.save': () => '世界已保存',
      ping: () => '测试投递（收到此条说明渠道配置生效）',
    };
    const title = EVENT_TEXT[eventType]?.() ?? `事件 ${eventType}`;
    const instance = d.instanceId
      ? `实例：${WebhookService._serverManager?.getInstance?.(d.instanceId)?.name ?? d.instanceId}`
      : null;
    return { title, text: `【MC_Commander】${title}${instance ? `\n${instance}` : ''}` };
  }

  /** 兼容别名：既有飞书测试引用 */
  static _feishuText(eventType, payload) {
    return this._platformMessage(eventType, payload).text;
  }

  /**
   * 按渠道预设构造投递请求（url/body）。
   * 各平台签名协议与消息体互不兼容：
   * - 飞书：key=`${timestamp}\n${secret}`、data 空串、base64，timestamp/sign 置于 body 字段；
   *   请求头不参与校验——不适配则签名校验拒收（code 19021），投递 HTTP 200 但消息不出群
   * - 钉钉：key=secret、data=`${timestamp}\n${secret}`、base64+URL 编码，
   *   timestamp（毫秒）/sign 拼接在 URL 查询参数
   * - 企微/Server酱/PushPlus：无签名；PushPlus 的 token 走 secret 字段进 body
   * generic 平台维持项目通用格式（payload 原样 + X-MC-Signature 请求头）
   */
  static _buildPlatformRequest(webhook, eventType, payload) {
    const platform = this._resolvePlatform(webhook);
    if (platform === 'generic') return null;

    const { title, text } = this._platformMessage(eventType, payload);

    if (platform === 'feishu') {
      const body = { msg_type: 'text', content: { text } };
      if (webhook.secret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        body.timestamp = timestamp;
        body.sign = crypto
          .createHmac('sha256', `${timestamp}\n${webhook.secret}`)
          .update('')
          .digest('base64');
      }
      return { url: webhook.url, body };
    }

    if (platform === 'dingtalk') {
      let url = webhook.url;
      if (webhook.secret) {
        const timestamp = Date.now().toString();
        const sign = crypto
          .createHmac('sha256', webhook.secret)
          .update(`${timestamp}\n${webhook.secret}`)
          .digest('base64');
        const joiner = url.includes('?') ? '&' : '?';
        url = `${url}${joiner}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
      }
      return { url, body: { msgtype: 'text', text: { content: text } } };
    }

    if (platform === 'wecom') {
      return { url: webhook.url, body: { msgtype: 'text', text: { content: text } } };
    }

    if (platform === 'serverchan') {
      // Server酱：SendKey 已含在 URL 中；title 必填不能含换行，正文走 desp
      return { url: webhook.url, body: { title: `【MC_Commander】${title}`, desp: text } };
    }

    if (platform === 'pushplus') {
      // PushPlus：token 由用户填在密钥字段（secret），随 body 传递；txt 模板适配纯文本通知
      return {
        url: webhook.url,
        body: {
          token: webhook.secret || '',
          title: `【MC_Commander】${title}`,
          content: text,
          template: 'txt',
        },
      };
    }

    return null;
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
  started: 'instance.start',
  stopped: 'instance.stop',
  crash: 'instance.crash',
  ready: 'instance.ready',
  save: 'instance.save',
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

  logger.info('[Webhook] Event dispatch bridge initialized');
}
