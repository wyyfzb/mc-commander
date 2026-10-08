/**
 * MSMP 方法面：同一件写操作有**两条通道**，能结构化就结构化，拿不到再退回等价的命令。
 *
 * 为什么要它：命令通道只回一句人读的英文文本，成败要靠匹配短语；MSMP 的方法回的是结构化对象。
 * 两条通道的可信度不同——结构化通道直接告诉我们「哪些对象真的被改动了」，命令通道只能靠文本，
 * 而且原版不少失败压根没有可匹配的措辞（实测 26.3：`whitelist add <查不到的名字>` 回
 * `That player does not exist`，不在既有的失败短语表里 ⇒ 面板把它当成功上报）。
 *
 * 判据（实测 26.3 的返回值语义）：
 * - **add 类**（allowlist/operators/bans/ip_bans）返回**本次真正落地的对象数组**；
 *   目标不在返回值里 ⇒ 操作没生效，据此报错。这是结构化通道比命令通道更强的地方。
 * - **remove 类**一律回空数组，分辨不出「移除了」与「本来就不在」；两者对外都是成功
 *   （与命令通道一致：`pardon` 一条不存在的封禁回 `Nothing changed.`，面板历来当成功）。
 * - 方法不可用 / 传输或协议错误 / 超时 ⇒ 该通道**没做成**，退回等价命令。
 *
 * 「通道不可用」与「操作没生效」必须分开：把后者也退回命令，会让同一个动作执行两次
 * （kick/ban 非幂等，重复生效是实打实的副作用）。
 *
 * 调用方（路由）只表达**意图**，不再拼命令字符串：结构化参数是 JSON，天然没有命令注入面；
 * 命令串只在回退分支里拼，且沿用原有的输入清洗。
 */

/** 单次结构化写超时：与查询同档，写操作要等服务器真正落地 */
export const MSMP_WRITE_TIMEOUT_MS = 5000;
/**
 * 停机的结构化超时单独收短：调用方在停机路径上会「等进程退出 → 超时强杀」，
 * 而服务端可能正卡着不答（这正是要停它的原因）；等满一个查询超时再回退命令，
 * 会让优雅停机白等好几秒。实测健康服务端 27ms 就回 `true`。
 */
export const MSMP_STOP_TIMEOUT_MS = 1500;

/** 原版封禁条目里的 `source`：控制台/RCON 下发时原版写的就是它，保持一致 */
const COMMAND_SOURCE = 'Server';

/** 结构化返回值里的目标匹配：allowlist/ip_bans 是平铺对象，operators/bans 把玩家包在 player 里 */
function _resultHasPlayer(result, name) {
  return (
    Array.isArray(result) &&
    result.some((entry) => entry && (entry.name === name || entry.player?.name === name))
  );
}

function _resultHasIp(result, ip) {
  return Array.isArray(result) && result.some((entry) => entry && entry.ip === ip);
}

/**
 * 按能力择优执行一次写操作。
 *
 * @param {{method: string, params: unknown[], verify?: (result: unknown) => boolean,
 *          unverifiedMessage?: string} | null} structured 结构化通道（null = 该方法无结构化等价物）
 * @param {(() => Promise<unknown>) | null} runCommand 等价的命令通道（null = 该动作没有命令等价物）
 * @returns {Promise<'msmp' | 'command' | 'skipped'>} 实际生效的通道；skipped = 无命令等价物且结构化通道不可用
 */
export async function _writeViaPreferredChannel(structured, runCommand) {
  if (structured) {
    const result = await this._msmpRequest(
      structured.method,
      structured.params,
      structured.timeoutMs ?? MSMP_WRITE_TIMEOUT_MS,
    );
    if (result !== null && result !== undefined) {
      // 只在成功时置能力位：写失败可能是参数/对象问题，不足以判定整条通道不可用
      this._msmpAvailable = true;
      if (!structured.verify || structured.verify(result)) return 'msmp';
      const err = new Error(structured.unverifiedMessage);
      err.isCommandExecutionError = true;
      throw err;
    }
  }
  // 没有等价命令 ⇒ 这条属性本次没法在运行中生效（调用方据此计入「需重启」）
  if (!runCommand) return 'skipped';
  await runCommand();
  return 'command';
}

/**
 * 面板属性键 → MSMP 服务器设置方法。
 *
 * 逐条实测（26.3）核对过「setter 回读＝server.properties 落盘值」，单位与 properties 一致；
 * 两处必须留意的实测结论：
 * - `player_idle_timeout` 的 schema 与参数名都写 `seconds`，**实测是分钟**（设 120 → 服务端日志
 *   「Update player idle timeout from 0 minutes to 120 minutes」、落盘 `player-idle-timeout=120`），
 *   与面板 UI（分钟）同单位，故**直接透传不换算**；
 * - `status_heartbeat_interval` 与 `status_replies` 两个 setter 在 26.3 不生效（前者设 7 回读 0
 *   且文件无变化、后者调用失败），**不纳入**。
 *
 * `fallbackCommand` 只在这 5 个键上存在（原版有等价命令）；其余键在 MSMP 不可用时退回
 * 「写文件 + 提示重启」这条既有路径，不假造命令。
 */
export const SERVER_SETTING_METHODS = {
  'white-list': {
    method: 'minecraft:serversettings/use_allowlist/set',
    toValue: (v) => String(v).toLowerCase() === 'true',
    fallbackCommand: (v) => (String(v).toLowerCase() === 'true' ? 'whitelist on' : 'whitelist off'),
  },
  'enforce-whitelist': {
    method: 'minecraft:serversettings/enforce_allowlist/set',
    toValue: (v) => String(v).toLowerCase() === 'true',
    fallbackCommand: (v) =>
      String(v).toLowerCase() === 'true' ? 'whitelist enforce on' : 'whitelist enforce off',
  },
  difficulty: {
    method: 'minecraft:serversettings/difficulty/set',
    toValue: (v) => String(v),
    fallbackCommand: (v) => `difficulty ${v}`,
  },
  gamemode: {
    method: 'minecraft:serversettings/game_mode/set',
    toValue: (v) => String(v),
    fallbackCommand: (v) => `defaultgamemode ${v}`,
  },
  'force-gamemode': {
    method: 'minecraft:serversettings/force_game_mode/set',
    toValue: (v) => String(v).toLowerCase() === 'true',
  },
  'max-players': {
    method: 'minecraft:serversettings/max_players/set',
    toValue: (v) => Number(v),
  },
  motd: { method: 'minecraft:serversettings/motd/set', toValue: (v) => String(v) },
  'view-distance': {
    method: 'minecraft:serversettings/view_distance/set',
    toValue: (v) => Number(v),
  },
  'simulation-distance': {
    method: 'minecraft:serversettings/simulation_distance/set',
    toValue: (v) => Number(v),
  },
  'spawn-protection': {
    method: 'minecraft:serversettings/spawn_protection_radius/set',
    toValue: (v) => Number(v),
  },
  'allow-flight': {
    method: 'minecraft:serversettings/allow_flight/set',
    toValue: (v) => String(v).toLowerCase() === 'true',
  },
  'player-idle-timeout': {
    method: 'minecraft:serversettings/player_idle_timeout/set',
    toValue: (v) => Number(v),
    fallbackCommand: (v) => `setidletimeout ${v}`,
  },
  'hide-online-players': {
    method: 'minecraft:serversettings/hide_online_players/set',
    toValue: (v) => String(v).toLowerCase() === 'true',
  },
  'op-permission-level': {
    method: 'minecraft:serversettings/operator_user_permission_level/set',
    toValue: (v) => Number(v),
  },
  'entity-broadcast-range-percentage': {
    method: 'minecraft:serversettings/entity_broadcast_range/set',
    toValue: (v) => Number(v),
  },
};

/** 能运行期热改的属性键（`restartRequired` 的判据与前端热改标记都以它为准） */
export const SERVER_SETTING_KEYS = new Set(Object.keys(SERVER_SETTING_METHODS));

/**
 * 运行期应用一条面板属性。
 *
 * 判据用**setter 自己的回读值**：MSMP 的 setter 返回它实际生效的值，值不一致即没生效
 * （实测 `status_heartbeat_interval` 就是这样被识别为静默失效的），据此报错而不是报成功。
 *
 * @returns {Promise<'msmp' | 'command' | 'skipped'>} skipped = 该键无结构化方法，或
 *   MSMP 不可用且没有等价命令（此时调用方应把它计入「需重启」）
 */
export function applyServerSetting(key, rawValue) {
  const spec = SERVER_SETTING_METHODS[key];
  if (!spec) return Promise.resolve('skipped');
  const value = spec.toValue(rawValue);
  const runCommand = spec.fallbackCommand
    ? () => this.sendCommand(spec.fallbackCommand(rawValue))
    : null;
  return this._writeViaPreferredChannel(
    {
      method: spec.method,
      params: [value],
      verify: (result) => result === value,
      unverifiedMessage: `${key} 未在运行中生效：服务端返回的值与提交值不一致`,
    },
    runCommand,
  );
}

/** 让世界落盘：`flush=true` 等价 `save-all flush`（实测返回 `true`） */
export function saveWorld() {
  return this._writeViaPreferredChannel(
    {
      method: 'minecraft:server/save',
      params: [true],
      verify: (result) => result === true,
      unverifiedMessage: '保存世界未成功：服务端未确认落盘',
    },
    () => this.sendCommandWithResponse('save-all flush', { timeout: 5000 }),
  );
}

/** 停机：实测 `server/stop` 会在关服前回 `true`（27ms），故不会误触发回退重发 */
export function stopServer() {
  return this._writeViaPreferredChannel(
    {
      method: 'minecraft:server/stop',
      params: [],
      timeoutMs: MSMP_STOP_TIMEOUT_MS,
      verify: (result) => result === true,
      unverifiedMessage: '停机未生效：服务端未确认',
    },
    () => this.sendCommand('stop'),
  );
}

/**
 * 封禁时长字段：**省略即永久**。
 *
 * 实测 26.3：`expires` 传 `forever` 或空串会被服务端拒绝（不是「永久」的另一种写法），
 * 永久只能是「不带这个字段」；带值时要可解析（ISO 8601 可，落盘转成服务端本地时区
 * `yyyy-MM-dd HH:mm:ss Z`）。
 *
 * ⚠️ 到期**不等于**自动解封：实测 `UserBanList.isBanned()` 只做 `contains()`、`BanList`
 * 也不清理过期条目（字节码核对 + 到期 50s 后条目不消失、`/banlist` 仍列出）⇒ 到点必须有
 * 人来移除条目，否则玩家会被永久挡在门外。面板的到期清扫因此不能退役，见
 * `task_scheduler.js` 的 `checkExpiredBans`。
 */
function _expiresField(options) {
  return options.expiresAt ? { expires: new Date(options.expiresAt).toISOString() } : {};
}

/** 加入白名单：MSMP `allowlist/add` ↔ 命令 `whitelist add` */
export function whitelistAdd(name) {
  return this._writeViaPreferredChannel(
    {
      method: 'minecraft:allowlist/add',
      params: [[{ name }]],
      verify: (result) => _resultHasPlayer(result, name),
      unverifiedMessage: `无法把 ${name} 加入白名单：服务端查不到该玩家的档案`,
    },
    () => this.sendCommand(`whitelist add ${name}`),
  );
}

/** 移出白名单：移除类方法不报「本来就不在」，与命令通道一致按成功处理 */
export function whitelistRemove(name) {
  return this._writeViaPreferredChannel(
    { method: 'minecraft:allowlist/remove', params: [[{ name }]] },
    () => this.sendCommand(`whitelist remove ${name}`),
  );
}

/** 设为管理员：`op` 的权限级固定为 4、不绕过人数上限，与命令默认值一致 */
export function opPlayer(name) {
  return this._writeViaPreferredChannel(
    {
      method: 'minecraft:operators/add',
      params: [[{ player: { name }, permissionLevel: 4, bypassesPlayerLimit: false }]],
      verify: (result) => _resultHasPlayer(result, name),
      unverifiedMessage: `无法把 ${name} 设为管理员：服务端查不到该玩家的档案`,
    },
    () => this.sendCommand(`op ${name}`),
  );
}

/** 取消管理员 */
export function deopPlayer(name) {
  return this._writeViaPreferredChannel(
    { method: 'minecraft:operators/remove', params: [[{ name }]] },
    () => this.sendCommand(`deop ${name}`),
  );
}

/** 踢出：结构化返回里没有该玩家 ⇒ 没踢成（他不在线），据此报错而非报成功 */
export function kickPlayer(name, reason) {
  const text = reason || '';
  return this._writeViaPreferredChannel(
    {
      method: 'minecraft:players/kick',
      params: [[{ player: { name }, message: { literal: text } }]],
      verify: (result) => _resultHasPlayer(result, name),
      unverifiedMessage: `${name} 不在线，踢出未生效`,
    },
    () => this.sendCommand(`kick ${name}${text ? ` ${text}` : ''}`),
  );
}

/**
 * 封禁玩家：不带 `expires` ⇒ 原版写永久条目（与 `ban` 命令落盘一致）。
 * 时长型封禁的载体在调用方（临时封禁记录），本方法只负责让条目落盘。
 */
export function banPlayer(name, reason, options = {}) {
  const text = reason || '';
  return this._writeViaPreferredChannel(
    {
      method: 'minecraft:bans/add',
      params: [
        [{ player: { name }, reason: text, source: COMMAND_SOURCE, ..._expiresField(options) }],
      ],
      verify: (result) => _resultHasPlayer(result, name),
      unverifiedMessage: `无法封禁 ${name}：服务端查不到该玩家的档案`,
    },
    () => this.sendCommand(`ban ${name}${text ? ` ${text}` : ''}`),
  );
}

/** 封禁 IP */
export function banIp(ip, reason, options = {}) {
  const text = reason || '';
  return this._writeViaPreferredChannel(
    {
      method: 'minecraft:ip_bans/add',
      params: [[{ ip, reason: text, source: COMMAND_SOURCE, ..._expiresField(options) }]],
      verify: (result) => _resultHasIp(result, ip),
      unverifiedMessage: `无法封禁 IP ${ip}`,
    },
    () => this.sendCommand(`ban-ip ${ip}${text ? ` ${text}` : ''}`),
  );
}

/** 解除玩家封禁 */
export function pardonPlayer(name) {
  return this._writeViaPreferredChannel(
    { method: 'minecraft:bans/remove', params: [[{ name }]] },
    () => this.sendCommand(`pardon ${name}`),
  );
}

/** 解除 IP 封禁 */
export function pardonIp(ip) {
  return this._writeViaPreferredChannel(
    { method: 'minecraft:ip_bans/remove', params: [[ip]] },
    () => this.sendCommand(`pardon-ip ${ip}`),
  );
}

export default {
  MSMP_WRITE_TIMEOUT_MS,
  MSMP_STOP_TIMEOUT_MS,
  SERVER_SETTING_METHODS,
  SERVER_SETTING_KEYS,
  _writeViaPreferredChannel,
  applyServerSetting,
  saveWorld,
  stopServer,
  whitelistAdd,
  whitelistRemove,
  opPlayer,
  deopPlayer,
  kickPlayer,
  banPlayer,
  banIp,
  pardonPlayer,
  pardonIp,
};
