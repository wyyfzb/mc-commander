/**
 * DeployDialog 本地 UI 常量（文案与图标非领域数据，不入 lib/mc-deploy）
 * 从 deploy-dialog.tsx 行为不变迁移
 */
import { FileText, Flame, LayoutGrid, Sparkles, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ServerType } from '@/lib/mc-deploy'

/** 服务端类型卡片说明一行 */
export const SERVER_TYPE_DESCRIPTIONS: Record<ServerType, string> = {
  vanilla: '官方原版服务端，纯净体验',
  paper: '高性能优化，插件生态丰富',
  fabric: '轻量模组加载器，启动快',
  forge: '老牌模组加载器，模组量大',
  purpur: 'Paper 分支，玩法增强',
}

/** 服务端类型图标 */
export const SERVER_TYPE_ICONS: Record<ServerType, LucideIcon> = {
  vanilla: LayoutGrid,
  paper: FileText,
  fabric: Wrench,
  forge: Flame,
  purpur: Sparkles,
}

/** 内存档位（1G/2G/4G/8G；默认 2G） */
export const MEMORY_OPTIONS = ['1G', '2G', '4G', '8G'] as const
export const DEFAULT_MEMORY = '2G'

/** 三步 Stepper 标签 */
export const STEP_LABELS = ['选择服务端', '实例配置', '确认部署'] as const
