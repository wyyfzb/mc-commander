import { authenticateWebSocket } from './middleware/auth.js';
import {
  isLocked as isCredentialLocked,
  recordFailure as recordCredentialFailure,
  clearFailures as clearCredentialFailures,
} from './utils/credential-lockout.js';
import { getDb } from './db/index.js';
import os from 'os';
import fs from 'fs';
import config from './config.js';
import { logger } from './utils/logger.js';
import { parseDbTime } from './utils/db-time.js';
import { inFlightDeploys } from './utils/deploy-inflight.js';

export const WSEvents = {
  LOG: 'log',
  STATUS: 'status',
  TPS_UPDATE: 'tpsUpdate',
  PERFORMANCE_UPDATE: 'performanceUpdate',
  WEATHER_UPDATE: 'weatherUpdate',
  PLAYER_STATS_UPDATE: 'playerStatsUpdate',
  PLAYER_JOIN: 'playerJoin',
  PLAYER_LEAVE: 'playerLeave',
  PLAYER_DEATH: 'playerDeath',
  PLAYER_RESPAWN: 'playerRespawn',
  PLAYER_CHAT: 'playerChat',
  PLAYER_SLEEP: 'playerSleep',
  ACHIEVEMENT: 'achievement',
  BACKUP_START: 'backupStart',
  BACKUP_COMPLETE: 'backupComplete',
  BACKUP_FAILED: 'backupFailed',
  BACKUP_SKIPPED: 'backupSkipped',
  RESTORE_START: 'restoreStart',
  RESTORE_COMPLETE: 'restoreComplete',
  RESTORE_FAILED: 'restoreFailed',
  TASK_EXECUTE: 'taskExecute',
  TASK_FAILED: 'taskFailed',
  WEBHOOK_DELIVERY_FAILED: 'webhookDeliveryFailed',
  DEPLOY_PROGRESS: 'deployProgress',
  DEPLOY_COMPLETE: 'deployComplete',
  DEPLOY_FAILED: 'deployFailed',
  // 用户取消部署：与 failed 分开是因为它不是故障（通知中心与筛选按严重度分档，
  // 复用 deployFailed 会让可控的主动取消显示成「部署失败」告警）
  DEPLOY_CANCELLED: 'deployCancelled',
  CIRCUIT_BREAKER: 'circuit_breaker',
  UPGRADE_PROGRESS: 'upgradeProgress',
  UPGRADE_COMPLETE: 'upgradeComplete',
  UPGRADE_FAILED: 'upgradeFailed',
  SYSTEM_STATS_UPDATE: 'systemStatsUpdate',
  ERROR: 'error',
};

// 客户端消息类型（集中枚举）
export const ClientMessages = {
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  PING: 'ping',
  AUTH: 'auth',
};

// ── find-012 安全加固：资源上限与频率限制 ─────────────────────────────
// 单服务端最大同时连接数：clients 集合已满时拒绝新连接（1013），
// 防止恶意客户端无限建立连接导致 clients Set 内存膨胀
export const MAX_CONNECTIONS = 32;
// 单连接最大订阅实例数：超限拒绝新增订阅（防订阅表无限增长 + 广播放大）
export const MAX_SUBSCRIPTIONS_PER_CLIENT = 64;
// 同一实例断线补齐（replayEvents）节流窗口：窗口内仅重放一次，
// 防止客户端反复携带 lastEventId 高频触发 DB 查询 + 最多 500 条发送的放大攻击
export const REPLAY_THROTTLE_MS = 5000;
// 单连接消息速率限制窗口与上限：窗口内超过上限直接断开（1008），防消息风暴
export const MESSAGE_RATE_WINDOW_MS = 60000;
export const MAX_MESSAGES_PER_WINDOW = 60;
// 首帧鉴权（H2-4b）：pending 连接的 auth 等待超时。pending 连接不在 clients
// 集合、不受消息速率限制管，但首条消息即定去留（超时/断开/首条处理），无需
// 消息数护栏
export const WS_AUTH_TIMEOUT_MS = 10_000;

// 需要持久化的通知类事件：广播前落库，客户端断线重连后按 lastEventId 补齐。
// 排除高频事件（log / status 快照 / performanceUpdate / tpsUpdate / weatherUpdate /
// playerStatsUpdate）——status 事件仅在 event 字段为状态跃迁时单独落库。
// taskExecute 移出落库集合：前端零消费（仅路由进 statusStream 无人监听），
// 每次任务执行必落库会挤占断线补齐 500 条配额（玩家进出密集的服上
// 最新事件含 backupFailed 关键通知会被挤出）。
const NOTIFICATION_EVENT_TYPES = new Set([
  WSEvents.PLAYER_JOIN,
  WSEvents.PLAYER_LEAVE,
  WSEvents.PLAYER_DEATH,
  WSEvents.PLAYER_RESPAWN,
  WSEvents.PLAYER_CHAT,
  WSEvents.PLAYER_SLEEP,
  WSEvents.ACHIEVEMENT,
  WSEvents.BACKUP_START,
  WSEvents.BACKUP_COMPLETE,
  WSEvents.BACKUP_FAILED,
  WSEvents.BACKUP_SKIPPED,
  WSEvents.RESTORE_START,
  WSEvents.RESTORE_COMPLETE,
  WSEvents.RESTORE_FAILED,
  // 任务失败与 backupFailed 同语义：低频高价值，落库断线补齐。
  // taskExecute 每次触发都发故不入集合（见上方注释），失败事件仅在异常时发射
  WSEvents.TASK_FAILED,
  // Webhook 投递失败：低频高价值，首次失败通知（连续失败去重后恢复）
  WSEvents.WEBHOOK_DELIVERY_FAILED,
  // 长任务终态（部署/升级完成与失败）：低频高价值，用户离开向导后
  // 唯一得知结果的通道；落库后断线/离线重连也能补齐看到。
  // 注意本集合只对经 broadcast() 的事件生效——部署终态三项走的是
  // broadcastGlobalNotification()（该入口无条件落库），在此列出只为同类事件同居一处
  WSEvents.DEPLOY_COMPLETE,
  WSEvents.DEPLOY_FAILED,
  WSEvents.DEPLOY_CANCELLED,
  WSEvents.UPGRADE_COMPLETE,
  WSEvents.UPGRADE_FAILED,
]);

// notification_events 保留期：超过保留期的记录定期清理（表只增不删，
// 玩家进出/聊天事件长期累积，断线补齐 500 条配额被历史事件挤占）
const NOTIFICATION_EVENT_RETENTION_DAYS = 7;

/// 清理过期的通知事件记录（启动时 + 每日定时）
export function cleanupNotificationEvents() {
  try {
    const db = getDb();
    const result = db
      .prepare(`DELETE FROM notification_events WHERE created_at < datetime('now', ?)`)
      .run(`-${NOTIFICATION_EVENT_RETENTION_DAYS} days`);
    if (result.changes > 0) {
      logger.info(`[WebSocket] Cleaned up ${result.changes} stale notification events`);
    }
  } catch (err) {
    logger.error('Failed to clean up notification events:', err);
  }
}

// status 事件中需要持久化的状态跃迁子事件（前端据此生成通知）
const STATUS_EVENT_TYPES = new Set(['started', 'stopped', 'crash', 'ready', 'save', 'circuit_breaker']);

// 跃迁子事件中属「意外失败」的关键事件：用户不一定正盯着出事的实例，投递面取全局，
// 否则多实例部署下非当前实例的崩溃只有恰好打开该实例控制台才看得见。
// started/stopped/ready/save 是常规生命周期（多数由用户在面板上发起），
// 保持订阅内投递——跨实例广播只会给其它实例的视图制造噪音
const CRITICAL_STATUS_EVENTS = new Set(['crash', 'circuit_breaker']);

/// 通知事件落库（广播前）：返回自增 id 供消息携带与断线补齐。
/// 上线字段名必须是 eventId——契约（mc-schemas/src/ws.ts）与前端游标
/// （api/ws.ts 的 saveLastEventId）都只认这个名字，发成 id 会让前端游标永不推进、
/// 断线补齐静默失效（补齐逻辑与落库照常工作，只是永远不会被触发）
function persistNotificationEvent(instanceId, type, data) {
  try {
    const db = getDb();
    const result = db
      .prepare(
        'INSERT INTO notification_events (instance_id, type, data) VALUES (?, ?, ?)'
      )
      .run(instanceId, type, JSON.stringify(data ?? {}));
    return result.lastInsertRowid;
  } catch (err) {
    // 落库失败不阻断广播（通知投递优先），但记录日志便于审计
    logger.error(`Failed to persist notification event (${type}):`, err);
    return null;
  }
}

// WS 会话复验：每 N 次心跳对 session 认证的连接抽样校验会话有效性。
// 被踢出/过期/删除的会话在下一轮复验中被 close(1008) 断开，
// 避免踢会后 WS 长连接无限存活。每次心跳只校验部分连接以控制 DB 开销。
export const WS_SESSION_REVALIDATE_INTERVAL = 3; // 每 3 次心跳（90s）轮询一轮全量复验
let heartbeatCount = 0;

export function setupWebSocket(wss, serverManager) {
  const clients = new Set();

  // 心跳保活：每 30s ping，60s 未 pong 则 terminate（防止代理静默断开的死连接残留 clients 集合）。
  // 同时对 session 认证的连接周期性复验会话有效性（踢出/过期后及时断开 WS）。
  const heartbeatInterval = setInterval(() => {
    heartbeatCount++;
    const doSessionRevalidate = heartbeatCount % WS_SESSION_REVALIDATE_INTERVAL === 0;

    for (const client of clients) {
      if (client.isAlive === false) {
        logger.warn('Terminating dead websocket client (heartbeat timeout)');
        client.terminate();
        clients.delete(client);
        continue;
      }

      // 会话复验：仅对 session 认证的连接（API Key 无会话可过期）
      if (doSessionRevalidate && client._sessionToken) {
        if (!authenticateWebSocket(null, client._sessionToken)) {
          logger.warn('Closing websocket: session token no longer valid (kicked or expired)');
          client.close(1008, 'Session invalidated');
          clients.delete(client);
          continue;
        }
      }

      client.isAlive = false;
      client.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(heartbeatInterval));

  // 通知事件表保留期清理：启动时清一次 + 每日定时（表只增不删会导致
  // 断线补齐 500 条配额被历史事件挤占）
  cleanupNotificationEvents();
  const cleanupInterval = setInterval(cleanupNotificationEvents, 24 * 60 * 60 * 1000);
  wss.on('close', () => clearInterval(cleanupInterval));

  // 首帧鉴权 pending 连接集合（pending 不入 clients，独立容量护栏）
  const pendingAuth = new Set();

  /** 鉴权失败统一告警（'IP now locked' 一次性标记，不逐请求刷日志） */
  function logAuthFailure(ip) {
    const justLocked = recordCredentialFailure(ip);
    logger.warn(
      `WebSocket auth failed, closing 1008 (ip=${ip ?? 'unknown'}${justLocked ? ', IP now locked' : ''})`
    );
  }

  /** 鉴权通过后的客户端登记与消息管线（subprotocol 与首帧两条鉴权通道共用） */
  function setupAuthenticatedClient(ws, { sessionToken }) {
    // 连接数上限：clients 已满（≥ MAX_CONNECTIONS）时拒绝新连接，
    // 防止恶意客户端无限建连耗尽服务端资源
    if (clients.size >= MAX_CONNECTIONS) {
      logger.warn(`Rejecting websocket connection: too many clients (${clients.size})`);
      ws.close(1013, 'Too many connections');
      return;
    }

    clients.add(ws);
    ws.isAlive = true;
    // 保存 session token 供心跳复验使用（API Key 认证无 token）
    ws._sessionToken = sessionToken || null;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    logger.info(`WebSocket client connected. Total: ${clients.size}`);

    // 长任务状态补发：连接建立即推送进行中的部署快照。部署进度是全局事件
    // （部署实例未入库，无订阅语义），刷新页面/重连后前端据此恢复「部署中」
    // 显示——长阶段（Forge 安装/首启）事件稀疏，仅靠阶段边界广播会零可见。
    // 读取判据与 GET /instances/deploy/status 同源（utils/deploy-inflight.js）：
    // 死快照不补发，否则前端会恢复一个早已结束的「部署中」视图
    try {
      for (const dep of inFlightDeploys(serverManager)) {
        ws.send(JSON.stringify({ type: WSEvents.DEPLOY_PROGRESS, data: dep, timestamp: Date.now() }));
      }
    } catch (err) {
      logger.error('Failed to send active deploy snapshot:', err);
    }

    ws.subscribedInstances = new Set();
    // 消息速率限制状态：当前窗口起点与窗口内已收消息数
    ws._msgRateWindowStart = 0;
    ws._msgCount = 0;

    ws.on('message', (data) => {
      // 消息速率限制：窗口内超过上限直接断开（防恶意客户端消息风暴）。
      // 计数放在 JSON 解析之前，无论消息格式是否合法都计入窗口
      const now = Date.now();
      if (now - ws._msgRateWindowStart >= MESSAGE_RATE_WINDOW_MS) {
        ws._msgRateWindowStart = now;
        ws._msgCount = 0;
      }
      ws._msgCount += 1;
      if (ws._msgCount > MAX_MESSAGES_PER_WINDOW) {
        logger.warn('Closing websocket client: message rate limit exceeded');
        ws.close(1008, 'Message rate limit exceeded');
        return;
      }

      try {
        const msg = JSON.parse(data);
        if (msg.type === ClientMessages.SUBSCRIBE) {
          // 订阅数上限：拒绝新增订阅（幂等重复订阅已有实例仍放行，
          // 不打断断线补齐重放）；超限返回 error 消息，不执行订阅
          if (
            ws.subscribedInstances.size >= MAX_SUBSCRIPTIONS_PER_CLIENT
            && !ws.subscribedInstances.has(msg.instanceId)
          ) {
            sendError(ws, 'Too many subscriptions');
            return;
          }
          ws.subscribedInstances.add(msg.instanceId);
          // 断线补齐：客户端携带 lastEventId 时重放其后的事件
          const lastEventId = Number(msg.lastEventId);
          if (Number.isFinite(lastEventId) && lastEventId > 0) {
            // 重放节流：同一实例 REPLAY_THROTTLE_MS 内仅重放一次，
            // 防止高频 subscribe 触发 DB 查询 + 500 条消息的放大攻击
            if (isReplayThrottled(msg.instanceId)) {
              sendError(ws, 'Event replay throttled, retry later');
            } else {
              replayEvents(ws, msg.instanceId, lastEventId);
            }
          }
          // 进行中升级补发：订阅即恢复该实例的升级进度（重连/刷新后
          // 升级弹窗与实例卡「升级中」标识可恢复）
          try {
            const upgradeProgress = serverManager.activeUpgrades?.get(msg.instanceId);
            if (upgradeProgress) {
              ws.send(JSON.stringify({
                type: WSEvents.UPGRADE_PROGRESS,
                instanceId: msg.instanceId,
                data: upgradeProgress,
                timestamp: Date.now(),
              }));
            }
          } catch (err) {
            logger.error('Failed to send active upgrade snapshot:', err);
          }
          const instance = serverManager.getInstance(msg.instanceId);
          if (instance) {
            ws.send(JSON.stringify({
              type: WSEvents.STATUS,
              instanceId: msg.instanceId,
              data: {
                status: instance.status,
                isRunning: instance.isRunning,
                players: instance.players || [],
                tps: instance.tps || null
              },
              timestamp: Date.now()
            }));
          }
        } else if (msg.type === ClientMessages.UNSUBSCRIBE) {
          ws.subscribedInstances.delete(msg.instanceId);
        } else if (msg.type === ClientMessages.PING) {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch {
        sendError(ws, 'Invalid message format');
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info(`WebSocket client disconnected. Total: ${clients.size}`);
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error:', err);
    });
  }

  wss.on('connection', (ws, req) => {
    // 凭据两条通道：① subprotocol 携带（handleProtocols 提取，向后兼容）；
    // ② 首帧消息 auth（H2-4b 主线：兼容代理剥离 Sec-WebSocket-Protocol 的部署环境）
    const apiKey = req._wsApiKey || null;
    const sessionToken = req._wsSessionToken || null;
    // 封禁键取直连 IP（与 HTTP 登录锁定同源，见 utils/credential-lockout.js）
    const ip = req.socket?.remoteAddress || null;

    // 认证失败 IP 临时封禁：锁定窗口内所有尝试一律拒绝（凭据正确也不放行），
    // 堵住「无限次握手/首帧试凭据」的爆破口子
    if (isCredentialLocked(ip)) {
      logger.warn(`Rejecting websocket connection: IP locked after auth failures (${ip ?? 'unknown'})`);
      ws.close(1008, 'Too many auth failures');
      return;
    }

    // 通道一（向后兼容）：凭据已在握手层携带，connection 时即完成校验
    if (apiKey || sessionToken) {
      if (!authenticateWebSocket(apiKey, sessionToken)) {
        logAuthFailure(ip);
        ws.close(1008, 'Unauthorized');
        return;
      }
      clearCredentialFailures(ip);
      setupAuthenticatedClient(ws, { sessionToken });
      return;
    }

    // 通道二（H2-4b 主线）：首帧鉴权——第一条消息必须是 auth；首条非 auth/
    // 凭据错误/坏 JSON 一律 1008 并计入封禁计数；超时与断开不计数（网络慢≠爆破）
    if (pendingAuth.size >= MAX_CONNECTIONS) {
      logger.warn('Rejecting websocket connection: too many pending auth connections');
      ws.close(1013, 'Too many connections');
      return;
    }
    pendingAuth.add(ws);
    let settled = false;
    let authTimer = null;
    function leavePending() {
      if (settled) return false;
      settled = true;
      pendingAuth.delete(ws);
      clearTimeout(authTimer);
      ws.removeListener('message', handleFirstMessage);
      return true;
    }
    authTimer = setTimeout(() => {
      if (leavePending()) ws.close(1008, 'Auth timeout');
    }, WS_AUTH_TIMEOUT_MS);
    function rejectPending(reason) {
      if (!leavePending()) return;
      logAuthFailure(ip);
      ws.close(1008, reason);
    }
    function handleFirstMessage(data) {
      let msg = null;
      try {
        msg = JSON.parse(data);
      } catch {
        rejectPending('Unauthorized');
        return;
      }
      if (!msg || msg.type !== ClientMessages.AUTH) {
        rejectPending('Unauthorized');
        return;
      }
      if (!authenticateWebSocket(msg.apiKey || null, msg.sessionToken || null)) {
        rejectPending('Unauthorized');
        return;
      }
      if (!leavePending()) return;
      clearCredentialFailures(ip);
      // 先回执 auth ok 再登记（登记时会补发 activeDeploys 快照——回执必须
      // 先于快照到达，否则客户端鉴权门控会丢弃部署进度补发）
      ws.send(JSON.stringify({ type: ClientMessages.AUTH, ok: true, timestamp: Date.now() }));
      setupAuthenticatedClient(ws, { sessionToken: msg.sessionToken || null });
    }
    ws.on('message', handleFirstMessage);
    ws.on('close', () => leavePending());
  });

  /// 断线补齐重放节流：按实例记录最近一次重放时间，窗口内返回 true（应节流）。
  /// 实例 ID 由用户手动创建、数量有限，Map 不会无限增长
  const lastReplayAt = new Map();
  function isReplayThrottled(instanceId) {
    const now = Date.now();
    const last = lastReplayAt.get(instanceId) || 0;
    if (now - last < REPLAY_THROTTLE_MS) return true;
    lastReplayAt.set(instanceId, now);
    return false;
  }

  /// 断线补齐：重放 lastEventId 之后的通知事件（上限 500 条防积压）
  function replayEvents(ws, instanceId, lastEventId) {
    try {
      const db = getDb();
      const events = db
        .prepare(
          `SELECT id, instance_id, type, data, created_at
           FROM notification_events
           WHERE id > ? AND (instance_id = ? OR instance_id IS NULL)
           ORDER BY id ASC LIMIT 500`
        )
        .all(lastEventId, instanceId);
      for (const ev of events) {
        const data = JSON.parse(ev.data || '{}');
        ws.send(JSON.stringify({
          eventId: ev.id,
          type: ev.type,
          // 归属回退到载荷：关键事件（crash/熔断）落库时 instance_id 置空以取得
          // 全局补齐面，实例归属只存在于 data.instanceId（前端据信封字段决定跳转目标）
          instanceId: ev.instance_id ?? data.instanceId ?? null,
          data,
          // parseDbTime 归一化：created_at 是无时区标记的 UTC 串，
          // 直接 Date.parse 在非 UTC 时区下会把补发事件的时间整体偏移。
          timestamp: parseDbTime(ev.created_at) || Date.now(),
        }));
      }
      if (events.length > 0) {
        logger.info(`Replayed ${events.length} notification events to client (after id ${lastEventId})`);
      }
    } catch (err) {
      logger.error('Failed to replay notification events:', err);
    }
  }

  /// 单条消息投递（带背压保护）：订阅过滤 + readyState + 慢客户端处置的唯一实现，
  /// 四条投递路径（实例广播 / 关键事件 / 全局通知 / broadcastAll）共用，避免背压判据分叉。
  /// includeUnsubscribed=true 的关键事件与全局事件投递给全部在线客户端
  function fanOut(message, { type, instanceId = null, includeUnsubscribed = false }) {
    for (const client of clients) {
      if (client.readyState !== 1) continue;
      if (!includeUnsubscribed && !client.subscribedInstances.has(instanceId)) continue;
      // 背压保护：慢客户端缓冲超阈值时跳过高频 LOG，超上限则断开。
      if (client.bufferedAmount > 1024 * 1024) {
        if (type === WSEvents.LOG) continue;
        if (client.bufferedAmount > 8 * 1024 * 1024) {
          logger.warn('Terminating slow websocket client (bufferedAmount overflow)');
          client.terminate();
          continue;
        }
      }
      client.send(message);
    }
  }

  /// 广播（带背压保护）：通知类事件先落库并携带事件 id
  function broadcast(instanceId, type, data) {
    let eventId = null;
    if (NOTIFICATION_EVENT_TYPES.has(type)) {
      eventId = persistNotificationEvent(instanceId, type, data);
    }
    const message = JSON.stringify({
      ...(eventId != null ? { eventId } : {}),
      type,
      instanceId,
      data,
      timestamp: Date.now()
    });

    fanOut(message, { type, instanceId });
  }

  function sendError(ws, message) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: WSEvents.ERROR,
        data: { message },
        timestamp: Date.now()
      }));
    }
  }

  /// 全局通知广播：落库（instance_id NULL，重连补齐对所有订阅者可见）+
  /// 发给所有在线客户端。用于无实例归属的低频高价值事件——部署终态：
  /// 部署实例在完成前不入库，订阅过滤不适用，broadcast 的订阅匹配会全部落空
  function broadcastGlobalNotification(type, data) {
    const eventId = persistNotificationEvent(null, type, data);
    const message = JSON.stringify({
      ...(eventId != null ? { eventId } : {}),
      type,
      data,
      timestamp: Date.now()
    });
    fanOut(message, { type, includeUnsubscribed: true });
  }

  serverManager.on('instance:log', (data) => {
    broadcast(data.instanceId, WSEvents.LOG, data);
  });

  serverManager.on('instance:status', (data) => {
    // status 快照高频（每 5s performance 附带）；仅状态跃迁子事件落库
    if (STATUS_EVENT_TYPES.has(data?.event)) {
      const critical = CRITICAL_STATUS_EVENTS.has(data.event);
      // 关键事件落库为全局行（instance_id 置空）：断线补齐对任何订阅者都可见，
      // 实例归属仍由载荷 data.instanceId 携带（前端据信封字段跳转实例页）
      const eventId = persistNotificationEvent(critical ? null : data.instanceId, WSEvents.STATUS, data);
      const message = JSON.stringify({
        ...(eventId != null ? { eventId } : {}),
        type: WSEvents.STATUS,
        instanceId: data.instanceId,
        data,
        timestamp: Date.now()
      });
      fanOut(message, {
        type: WSEvents.STATUS,
        instanceId: data.instanceId,
        includeUnsubscribed: critical
      });
      return;
    }
    broadcast(data.instanceId, WSEvents.STATUS, data);
  });

  serverManager.on('instance:playerJoin', (data) => {
    broadcast(data.instanceId, WSEvents.PLAYER_JOIN, data);
  });

  serverManager.on('instance:playerLeave', (data) => {
    broadcast(data.instanceId, WSEvents.PLAYER_LEAVE, data);
  });

  serverManager.on('instance:backupComplete', (data) => {
    broadcast(data.instanceId, WSEvents.BACKUP_COMPLETE, data);
  });

  serverManager.on('instance:backupStart', (data) => {
    broadcast(data.instanceId, WSEvents.BACKUP_START, data);
  });

  serverManager.on('instance:backupFailed', (data) => {
    broadcast(data.instanceId, WSEvents.BACKUP_FAILED, data);
  });

  // 定时备份因上一备份仍在进行而被跳过（task_scheduler 发出）
  serverManager.on('instance:backupSkipped', (data) => {
    broadcast(data.instanceId, WSEvents.BACKUP_SKIPPED, data);
  });

  // 恢复异步化三事件（backup.service.js executeRestore 发出）
  serverManager.on('instance:restoreStart', (data) => {
    broadcast(data.instanceId, WSEvents.RESTORE_START, data);
  });

  serverManager.on('instance:restoreComplete', (data) => {
    broadcast(data.instanceId, WSEvents.RESTORE_COMPLETE, data);
  });

  serverManager.on('instance:restoreFailed', (data) => {
    broadcast(data.instanceId, WSEvents.RESTORE_FAILED, data);
  });

  serverManager.on('instance:taskExecute', (data) => {
    broadcast(data.instanceId, WSEvents.TASK_EXECUTE, data);
  });

  // 定时任务执行失败（task_scheduler 发出）：与 backupFailed 一致的通知链
  serverManager.on('instance:taskFailed', (data) => {
    broadcast(data.instanceId, WSEvents.TASK_FAILED, data);
  });

  // Webhook 投递失败（webhook.service.js 重试耗尽后发出）：低频高价值，首次失败通知
  serverManager.on('instance:webhookDeliveryFailed', (data) => {
    broadcast(data.instanceId, WSEvents.WEBHOOK_DELIVERY_FAILED, data);
  });

  // 监听器注册：统一在 try 中注册并记录注册失败
  const EVENT_HANDLERS = [
    ['instance:playerDeath', (data) => broadcast(data.instanceId, WSEvents.PLAYER_DEATH, data)],
    ['instance:playerRespawn', (data) => broadcast(data.instanceId, WSEvents.PLAYER_RESPAWN, data)],
    ['instance:playerChat', (data) => broadcast(data.instanceId, WSEvents.PLAYER_CHAT, data)],
    ['instance:achievement', (data) => broadcast(data.instanceId, WSEvents.ACHIEVEMENT, data)],
    ['instance:tpsUpdate', (data) => broadcast(data.instanceId, WSEvents.TPS_UPDATE, data)],
    ['instance:performanceUpdate', (data) => broadcast(data.instanceId, WSEvents.PERFORMANCE_UPDATE, data)],
    ['instance:weatherUpdate', (data) => broadcast(data.instanceId, WSEvents.WEATHER_UPDATE, data)],
    ['instance:playerStatsUpdate', (data) => broadcast(data.instanceId, WSEvents.PLAYER_STATS_UPDATE, data)],
    ['instance:playerSleep', (data) => broadcast(data.instanceId, WSEvents.PLAYER_SLEEP, data)],
  ];
  for (const [eventName, handler] of EVENT_HANDLERS) {
    try {
      serverManager.on(eventName, handler);
    } catch (err) {
      logger.error(`Failed to register WebSocket listener for ${eventName}:`, err);
    }
  }

  // broadcastAll 限流：按 type 记录最近发送时间，同类型 15s 内不重复发送
  // （系统统计每 15s 推送一次 = 4/分钟 ≤ 240/分钟上限）
  const broadcastAllThrottle = new Map();
  const BROADCAST_ALL_THROTTLE_MS = 15_000;

  function broadcastAll(type, data) {
    const now = Date.now();
    const lastSent = broadcastAllThrottle.get(type) || 0;
    if (now - lastSent < BROADCAST_ALL_THROTTLE_MS) return;
    broadcastAllThrottle.set(type, now);
    const message = JSON.stringify({
      type,
      data,
      timestamp: Date.now()
    });

    fanOut(message, { type, includeUnsubscribed: true });
  }

  serverManager.on(WSEvents.DEPLOY_PROGRESS, (data) => {
    broadcastAll(WSEvents.DEPLOY_PROGRESS, data);
    // 部署终态转通知事件：deployProgress 本身高频不落库，完成/失败/取消仅此一次，
    // 落库后通知中心可见且断线补齐覆盖（用户离开向导后唯一得知结果的方式）
    if (data?.stage === 'complete') {
      broadcastGlobalNotification(WSEvents.DEPLOY_COMPLETE, data);
    } else if (data?.stage === 'error') {
      broadcastGlobalNotification(WSEvents.DEPLOY_FAILED, data);
    } else if (data?.stage === 'cancelled') {
      broadcastGlobalNotification(WSEvents.DEPLOY_CANCELLED, data);
    }
  });

  // 升级进度：带实例归属（可针对非当前查看实例），走 broadcast 盖章 instanceId
  // 并遵循客户端订阅过滤；缺 instanceId 的异常 payload 退回全局广播兜底。
  // 终态（completed/failed/rolled_back）额外转通知事件落库；通知 payload 补
  // 实例名（前端通知文案所需，升级失败回滚后 DB 版本已回写，不带版本号防误导）
  serverManager.on('instance:upgradeProgress', (data) => {
    if (data && data.instanceId) {
      broadcast(data.instanceId, WSEvents.UPGRADE_PROGRESS, data);
      const instance = serverManager.getInstance(data.instanceId);
      const notifyPayload = { ...data, instanceName: instance?.name ?? data.instanceId };
      if (data.stage === 'completed') {
        broadcast(data.instanceId, WSEvents.UPGRADE_COMPLETE, notifyPayload);
      } else if (data.stage === 'failed' || data.stage === 'rolled_back') {
        broadcast(data.instanceId, WSEvents.UPGRADE_FAILED, notifyPayload);
      }
    } else {
      broadcastAll(WSEvents.UPGRADE_PROGRESS, data);
    }
  });

  return { broadcast, broadcastAll, WSEvents, ClientMessages, startSystemStatsBroadcast };

  /// 每 15s 通过 broadcastAll 推送系统资源统计（CPU/内存/磁盘）
  /// 调用方在 index.js 启动后调用，返回 stop 函数供优雅停机
  function startSystemStatsBroadcast() {
    // 磁盘使用率 10s 缓存（复用 status.js 同逻辑）
    let _diskCache = { ts: 0, result: null };
    function getDiskUsage() {
      const now = Date.now();
      if (_diskCache.result && now - _diskCache.ts < 10_000) return _diskCache.result;
      const dirs = [config.serversDir, config.dataDir, config.backupsDir];
      const seen = new Map();
      for (const dir of dirs) {
        try {
          const stat = fs.statfsSync(dir);
          const total = stat.bsize * stat.blocks;
          const free = stat.bsize * stat.bfree;
          const used = total - free;
          const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
          const entry = {
            mountpoint: stat.mounted || dir,
            totalGB: Math.round(total / (1024 * 1024 * 1024) * 10) / 10,
            usedGB: Math.round(used / (1024 * 1024 * 1024) * 10) / 10,
            percent,
          };
          if (!seen.has(entry.mountpoint) || entry.percent > seen.get(entry.mountpoint).percent) {
            seen.set(entry.mountpoint, entry);
          }
        } catch { /* skip */ }
      }
      const all = Array.from(seen.values());
      const primary = all.sort((a, b) => b.percent - a.percent)[0] || null;
      const result = { primary, all };
      _diskCache = { ts: now, result };
      return result;
    }

    // CPU 使用率：简单 loadavg 近似（避免复制 /proc/stat 状态机）
    function getCpuUsage() {
      const cores = os.cpus().length || 1;
      const load = os.loadavg()[0] || 0;
      return Math.min(100, Math.round((load / cores) * 100 * 10) / 10);
    }

    function collectAndBroadcast() {
      const totalMemBytes = os.totalmem();
      const freeMemBytes = os.freemem();
      const usedMemBytes = totalMemBytes - freeMemBytes;
      const totalMemGB = Math.round(totalMemBytes / (1024 * 1024 * 1024) * 10) / 10;
      const usedMemGB = Math.round(usedMemBytes / (1024 * 1024 * 1024) * 10) / 10;
      const memUsagePercent = totalMemBytes > 0
        ? Math.round((usedMemBytes / totalMemBytes) * 1000) / 10 : 0;
      broadcastAll(WSEvents.SYSTEM_STATS_UPDATE, {
        cpuUsage: getCpuUsage(),
        memoryUsage: usedMemGB,
        totalMemory: totalMemGB,
        memoryPercent: memUsagePercent,
        cpuCores: os.cpus().length,
        loadAvg: os.loadavg(),
        uptime: os.uptime(),
        diskUsage: getDiskUsage(),
      });
    }

    // 立即推送一次，然后每 15s 定时
    collectAndBroadcast();
    const timer = setInterval(collectAndBroadcast, 15_000);
    return () => clearInterval(timer);
  }
}

export default setupWebSocket;
