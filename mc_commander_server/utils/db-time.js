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
 */
export function toIsoUtc(value) {
  if (!value) return null;
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
