/**
 * ActionForms 表单群共享 Props 契约（issue 480 拆分：三表单与 Tab 壳共用）。
 * 自 action-forms.tsx 原样迁入，字段语义见各注释。
 */
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../../mutations'

export interface ActionFormProps {
  /** 单个模式目标玩家；批量模式为 null */
  player: Player | null
  /** 批量目标 */
  batchTargets: Player[]
  isBatchMode: boolean
  instanceId: string
  isRconConnected: boolean
  onAction: (req: PlayerActionRequest) => Promise<void>
}
