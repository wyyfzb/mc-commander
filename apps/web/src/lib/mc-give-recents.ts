/**
 * 最近发放的物品（本机习惯，localStorage）
 *
 * 与礼包的分界：礼包是**跨设备共享的面板配置**（写服务端偏好），「最近给过什么」
 * 是这台机器上的操作习惯（同主题、同终端滚动偏好），只存本机。不存面板偏好还有一个
 * 实际理由：最近列表每次发放都变，写服务端会把偏好写入变成高频请求。
 */
const STORAGE_KEY = 'mcs-give-recent-items'
/** 保留条数：一两屏内能扫完，再多就不叫「最近」了 */
const MAX_RECENT = 6

/** 读取最近发放的物品 id（损坏数据按空列表处理） */
export function readRecentItemIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string').slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

/** 记一次发放（去重、最近在前）；存储不可用时静默——这只是便利功能 */
export function pushRecentItemId(id: string, current: string[]): string[] {
  const next = [id, ...current.filter((x) => x !== id)].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式/配额满：最近列表退回会话内
  }
  return next
}
