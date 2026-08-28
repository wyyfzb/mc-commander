import { authenticateWebSocket } from './middleware/auth.js';
import { getDb } from './db/index.js';

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
  DEPLOY_PROGRESS: 'deployProgress',
  CIRCUIT_BREAKER: 'circuit_breaker',
  ERROR: 'error',
};

// 客户端消息类型（集中枚举）
export const ClientMessages = {
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  PING: 'ping',
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
      console.log(`[WebSocket] Cleaned up ${result.changes} stale notification events`);
    }
  } catch (err) {
    console.error('Failed to clean up notification events:', err);
  }
}

// status 事件中需要持久化的状态跃迁子事件（前端据此生成通知）
const STATUS_EVENT_TYPES = new Set(['started', 'stopped', 'crash', 'ready', 'save', 'circuit_breaker']);

/// 通知事件落库（广播前）：返回自增 id 供消息携带与断线补齐
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
    console.error(`Failed to persist notification event (${type}):`, err);
    return null;
  }
}

export function setupWebSocket(wss, serverManager) {
  const clients = new Set();

  // 心跳保活：每 30s ping，60s 未 pong 则 terminate（防止代理静默断开的死连接残留 clients 集合）。
  const heartbeatInterval = setInterval(() => {
    for (const client of clients) {
      if (client.isAlive === false) {
        console.warn('Terminating dead websocket client (heartbeat timeout)');
        client.terminate();
        clients.delete(client);
        continue;
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

  wss.on('connection', (ws, req) => {
    // API Key 由 handleProtocols 在 index.js 中提取并挂载到 req._wsApiKey
    const apiKey = req._wsApiKey || null;

    if (!authenticateWebSocket(apiKey)) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    // 连接数上限：clients 已满（≥ MAX_CONNECTIONS）时拒绝新连接，
    // 防止恶意客户端无限建连耗尽服务端资源
    if (clients.size >= MAX_CONNECTIONS) {
      console.warn(`Rejecting websocket connection: too many clients (${clients.size})`);
      ws.close(1013, 'Too many connections');
      return;
    }

    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    console.log(`WebSocket client connected. Total: ${clients.size}`);

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
        console.warn('Closing websocket client: message rate limit exceeded');
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
      console.log(`WebSocket client disconnected. Total: ${clients.size}`);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
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
        ws.send(JSON.stringify({
          id: ev.id,
          type: ev.type,
          instanceId: ev.instance_id,
          data: JSON.parse(ev.data || '{}'),
          timestamp: Date.parse(ev.created_at) || Date.now(),
        }));
      }
      if (events.length > 0) {
        console.log(`Replayed ${events.length} notification events to client (after id ${lastEventId})`);
      }
    } catch (err) {
      console.error('Failed to replay notification events:', err);
    }
  }

  /// 广播（带背压保护）：通知类事件先落库并携带事件 id
  function broadcast(instanceId, type, data) {
    let eventId = null;
    if (NOTIFICATION_EVENT_TYPES.has(type)) {
      eventId = persistNotificationEvent(instanceId, type, data);
    }
    const message = JSON.stringify({
      ...(eventId != null ? { id: eventId } : {}),
      type,
      instanceId,
      data,
      timestamp: Date.now()
    });

    for (const client of clients) {
      if (client.readyState !== 1 || !client.subscribedInstances.has(instanceId)) {
        continue;
      }
      // 背压保护：慢客户端缓冲超阈值时跳过高频 LOG，超上限则断开。
      if (client.bufferedAmount > 1024 * 1024) {
        if (type === WSEvents.LOG) continue;
        if (client.bufferedAmount > 8 * 1024 * 1024) {
          console.warn('Terminating slow websocket client (bufferedAmount overflow)');
          client.terminate();
          continue;
        }
      }
      client.send(message);
    }
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

  serverManager.on('instance:log', (data) => {
    broadcast(data.instanceId, WSEvents.LOG, data);
  });

  serverManager.on('instance:status', (data) => {
    // status 快照高频（每 5s performance 附带）；仅状态跃迁子事件落库
    if (STATUS_EVENT_TYPES.has(data?.event)) {
      const eventId = persistNotificationEvent(data.instanceId, WSEvents.STATUS, data);
      const message = JSON.stringify({
        ...(eventId != null ? { id: eventId } : {}),
        type: WSEvents.STATUS,
        instanceId: data.instanceId,
        data,
        timestamp: Date.now()
      });
      for (const client of clients) {
        if (client.readyState === 1 && client.subscribedInstances.has(data.instanceId)) {
          client.send(message);
        }
      }
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
      console.error(`Failed to register WebSocket listener for ${eventName}:`, err);
    }
  }

  function broadcastAll(type, data) {
    const message = JSON.stringify({
      type,
      data,
      timestamp: Date.now()
    });

    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  }

  serverManager.on(WSEvents.DEPLOY_PROGRESS, (data) => {
    broadcastAll(WSEvents.DEPLOY_PROGRESS, data);
  });

  return { broadcast, broadcastAll, WSEvents, ClientMessages };
}

export default setupWebSocket;
