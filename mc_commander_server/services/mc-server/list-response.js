/**
 * RCON `list` 返回解析（在线名单的权威来源）。
 *
 * 形如 `There are 1 of a max of 20 players online: Steve, Alex`；空名单是
 * `... online: `（冒号后一个空格）。逐字样本见 __tests__/list-response.test.js 的夹具。
 *
 * 本解析器的产出是**成员名单**，不是名字合法性校验——故只做结构性拒绝：认不出句子
 * 形态（没有 `online:`）才返回 null，让调用方「保持现状」。单个 token 看着不像名字
 * 就跳过它，不作废整份名单：多人在线时只要有一名模组/跨端/插件名不合 Java 规范
 * （中文名、带空格、超 16 字符），作废整份会让对账**永久静默停摆**，界面症状与不修
 * 一模一样。反向风险很小——漏掉的名字下一轮对账会补回来。
 */

/** 名字 token 长度上限：Java 正版限 16，模组/跨端可超，取 64 兜住真实名又挡掉整段散文 */
const MAX_NAME_LENGTH = 64;

/** 名单是单行输出：出现控制字符（含换行）说明这一行被截断或串了别的输出 */
function hasControlChars(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * @param {unknown} raw RCON 原始返回
 * @returns {{ names: string[] } | null} 认不出形态返回 null
 */
export function parseListResponse(raw) {
  if (typeof raw !== 'string') return null;
  // 取第一个 `online:`：已知形态的前缀里它只出现一次，名字列表在它之后——取最后一个
  // 会在某个名字含该子串时把前半段名单截掉
  const marker = raw.indexOf('online:');
  if (marker < 0) return null;
  const tail = raw.slice(marker + 'online:'.length).trim();
  if (!tail) return { names: [] };
  const names = [];
  for (const entry of tail.split(',')) {
    const name = entry.trim();
    // 空 token（尾随逗号/连续逗号）不是名字
    if (!name) continue;
    if (name.length > MAX_NAME_LENGTH || hasControlChars(name)) continue;
    names.push(name);
  }
  // 认出了句子形态却一个名字都没认出来 ⇒ 名字列表的形态变了，不能当成「没有人在线」
  if (names.length === 0) return null;
  return { names };
}
