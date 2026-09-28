/**
 * 设置页组件接口契约
 * 设计纪律：实底卡片（玻璃禁区）+ --mcs-* 语义 token + shadcn 基座；禁硬编码色值
 */

// ── connection-form（设置连接页 + onboarding 复用）──────────────

export interface ConnectionFormProps {
  /** 'settings'：设置页卡片内紧凑布局；'onboarding'：独立页大布局（标题+副标题） */
  variant?: 'settings' | 'onboarding'
  /**
   * 表单标题的元素层级（默认 h1）。设置页里这张表单标题就是该子页主标题；
   * 引导页另有页面级 h1（欢迎区），表单标题必须降为 h2，否则同屏两个 h1。
   * 两档共用同一套类名，仅换标签语义，视觉不变。
   */
  headingAs?: 'h1' | 'h2'
  /** 保存成功回调（settings 页可省略仅 toast；onboarding 用于跳转 /dashboard） */
  onSaved?: () => void
}

// ── backup-panel（备份管理子页）─────────────────────────────────

export interface BackupPanelProps {
  /** 当前实例 id（null 显示无实例空态） */
  instanceId: string | null
}

// ── notifications-panel（通知设置子页）──────────────────────────

export interface NotificationsPanelProps {
  // 无 props：内部读 useNotificationPreferenceStore
}

// ── general-panel（通用设置子页）────────────────────────────────

export interface GeneralPanelProps {
  // 无 props：内部读 server store（instanceId）与 ui store（theme）
}

// ── about-panel（关于子页）──────────────────────────────────────

export interface AboutPanelProps {
  // 无 props：静态内容
}
