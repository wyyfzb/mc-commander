/**
 * useUiStore 旧版分散 localStorage key → zustand persist 统一 key 的迁移
 * 模块加载时一次性执行；迁移后旧 key 保留不删（无害）。
 */

export const STORAGE_KEY = 'mcs-ui-preferences'

const OLD_KEYS: Record<string, string> = {
  theme: 'mcs-theme',
  terminalAutoScroll: 'mcs-terminal-autoscroll',
  confirmCommands: 'mcs-confirm-commands',
}

/**
 * 读取旧版分散 localStorage key，合并为 persist 格式。
 * 仅当新 key 不存在且有旧数据时返回合并结果；否则返回 null。
 */
export function migrateFromLegacyKeys(): Record<string, unknown> | null {
  try {
    if (localStorage.getItem(STORAGE_KEY) !== null) return null
    const migrated: Record<string, unknown> = {}
    for (const [field, oldKey] of Object.entries(OLD_KEYS)) {
      const val = localStorage.getItem(oldKey)
      if (val === null) continue
      if (field === 'theme') {
        if (val === 'dark' || val === 'light') migrated.theme = val
      } else {
        // 布尔字段：仅迁移合法值（'true'/'false'），跳过损坏数据
        if (val === 'true' || val === 'false') migrated[field] = val === 'true'
      }
    }
    return Object.keys(migrated).length > 0 ? migrated : null
  } catch {
    return null
  }
}
