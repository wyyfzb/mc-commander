/**
 * 原版封禁条目的到期时间口径（`banned-players.json` / `banned-ips.json` 的 `expires`）。
 *
 * 该字段是**字符串**，两种形态：
 * - 永久：哨兵 `forever`，也可能整个键缺失（不同工具/手工编辑的产物都见过）
 * - 临时：MC 自己的 `yyyy-MM-dd HH:mm:ss Z`，例 `2026-10-08 06:00:00 +0000`
 *
 * 实测（26.3，MSMP `bans/add`）：**写入侧只接受可解析的日期串**——传 `forever` 或空串会被
 * 判为非法参数（`Text '' could not be parsed at index 0`），故文件里的 `forever` 只可能来自
 * 命令路径或手工编辑；MSMP 写入的是 ISO 串，解析要兼容它。
 *
 * 判定分三类：**缺失 / 空串 / 哨兵 = 永久**（MC 自己在 `expires` 为空时写哨兵，空串视同缺失）；
 * **可解析 = 临时**；**有值但解析不出 = 非永久且到期时间未知**——不假装成永久，否则一条本该
 * 到期的封禁会永久留在记录里，而用户无从发现。
 */

/** 永久封禁的哨兵值 */
const FOREVER = 'forever';

/**
 * DB 里表示「永久」的到期值：与既有口径一致——`findExpiredActive` 用 `<= now` 比较，
 * `Number.MAX_SAFE_INTEGER`（约 285,000 年）永不匹配。
 */
export const PERMANENT_EXPIRES = Number.MAX_SAFE_INTEGER;

/** MC 的封禁日期格式，逐段捕获（时区单独取，便于转 ISO） */
const MC_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4}|Z)$/;

/**
 * 解析封禁条目的 `expires`。
 * @param {unknown} expires - 文件里的原始值（可能缺失、为 null 或非字符串）
 * @returns {{isPermanent: boolean, expiresAt: number | null}} `expiresAt` 为 epoch 毫秒
 */
export function parseBanExpires(expires) {
  if (expires === null || expires === undefined) return { isPermanent: true, expiresAt: null };
  const text = String(expires).trim();
  if (!text || text.toLowerCase() === FOREVER) return { isPermanent: true, expiresAt: null };

  const match = MC_DATE_RE.exec(text);
  if (match) {
    const [, y, mo, d, h, mi, s, tz] = match;
    const zone = tz === 'Z' ? 'Z' : `${tz.slice(0, 3)}:${tz.slice(3)}`;
    const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
    if (Number.isFinite(ms)) return { isPermanent: false, expiresAt: ms };
  }

  // ISO 兜底：MSMP 的写入侧用的就是它
  const ms = Date.parse(text);
  if (Number.isFinite(ms)) return { isPermanent: false, expiresAt: ms };

  return { isPermanent: false, expiresAt: null };
}

/**
 * 条目是否**已过到期时间**（「还在文件里却过了点」＝到期；解封是直接删条目）。
 *
 * 解析不出到期时间的（`expiresAt === null`）一律不算过期：那可能是别的工具写的新格式，
 * 宁可不动它，也不擅自替用户解封。
 */
export function isBanExpired(expires, now = Date.now()) {
  const { isPermanent, expiresAt } = parseBanExpires(expires);
  return !isPermanent && expiresAt !== null && expiresAt <= now;
}

export default { parseBanExpires, isBanExpired, PERMANENT_EXPIRES };
