/**
 * 设置页组件接口契约
 * 设计纪律：实底卡片（玻璃禁区）+ --mcs-* 语义 token + shadcn 基座；禁硬编码色值
 */

export interface ConnectionFormProps {
  /** 'settings'：设置页卡片内紧凑布局；'onboarding'：独立页大布局（标题+副标题） */
  variant?: 'settings' | 'onboarding'
  /** 表单标题层级（默认 h1）：引导页另有页面级 h1，表单须降为 h2，否则同屏两个 h1 */
  headingAs?: 'h1' | 'h2'
  /** 保存成功回调（settings 页可省略仅 toast；onboarding 用于跳转 /dashboard） */
  onSaved?: () => void
}

export interface BackupPanelProps {
  /** 当前实例 id（null 显示无实例空态） */
  instanceId: string | null
}

export interface NotificationsPanelProps {
  // 无 props：内部读 useNotificationPreferenceStore
}

export interface GeneralPanelProps {
  // 无 props：内部读 server store（instanceId）与 ui store（theme）
}

export interface AboutPanelProps {
  // 无 props：静态内容
}

// 数据项形状归 API 层声明，这里只转发：另写一份会与响应契约各自漂移
export type { PanelDataItem } from '@/api/panel'
