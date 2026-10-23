import { z } from 'zod'

/**
 * 面板级偏好（跨设备一致的那部分用户数据）。
 *
 * 分界判据是「换一台设备后，用户还该看到同一份吗」：
 * - 命令预设、公告预设、礼包、快捷传送点、通知开关 —— 是，属面板配置
 * - 主题、侧栏折叠、当前选中实例 —— 否，属这台设备的显示习惯
 * - 会话令牌、面板地址 —— 否，属这台设备的凭据（同步等于扩大泄漏面）
 *
 * 一张键值表而非每类一张：这些数据只有「整份读、整份写」一种访问方式，
 * 没有关联查询与按实例过滤的需求；新增一类预设不必再动表结构。
 */

/** 单项尺寸上限（字符数）：一条预设不该比一条命令更长 */
const NAME_MAX = 40
const TEXT_MAX = 512
/** 列表条目上限：预设是手写短列表，超出这个量级说明存错了东西 */
const LIST_MAX = 100

/** 命令快捷指令：原样存储的完整命令行（不带前导 /） */
export const commandPresetsSchema = z.array(z.string().min(1).max(TEXT_MAX)).max(LIST_MAX)

/** 公告预设：胶囊显示名称 + 完整文案 */
export const announcementPresetSchema = z.object({
  name: z.string().min(1).max(NAME_MAX),
  content: z.string().min(1).max(TEXT_MAX),
})
export const announcementPresetsSchema = z.array(announcementPresetSchema).max(LIST_MAX)

/** 礼包中的一件物品（id 不带命名空间前缀） */
export const kitItemSchema = z.object({
  id: z.string().min(1).max(128),
  count: z.number().int().min(1).max(6400),
})

/** 预设礼包 */
export const kitPresetSchema = z.object({
  name: z.string().min(1).max(NAME_MAX),
  icon: z.string().max(16),
  desc: z.string().max(TEXT_MAX),
  items: z.array(kitItemSchema).max(128),
})
export const kitsSchema = z.array(kitPresetSchema).max(LIST_MAX)

/** 自定义快捷传送点 */
export const quickTeleportPointSchema = z.object({
  name: z.string().min(1).max(NAME_MAX),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
})
export const quickTeleportsSchema = z.object({
  hideOrigin: z.boolean(),
  items: z.array(quickTeleportPointSchema).max(LIST_MAX),
})

/**
 * 通知开关：只存非默认值（关掉的类型），与读取侧「缺省为开」配套。
 * 键是通知类型名，故不在此枚举——类型的唯一声明源在前端通知逻辑里，
 * 这里复制一份枚举就会在新增类型时漂移成「新类型关不掉」。
 */
export const notificationPreferencesSchema = z.record(
  z.string().max(64),
  z.object({ toast: z.boolean() }),
)

/** 偏好的完整快照：任一项缺失表示该项从未被写过 */
export const panelPreferencesSchema = z.object({
  commandPresets: commandPresetsSchema.optional(),
  announcementPresets: announcementPresetsSchema.optional(),
  kits: kitsSchema.optional(),
  quickTeleports: quickTeleportsSchema.optional(),
  notificationPreferences: notificationPreferencesSchema.optional(),
})

/** 写入载荷：与快照同形，出现哪项就整份替换哪项 */
export const panelPreferencesPatchSchema = panelPreferencesSchema

export type AnnouncementPreset = z.infer<typeof announcementPresetSchema>
export type KitItem = z.infer<typeof kitItemSchema>
export type KitPreset = z.infer<typeof kitPresetSchema>
export type QuickTeleportPoint = z.infer<typeof quickTeleportPointSchema>
export type QuickTeleports = z.infer<typeof quickTeleportsSchema>
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>
export type PanelPreferences = z.infer<typeof panelPreferencesSchema>
export type PanelPreferencesPatch = z.infer<typeof panelPreferencesPatchSchema>

/** 偏好项键名清单（服务端据此校验可写键，避免任意键塞进库） */
export const PANEL_PREFERENCE_KEYS = [
  'commandPresets',
  'announcementPresets',
  'kits',
  'quickTeleports',
  'notificationPreferences',
] as const

export type PanelPreferenceKey = (typeof PANEL_PREFERENCE_KEYS)[number]
