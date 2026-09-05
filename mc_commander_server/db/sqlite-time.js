/**
 * SQLite 时间戳工具 —— prune cutoff 与 CURRENT_TIMESTAMP 列格式字节级同构的唯一来源（issue 541）。
 *
 * SQLite 的 CURRENT_TIMESTAMP / datetime() 产出 "YYYY-MM-DD HH:MM:SS"（UTC、空格分隔、无时区后缀），
 * 而 JS 的 toISOString() 产出 "YYYY-MM-DDTHH:MM:SS.sssZ"。两种格式直接进 SQL 字符串字典序比较时，
 * 同日期前缀下 ' '(0x20) < 'T'(0x54) 恒成立，cutoff 当日全天记录会被误判为「早于 cutoff」删除，
 * 保留窗口实际缩水 N-1 天。任何与 TEXT 时间戳列做比较的时间参数必须经此处转换，
 * 禁止直接使用 toISOString()。
 */

/** 毫秒时间戳 → 与 CURRENT_TIMESTAMP 同构的字符串（"YYYY-MM-DD HH:MM:SS"，UTC） */
export function sqliteTimestamp(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 保留清理 cutoff：now 往前推 olderThanDays 天，格式与 CURRENT_TIMESTAMP 字节级同构 */
export function sqliteCutoff(olderThanDays) {
  return sqliteTimestamp(Date.now() - olderThanDays * 86_400_000);
}
