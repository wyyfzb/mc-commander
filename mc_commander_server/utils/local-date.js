// 「服务器本地那一天」的日期键（YYYY-MM-DD）单一实现。
//
// 用 toISOString() 取值是 UTC 口径：UTC+8 的 00:00–08:00 会拿到昨天的日期，
// 而面向服主的一切时间展示都按本地时区渲染（前端 formatFullDateMinute）——
// 备份默认命名写「Backup_昨日」而列表显示「今日」就是这条口径分裂的症状。
// 凡语义是「本地的那一天」（备份命名、今日新增统计缓存）都走本函数。
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 用户可见的备份名里的时刻部分（本地时区，`YYYY-MM-DDTHH-mm-ss-SSS`，无 Z 后缀——
// 带 Z 会被读成 UTC）。内部快照目录名仍用 UTC ISO：那是路径唯一性/排序用的，
// 不面向用户，两套口径不要混。
export function localTimestamp(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${localDateKey(date)}T${hh}-${mm}-${ss}-${ms}`;
}
