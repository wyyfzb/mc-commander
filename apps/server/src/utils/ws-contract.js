/**
 * 服务端 WS 载荷的发送前校验：只观测、不阻断。
 *
 * 消息一旦序列化就已离开服务端，此刻拒绝也无处可退——校验的唯一作用是让
 * 「服务端发出的结构与契约不符」变成一条可检索的告警，而不是等前端静默
 * 渲染成空白后才被发现。
 *
 * 契约表本身在 `@mc-commander/schemas` 的 `WS_PAYLOAD_SCHEMAS`：它按
 * `Record<WsEventType, ...>` 声明，新增事件不登记即编译失败。这里不再维护
 * 第二份清单——两份清单必然漂移，而漏登记的症状是「该事件从此没有契约」，
 * 静默得几乎不可能被发现。
 *
 * **只管实时发送，不管断线补齐的重放**：重放读的是历史落库行，那些数据可能是旧
 * 版本服务端写下的，用当前 schema 校验会把「历史形状不同」报成漂移。重放因此
 * 直发 ws.send、不经过这里。
 */
import { WS_PAYLOAD_SCHEMAS } from '@mc-commander/schemas';
import { logContractAlarm } from '../utils/contract-alarm.js';

/**
 * @param {string} type 事件类型
 * @param {unknown} data 即将发出的载荷
 */
export function observeWsPayload(type, data) {
  const schema = WS_PAYLOAD_SCHEMAS[type];
  // 非事件类型（`pong`/`auth` 等）与显式标为无载荷的事件都跳过
  if (!schema) return;
  const parsed = schema.safeParse(data);
  if (!parsed.success) logContractAlarm('ws', parsed.error.issues);
}
