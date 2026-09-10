// SQLite 时间归一化（全仓公共单一实现）。
//
// SQLite 的 CURRENT_TIMESTAMP 写入的是 UTC，但格式为 'YYYY-MM-DD HH:MM:SS'
// ——无 T 分隔、无时区标记。ECMAScript 把这类字符串按**本地时区**解释，
// 于是 Date.parse 的结果在 UTC+8 下比真实时刻早 8 小时。跨时区比较
// （如备份陈旧判定）会因此误判，前端展示也会整体偏移。
//
// 凡从 DB 取出时间字符串参与比较或下发，一律经本模块归一化。

/** SQLite CURRENT_TIMESTAMP 的无时区格式（允许毫秒与 T 分隔） */
const NAIVE_UTC_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * 将 SQLite 的无时区 UTC 字符串补 Z 转为 ISO8601（带时区标记）。
 * 空值返回 null；已带时区标记或非该格式的输入原样返回，避免二次破坏。
 * 数值按 **epoch 毫秒** 处理（与 toDbUtcString 的数值语义一致；`0` 因空值早退
 * 返回 null 属既有口径）：否则 String(v) 过不了 naive 正则会被原样返回，下游
 * Date.parse 得 NaN → parseDbTime 当成「极旧」。越界数值（|v| > 8.64e15）同样
 * 返回 null——Date 构造会抛 RangeError，不能让它漏成异常。
 */
export function toIsoUtc(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(value).trim();
  return NAIVE_UTC_RE.test(s) ? new Date(s.replace(' ', 'T') + 'Z').toISOString() : s;
}

/**
 * 时区安全的 Date.parse：把 DB 时间字符串解析为 epoch 毫秒。
 * 无法解析时返回 0（调用方按「极旧」处理），与 `Date.parse(x) || 0` 语义等价。
 */
export function parseDbTime(value) {
  return Date.parse(toIsoUtc(value)) || 0;
}

/**
 * Date / epoch → SQLite CURRENT_TIMESTAMP 口径的无时区 UTC 串（'YYYY-MM-DD HH:MM:SS'）。
 *
 * 专供与 created_at 这类 **naive 列做字符串比较** 的场合（保留策略 cutoff、区间过滤）。
 * 直接用 `toISOString()` 当 cutoff 会在**同一天**上判错：比较到第 11 位时
 * `' '`(0x20) < `'T'`(0x54) 恒成立，于是 cutoff 当日的记录整日被判为「更旧」
 * 而被多删（最多约一天）。日期部分相同则时间部分才参与比较，才是真实时间序。
 * 无法解析返回 null（调用方应显式处理，勿把 null 当 cutoff 使用）。
 */
export function toDbUtcString(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}
