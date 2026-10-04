/**
 * 在线名单对账域（根修）：RCON `list` 作为在线名单的权威来源。
 *
 * 背景：在线名单此前只有一个来源——stdout 正则（output-parser 的 joined/left）。
 * 该来源在两类边界上必然丢事件，是同一根因的两处现场：
 *  ① 面板缺席（崩溃 / 更新重启）期间的加入——那几行 `joined the game` 早于接管点
 *     落盘，而日志续读从文件末尾起读（log-tail.js），永不回放 ⇒ 接管后名单恒空；
 *  ② 运行期漏解析（噪音过滤、整行截断、管道分块切断一行）⇒ 名单静默漂移。
 *
 * 机制：`list` 是官方只读命令（op 0；`hide-online-players` 只影响 SLP 的玩家列表，
 * 不影响它）。周期性与内存名单求差集，只补缺与移除，**不重置**已有条目。
 *
 * 取不到名单（RCON 未连接 / 命令失败 / 返回措辞不认识）一律**保持现状**：把名单
 * 清空比留着旧值更糟——界面会显示 0 人在线，而「显示 0 人」正是本域要修的症状。
 *
 * 顺带覆盖了「面板启动即接管」这条路径：接管时 RCON 通常尚未握手，本域不做一次性
 * 立即重建，等首轮对账时 RCON 已就绪，名单自然补齐。
 */

import { parseListResponse } from './list-response.js';
import { logger } from '../../utils/logger.js';

/** 对账间隔：一条只读命令，开销可忽略；比前端玩家列表 30s 保底轮询略慢即可 */
export const ROSTER_RECONCILE_INTERVAL_MS = 60000;
/** 首轮对账提前量：面板启动时 RCON 尚未握手/服务器正在启动，留出握手窗口 */
export const ROSTER_FIRST_RECONCILE_MS = 10000;
/** 名单查询的调用方级超时：rcon-client 仅在请求出队时才计时，队列滞留期无超时 */
const ROSTER_QUERY_TIMEOUT_MS = 5000;

/**
 * 取权威在线名单。
 * @returns {Promise<{names: string[]} | null>} 取不到返回 null
 */
export async function _fetchOnlineRoster() {
  if (!this.isRunning || !this.isRconConnected) return null;
  // 空名单是合法答案（解析出 0 人），与「取不到」必须区分——后者才是不作为的理由
  try {
    return parseListResponse(
      await this.sendCommandWithResponse('list', { timeout: ROSTER_QUERY_TIMEOUT_MS }),
    );
  } catch {
    // 命令队列拒绝 / RCON 卡顿：本轮放弃，下轮再试
    return null;
  }
}

/**
 * 由面板落盘的 playerdata 还原一个在线条目——面板缺席期间的加入专用（静默）。
 *
 * 判据是「末段会话未闭合」：面板每次落盘都在玩家仍在线时进行，故未闭合意味着面板
 * 没来得及记 leave 就失去了该玩家（崩溃/重启），而不是刚发生一次漏解析的加入。
 * 固有精度上限：玩家若在面板缺席期间退出又重进，落盘的未闭合会话仍是退出前那段
 * （面板没看见那次退出），在线时长会高估一个重进间隔——它量的是「面板眼中的连续
 * 会话」，不是「玩家眼中的本次登录」。
 *
 * joinTime 取该会话的 start：面板缺席期间玩家仍在同一会话里，该时刻就是真实加入
 * 时刻（精度受 60s 保存周期限制）。让 joinTime 落到对账时刻会同时错两处——在线时长
 * 从 0 重新计（丢掉整个面板停机时段），且 `_handlePlayerLeave` 届时只累计停机后的
 * 时长。ip 同理取落盘值：未闭合会话说明它就是本次会话的地址，而 IP 封禁匹配依赖
 * 它非空。
 *
 * 不补发 join 事件、不计今日新增：加入发生在面板缺席期间，此刻补发是假事件。
 * @param {string} name 玩家名
 * @returns {object|null} 无「面板缺席期间的加入」线索时返回 null
 */
export function _restoreOnlinePlayerEntry(name) {
  const saved = this._loadPlayerData(name) || {};
  const sessions = Array.isArray(saved.sessions) ? saved.sessions : [];
  const open = sessions[sessions.length - 1];
  if (!open || open.end != null || !open.start) return null;
  return {
    name,
    joinTime: open.start,
    ip: saved.ip || '',
    totalPlayTime: saved.totalPlayTime || 0,
    sessions,
  };
}

/**
 * 运行期对账：与内存 players 求差集，只补缺与移除，**不重置**已有条目
 * （累计时长、会话历史、事件都在条目里，整体重建会把它们清掉）。
 * 两个方向各自复用唯一权威路径——离开走 `_handlePlayerLeave`（关会话/落盘/事件），
 * 加入按落盘线索分流（见下），免得对账来的玩家在时长口径与事件上与日志来的分叉。
 */
export async function _reconcilePlayers() {
  const roster = await this._fetchOnlineRoster();
  if (!roster) return;
  const online = new Set(roster.names);
  for (const name of [...this.players.keys()]) {
    if (!online.has(name)) this._handlePlayerLeave(name);
  }
  for (const name of roster.names) {
    if (this.players.has(name)) continue;
    // 面板缺席期间的加入：按落盘线索静默还原
    const restored = this._restoreOnlinePlayerEntry(name);
    if (restored) {
      this.players.set(name, restored);
    } else {
      // 真·新加入（漏掉了刚那行日志）：走与日志解析同一入口，事件与今日新增加数照记。
      // 来源 IP 未知——那行登录日志已错过，留给界面按未知呈现，不拿上一次会话的旧值顶替
      this._registerPlayerJoin(name);
    }
  }
}

/** 启动对账链（随采集矩阵生命周期，见 stats-collector 的 _startStatsCollection）。 */
export function _startRosterSync() {
  this._stopRosterSync();
  this._scheduleRosterReconcile(ROSTER_FIRST_RECONCILE_MS);
}

/** 对账调度（串行化递归 setTimeout）：上一轮完成后才排下一轮，防 RCON 卡顿时重叠。
 *  代际 epoch 防双链：stop 时自增使在途回调恢复后不再续链（同 stats-collector）。 */
export function _scheduleRosterReconcile(delayMs = ROSTER_RECONCILE_INTERVAL_MS) {
  const epoch = this._rosterEpoch;
  this._rosterTimer = setTimeout(async () => {
    this._rosterTimer = null;
    try {
      await this._reconcilePlayers();
    } catch (e) {
      // 监听器抛错（playerJoin/playerLeave 广播失败）等异常不得中断链
      logger.warn(`[${this.id}] 在线名单对账失败:`, e.message);
    }
    if (epoch === this._rosterEpoch) this._scheduleRosterReconcile();
  }, delayMs);
  // 不阻塞面板进程退出
  this._rosterTimer.unref?.();
}

export function _stopRosterSync() {
  if (this._rosterTimer) {
    clearTimeout(this._rosterTimer);
    this._rosterTimer = null;
  }
  // 代际自增：作废在途回调（timer 已触发、await 挂起中）的续链
  this._rosterEpoch++;
}
