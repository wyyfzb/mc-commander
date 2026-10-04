/**
 * RCON `list` 返回解析（在线名单的权威来源）。
 *
 * 形如 `There are 1 of a max of 20 players online: Steve, Alex`；空名单是
 * `... online: `（冒号后一个空格）。四种形态取自实机逐字样本，见
 * `.ai/References/2026-10-04-实机取模样本.md`。
 *
 * 解析失败返回 null 而非空名单：调用方据此「保持现状」。把不认识的措辞
 * 当成「没有人在线」会让名单被清空，而显示 0 人在线正是要修的症状。
 */

/** MC 玩家名规范：1-16 位字母数字下划线 */
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

/**
 * @param {unknown} raw RCON 原始返回
 * @returns {{ names: string[] } | null} 解析失败返回 null
 */
export function parseListResponse(raw) {
  if (typeof raw !== 'string') return null;
  // 取最后一个 'online:'：服务器措辞可能以 "N of a max of M players online:" 收尾，
  // 名字列表只可能在它之后
  const marker = raw.lastIndexOf('online:');
  if (marker < 0) return null;
  const tail = raw.slice(marker + 'online:'.length).trim();
  if (!tail) return { names: [] };
  const names = [];
  for (const entry of tail.split(',')) {
    const name = entry.trim();
    // 只接受合法玩家名：整段措辞变了就返回 null（部分认识等于误判）
    if (!PLAYER_NAME_RE.test(name)) return null;
    names.push(name);
  }
  return { names };
}
