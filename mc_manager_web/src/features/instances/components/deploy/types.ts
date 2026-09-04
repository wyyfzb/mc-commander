/**
 * DeployDialog 表单模型（从 deploy-dialog.tsx 行为不变迁移）
 */
import { DEFAULT_MEMORY } from './constants'
import type { ServerType } from '@/lib/mc-deploy'

/** 表单值（初始态与基线） */
export interface DeployForm {
  type: ServerType
  version: string
  loader: string
  name: string
  memory: string
}

export const INITIAL_FORM: DeployForm = {
  type: 'paper',
  version: '',
  loader: '',
  name: '',
  memory: DEFAULT_MEMORY,
}

/** 部署成功后自动启动状态（首启闭环；未勾选 EULA 时为 null 不自动启动） */
export type AutoStartState = 'pending' | 'ok' | 'failed' | null
