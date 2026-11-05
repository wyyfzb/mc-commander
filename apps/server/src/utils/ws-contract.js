/**
 * 服务端 WS 载荷的发送前校验：只观测、不阻断。
 *
 * 消息一旦序列化就已离开服务端，此刻拒绝也无处可退——校验的唯一作用是让
 * 「服务端发出的结构与契约不符」变成一条可检索的告警，而不是等前端静默
 * 渲染成空白后才被发现。
 *
 * 只对已定契约的事件登记；其余事件跳过。40 个事件类型里目前只有 9 个有
 * payload schema，未登记的按「暂无契约」处理，不是这里漏了。
 *
 * **只管实时发送，不管断线补齐的重放**：重放读的是历史落库行，那些数据可能是旧
 * 版本服务端写下的，用当前 schema 校验会把「历史形状不同」报成漂移。重放因此
 * 直发 ws.send、不经过这里。
 */
import {
  wsStatusSnapshotSchema,
  wsPerformancePayloadSchema,
  wsLogPayloadSchema,
  wsStatusEventPayloadSchema,
  wsNameListChangedPayloadSchema,
  wsPlayerEventPayloadSchema,
  wsWeatherPayloadSchema,
  wsWorldUpgradePayloadSchema,
  wsBackupPayloadSchema,
  wsBackupProgressPayloadSchema,
} from '@mc-commander/schemas';
import { logContractAlarm } from '../utils/contract-alarm.js';

const PAYLOAD_SCHEMAS = new Map([
  ['statusSnapshot', wsStatusSnapshotSchema],
  ['performanceUpdate', wsPerformancePayloadSchema],
  ['log', wsLogPayloadSchema],
  ['statusEvent', wsStatusEventPayloadSchema],
  ['nameListChanged', wsNameListChangedPayloadSchema],
  ['weatherUpdate', wsWeatherPayloadSchema],
  ['worldUpgrade', wsWorldUpgradePayloadSchema],
  ['backupStart', wsBackupPayloadSchema],
  ['backupComplete', wsBackupPayloadSchema],
  ['backupFailed', wsBackupPayloadSchema],
  ['backupSkipped', wsBackupPayloadSchema],
  ['backupCancelled', wsBackupPayloadSchema],
  ['backupProgress', wsBackupProgressPayloadSchema],
  ['playerJoin', wsPlayerEventPayloadSchema],
  ['playerLeave', wsPlayerEventPayloadSchema],
  ['playerDeath', wsPlayerEventPayloadSchema],
  ['playerRespawn', wsPlayerEventPayloadSchema],
  ['playerChat', wsPlayerEventPayloadSchema],
  ['playerSleep', wsPlayerEventPayloadSchema],
  ['achievement', wsPlayerEventPayloadSchema],
]);

/**
 * @param {string} type 事件类型
 * @param {unknown} data 即将发出的载荷
 */
export function observeWsPayload(type, data) {
  const schema = PAYLOAD_SCHEMAS.get(type);
  if (!schema) return;
  const parsed = schema.safeParse(data);
  if (!parsed.success) logContractAlarm('ws', parsed.error.issues);
}
