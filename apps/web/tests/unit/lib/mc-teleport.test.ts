/**
 * 传送命令拼装单测
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WORLD_SPAWN,
  buildSetWorldSpawnCommand,
  buildTeleportToCoordsCommand,
  buildTeleportToPlayerCommand,
  quickTeleportsFromPreferences,
  resolveRespawnTarget,
  saveQuickTeleports,
} from '@/lib/mc-teleport'
import { usePanelPreferencesStore } from '@/stores/panel-preferences'

// 面板偏好走服务端：假实现记录每次 PUT 的补丁并返回合并后的快照，
// 与真实路由「整份写入单项、返回完整快照」一致
const preferences = vi.hoisted(() => {
  const state: { remote: Record<string, unknown>; writes: Record<string, unknown>[] } = {
    remote: {},
    writes: [],
  }
  return state
})

vi.mock('@/api/preferences', () => ({
  apiGetPreferences: async () => preferences.remote,
  apiPutPreferences: async (_config: unknown, patch: Record<string, unknown>) => {
    preferences.remote = { ...preferences.remote, ...patch }
    preferences.writes.push(patch)
    return preferences.remote
  },
}))

beforeEach(() => {
  preferences.remote = {}
  preferences.writes = []
  usePanelPreferencesStore.setState({ remote: null, saving: false })
})

describe('传送命令模板（6 入口）', () => {
  it('坐标传送（坐标取整，无前导 /）', () => {
    expect(buildTeleportToCoordsCommand('Steve', { x: 12.6, y: 64.2, z: -8.8 })).toBe(
      'tp Steve 13 64 -9',
    )
  })

  it('世界出生点（固定 chip）', () => {
    expect(buildTeleportToCoordsCommand('Steve', { x: 0, y: 64, z: 0 })).toBe('tp Steve 0 64 0')
  })

  it('主世界原点 0,64,0', () => {
    expect(buildTeleportToCoordsCommand('Steve', DEFAULT_WORLD_SPAWN)).toBe('tp Steve 0 64 0')
  })

  it('自定义快捷点', () => {
    expect(buildTeleportToCoordsCommand('Steve', { x: 100, y: 70, z: -200 })).toBe(
      'tp Steve 100 70 -200',
    )
  })

  it('传送到其他在线玩家', () => {
    expect(buildTeleportToPlayerCommand('Steve', 'Alex')).toBe('tp Steve Alex')
  })

  it('修改世界出生点命令（setworldspawn 二次确认入口）', () => {
    expect(buildSetWorldSpawnCommand({ x: 1.4, y: 65.6, z: 2.5 })).toBe('setworldspawn 1 66 3')
  })
})

describe('个人复活点回退链', () => {
  it('respawnPoint 优先', () => {
    expect(resolveRespawnTarget({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 })).toEqual({
      x: 1,
      y: 2,
      z: 3,
    })
  })
  it('无 respawnPoint 回退 spawnPoint', () => {
    expect(resolveRespawnTarget(null, { x: 4, y: 5, z: 6 })).toEqual({ x: 4, y: 5, z: 6 })
  })
  it('均无回退世界出生点缺省 0,64,0', () => {
    expect(resolveRespawnTarget(null, null)).toEqual(DEFAULT_WORLD_SPAWN)
  })
})

describe('快捷传送点持久化 schema', () => {
  it('未配置（偏好快照为空）→ 默认 schema（不隐藏原点、无自定义点）', () => {
    expect(quickTeleportsFromPreferences(null)).toEqual({ hideOrigin: false, items: [] })
    expect(quickTeleportsFromPreferences({})).toEqual({ hideOrigin: false, items: [] })
  })

  it('保存 → 从偏好快照派生回来一致：整份 PUT', async () => {
    usePanelPreferencesStore.setState({ remote: {}, saving: false })
    const schema = {
      hideOrigin: true,
      items: [{ name: '主城', x: 100, y: 70, z: -200 }],
    }
    await saveQuickTeleports(schema)
    expect(preferences.writes).toEqual([{ quickTeleports: schema }])
    expect(quickTeleportsFromPreferences(usePanelPreferencesStore.getState().remote)).toEqual(
      schema,
    )
  })

  it('偏好尚未拉回时写入被拒：抛出且不发请求', async () => {
    await expect(saveQuickTeleports({ hideOrigin: false, items: [] })).rejects.toThrow()
    expect(preferences.writes).toEqual([])
  })
})
