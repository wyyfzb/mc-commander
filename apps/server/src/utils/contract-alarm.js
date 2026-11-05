/**
 * 契约漂移告警：REST 响应与 WS 载荷共用这一份。
 *
 * 按「首个 issue 的 path+code+message」签名节流——轮询类热路径（玩家列表 30s、
 * WS 性能推送）一旦漂移会持续触发，不聚合会把日志刷成噪音；而静默降级会杀死
 * 漂移观测本身。签名数有界（>200 时清理过期项）。
 *
 * 只告警、不阻断：REST 侧响应已经产生、WS 侧消息已经发出，此刻拒绝也无处可退。
 * 把漂移变成一条可检索的日志，是这里能给出的最大保证。
 */
import { logger } from './logger.js';

const ALARM_WINDOW_MS = 5 * 60_000;
const alarms = new Map();

/**
 * @param {string} scope 告警归属（'rest' / 'ws'），用于区分同签名不同链路的漂移
 * @param {Array<{path?: Array<string|number>, code?: string, message?: string}>} issues
 */
export function logContractAlarm(scope, issues) {
  const first = issues[0] ?? {};
  const path = Array.isArray(first.path) ? first.path.join('.') : (first.path ?? '');
  const signature = `${scope}|${path}|${first.code}|${first.message}`;
  const now = Date.now();
  const state = alarms.get(signature);
  if (!state) {
    alarms.set(signature, { count: 1, lastLoggedAt: now });
    logger.error(`[contract] ${scope} 数据与 schema 不一致:`, issues);
    return;
  }
  state.count += 1;
  if (now - state.lastLoggedAt >= ALARM_WINDOW_MS) {
    logger.error(
      `[contract] ${scope} 数据与 schema 不一致（窗口内同签名已抑制 ${state.count - 1} 条）:`,
      issues,
    );
    state.count = 0;
    state.lastLoggedAt = now;
  }
  if (alarms.size > 200) {
    for (const [key, value] of alarms) {
      if (now - value.lastLoggedAt >= ALARM_WINDOW_MS) alarms.delete(key);
    }
  }
}

/** 测试用：清空聚合状态，让同一签名可以重新触发首次告警 */
export function resetContractAlarms() {
  alarms.clear();
}
