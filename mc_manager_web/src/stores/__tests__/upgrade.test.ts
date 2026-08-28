/**
 * upgrade store 测试（P0-4）：
 * - applyUpgradeProgress 按实例累积（多实例互不覆盖）
 * - clearUpgradeProgress 只清指定实例
 * - getUpgradeProgress 缺失返回 null
 * - UPGRADE_STAGE_LABELS 覆盖全部 7 个阶段（中文标签）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyUpgradeProgress,
  clearUpgradeProgress,
  getUpgradeProgress,
  UPGRADE_STAGE_LABELS,
  useUpgradeStore,
} from '../upgrade'
import type { UpgradeStage } from '@/api/types'

beforeEach(() => {
  useUpgradeStore.setState({ progress: {} })
})

describe('upgrade store', () => {
  it('applyUpgradeProgress 按实例累积，多实例互不覆盖', () => {
    applyUpgradeProgress({ instanceId: 'a', stage: 'backup', percent: 0, detail: '', timestamp: 1 })
    applyUpgradeProgress({ instanceId: 'b', stage: 'download', percent: 30, detail: '', timestamp: 2 })
    applyUpgradeProgress({ instanceId: 'a', stage: 'download', percent: 50, detail: '', timestamp: 3 })

    expect(Object.keys(useUpgradeStore.getState().progress).sort()).toEqual(['a', 'b'])
    expect(getUpgradeProgress('a')).toMatchObject({ stage: 'download', percent: 50 })
    expect(getUpgradeProgress('b')).toMatchObject({ stage: 'download', percent: 30 })
  })

  it('clearUpgradeProgress 只清指定实例', () => {
    applyUpgradeProgress({ instanceId: 'a', stage: 'completed', percent: 100, detail: '', timestamp: 1 })
    applyUpgradeProgress({ instanceId: 'b', stage: 'failed', percent: 0, detail: '', timestamp: 2 })

    clearUpgradeProgress('a')
    expect(getUpgradeProgress('a')).toBeNull()
    expect(getUpgradeProgress('b')).not.toBeNull()
  })

  it('getUpgradeProgress 对未知实例返回 null', () => {
    expect(getUpgradeProgress('ghost')).toBeNull()
  })

  it('UPGRADE_STAGE_LABELS 覆盖全部 7 个阶段', () => {
    const stages: UpgradeStage[] = [
      'backup', 'download', 'replace', 'verify', 'completed', 'failed', 'rolled_back',
    ]
    expect(Object.keys(UPGRADE_STAGE_LABELS).sort()).toEqual([...stages].sort())
    expect(UPGRADE_STAGE_LABELS.backup).toBe('备份中')
    expect(UPGRADE_STAGE_LABELS.completed).toBe('升级完成')
    expect(UPGRADE_STAGE_LABELS.rolled_back).toBe('已回滚')
  })
})
