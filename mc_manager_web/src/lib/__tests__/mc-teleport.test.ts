/**
 * 传送命令拼装单测
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORLD_SPAWN,
  buildSetWorldSpawnCommand,
  buildTeleportToCoordsCommand,
  buildTeleportToPlayerCommand,
  loadQuickTeleports,
  resolveRespawnTarget,
  saveQuickTeleports,
} from '../mc-teleport'

describe('传送命令模板（6 入口）', () => {
  it('坐标传送（坐标取整，无前导 /）', () => {
    expect(buildTeleportToCoordsCommand('Steve', { x: 12.6, y: 64.2, z: -8.8 })).toBe('tp Steve 13 64 -9')
  })

  it('世界出生点（固定 chip）', () => {
    expect(buildTeleportToCoordsCommand('Steve', { x: 0, y: 64, z: 0 })).toBe('tp Steve 0 64 0')
  })

  it('主世界原点 0,64,0', () => {
    expect(buildTeleportToCoordsCommand('Steve', DEFAULT_WORLD_SPAWN)).toBe('tp Steve 0 64 0')
  })

  it('自定义快捷点', () => {
    expect(buildTeleportToCoordsCommand('Steve', { x: 100, y: 70, z: -200 })).toBe('tp Steve 100 70 -200')
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
    expect(resolveRespawnTarget({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 })).toEqual({ x: 1, y: 2, z: 3 })
  })
  it('无 respawnPoint 回退 spawnPoint', () => {
    expect(resolveRespawnTarget(null, { x: 4, y: 5, z: 6 })).toEqual({ x: 4, y: 5, z: 6 })
  })
  it('均无回退世界出生点缺省 0,64,0', () => {
    expect(resolveRespawnTarget(null, null)).toEqual(DEFAULT_WORLD_SPAWN)
  })
})

describe('快捷传送点持久化 schema', () => {
  it('空存储 → 默认 schema（不隐藏原点、无自定义点）', () => {
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null } as Storage
    expect(loadQuickTeleports(storage)).toEqual({ hideOrigin: false, items: [] })
  })

  it('保存 → 读取往返一致', () => {
    const mem = new Map<string, string>()
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    } as Storage
    const schema = {
      hideOrigin: true,
      items: [{ name: '主城', x: 100, y: 70, z: -200 }],
    }
    saveQuickTeleports(storage, schema)
    expect(loadQuickTeleports(storage)).toEqual(schema)
  })

  it('损坏数据回退默认 schema；非法条目丢弃', () => {
    const storage = {
      getItem: () => '{bad json',
    } as unknown as Storage
    expect(loadQuickTeleports(storage)).toEqual({ hideOrigin: false, items: [] })

    const storage2 = {
      getItem: () => JSON.stringify({ hideOrigin: true, items: [{ name: 'ok', x: 1, y: 2, z: 3 }, { name: 'bad', x: 'a' }] }),
    } as unknown as Storage
    const loaded = loadQuickTeleports(storage2)
    expect(loaded.hideOrigin).toBe(true)
    expect(loaded.items).toEqual([{ name: 'ok', x: 1, y: 2, z: 3 }])
  })
})
