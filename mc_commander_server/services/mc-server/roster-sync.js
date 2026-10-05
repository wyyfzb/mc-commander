/**
 * 在线名单对账域（根修）：向服务端要一份权威名单，与内存名单求差集。
 *
 * 背景：在线名单此前只有一个来源——stdout 正则（output-parser 的 joined/left）。
 * 该来源在两类边界上必然丢事件，是同一根因的两处现场：
 *  ① 面板缺席（崩溃 / 更新重启）期间的加入——那几行 `joined the game` 早于接管点
 *     落盘，而日志续读从文件末尾起读（log-tail.js），永不回放 ⇒ 接管后名单恒空；
 *  ② 运行期漏解析（噪音过滤、整行截断、管道分块切断一行）⇒ 名单静默漂移。
 *
 * 名单来源按能力择优，两条产出的都是 `{names}`：
 *  - **MSMP**（1.21.9+ 且用户已开启）：结构化数组，无需解析文本，措辞漂移风险为零；
 *  - **RCON `list`**：官方只读命令（op 0；`hide-online-players` 只影响 SLP 的玩家
 *    列表，不影响它），覆盖全部版本与全部已配 RCON 的实例。
 *
 * 取不到名单（两条通道都不可用 / 命令失败 / 返回措辞不认识）一律**保持现状**：把名单
 * 清空比留着旧值更糟——界面会显示 0 人在线，而「显示 0 人」正是本域要修的症状。
 *
 * 本域只解决「此刻谁在线」，**不猜「这次会话从何时开始」**：服务器日志只有时分秒
 * 没有日期（实测），落盘的影子档案里那段未闭合会话无法区分「面板缺席期间一直在同一
 * 会话」与「缺席期间离开过又回来」。故补缺一律走 `_registerPlayerJoin`——会话从补缺
 * 时刻起算，落盘的累计时长与会话历史原样保留（`_registerPlayerJoin` 会把遗留的未闭合
 * 会话以零时长闭合）。宁可少算一段没人观测到的时长，也不把离线时段计进游戏时长：
 * 前者只是显示偏小，后者会污染持久化的累计值。
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
 * 取权威在线名单：MSMP 优先，RCON 兜底。
 *
 * MSMP 的可用性是**测得**的而不是**推断**的——本函数就是那次测量：拿到结构化名单
 * 即记可用，否则记不可用。用版本号推断不行（服务端可能没开、端口随机、或经反代）。
 *
 * @returns {Promise<{names: string[]} | null>} 取不到返回 null
 */
export async function _fetchOnlineRoster() {
  if (!this.isRunning) return null;
  const viaMsmp = await this._msmpFetchOnlinePlayers();
  this._msmpAvailable = !!viaMsmp;
  if (viaMsmp) return viaMsmp;
  // RCON 未连接时没有第二条通道可取回执
  if (!this.isRconConnected) return null;
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
 * 运行期对账：与内存 players 求差集，只补缺与移除，**不重置**已有条目
 * （累计时长、会话历史、事件都在条目里，整体重建会把它们清掉）。
 * 两个方向都走唯一权威路径——离开 `_handlePlayerLeave`（关会话/落盘/事件）、
 * 加入 `_registerPlayerJoin`（幂等），免得对账来的玩家在时长口径与事件上
 * 与日志来的分叉。
 */
export async function _reconcilePlayers() {
  // 命令在途期间实例可能被 stop/kill/卸载或崩溃退出（退出路径会清空 players 并
  // 停止采集），此时旧名单已是历史快照。据此写入会留下永远无人清理的幽灵在线
  // 玩家——服务器已停 ⇒ 后续对账永远取不到名单 ⇒ 按「保持现状」语义永不清除。
  // 代际比对同时挡住 stop→start：实例又在运行了，但那是新的一轮，旧名单不该生效。
  const epoch = this._rosterEpoch;
  const roster = await this._fetchOnlineRoster();
  if (!this.isRunning || epoch !== this._rosterEpoch) return;
  if (!roster) return;
  const online = new Set(roster.names);
  for (const name of [...this.players.keys()]) {
    if (!online.has(name)) this._handlePlayerLeave(name);
  }
  for (const name of roster.names) {
    if (this.players.has(name)) continue;
    // 来源 IP 未知（那行登录日志已错过）：留给界面按未知呈现，不拿上一次会话的旧值顶替
    this._registerPlayerJoin(name);
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
