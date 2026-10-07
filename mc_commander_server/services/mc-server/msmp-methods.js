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
 * @param {() => Promise<unknown>} runCommand 等价的命令通道
 * @returns {Promise<'msmp' | 'command'>} 实际生效的通道
 */
export async function _writeViaPreferredChannel(structured, runCommand) {
  if (structured) {
    const result = await this._msmpRequest(
      structured.method,
      structured.params,
      MSMP_WRITE_TIMEOUT_MS,
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
  await runCommand();
  return 'command';
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
export function banPlayer(name, reason) {
  const text = reason || '';
  return this._writeViaPreferredChannel(
    {
      method: 'minecraft:bans/add',
      params: [[{ player: { name }, reason: text, source: COMMAND_SOURCE }]],
      verify: (result) => _resultHasPlayer(result, name),
      unverifiedMessage: `无法封禁 ${name}：服务端查不到该玩家的档案`,
    },
    () => this.sendCommand(`ban ${name}${text ? ` ${text}` : ''}`),
  );
}

/** 封禁 IP */
export function banIp(ip, reason) {
  const text = reason || '';
  return this._writeViaPreferredChannel(
    {
      method: 'minecraft:ip_bans/add',
      params: [[{ ip, reason: text, source: COMMAND_SOURCE }]],
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
  _writeViaPreferredChannel,
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
