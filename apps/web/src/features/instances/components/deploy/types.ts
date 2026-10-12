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
  // 默认「原版」而非 Paper：服主的第一诉求通常是「我要一个原版服」，
  // 预选 Paper 会让没注意到的用户装错类型（Paper 行为与原版不同，且要重来）。
  // 想装 Paper 的用户主动点一下即可，代价远小于「装错了才发现」。
  type: 'vanilla',
  version: '',
  loader: '',
  name: '',
  memory: DEFAULT_MEMORY,
}

/** 部署成功后自动启动状态（首启闭环；未勾选 EULA 时为 null 不自动启动） */
export type AutoStartState = 'pending' | 'ok' | 'failed' | null
