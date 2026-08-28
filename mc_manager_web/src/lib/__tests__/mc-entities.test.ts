/**
 * mc-entities.ts 单元测试
 */
import { describe, it, expect } from 'vitest'
import { getEntitiesByCategory, searchEntities, MINECRAFT_ENTITIES } from '@/lib/mc-entities'

describe('MINECRAFT_ENTITIES', () => {
  it('包含常用实体且无重复 ID', () => {
    const ids = MINECRAFT_ENTITIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个实体都有分类', () => {
    for (const e of MINECRAFT_ENTITIES) {
      expect(e.category).toBeTruthy()
      expect(e.name).toBeTruthy()
    }
  })
})

describe('getEntitiesByCategory', () => {
  it('按分类分组', () => {
    const map = getEntitiesByCategory()
    expect(map.get('敌对生物')!.length).toBeGreaterThan(5)
    expect(map.get('被动生物')!.length).toBeGreaterThan(5)
  })

  it('每个实体只出现在一个分类中', () => {
    const map = getEntitiesByCategory()
    const total = Array.from(map.values()).reduce((sum, arr) => sum + arr.length, 0)
    expect(total).toBe(MINECRAFT_ENTITIES.length)
  })
})

describe('searchEntities', () => {
  it('空搜索返回全部', () => {
    expect(searchEntities('')).toHaveLength(MINECRAFT_ENTITIES.length)
  })

  it('按 ID 搜索', () => {
    const results = searchEntities('zombie')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((e) => e.id === 'zombie')).toBe(true)
  })

  it('按中文名搜索', () => {
    const results = searchEntities('僵尸')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((e) => e.name.includes('僵尸'))).toBe(true)
  })

  it('大小写不敏感 ID 搜索', () => {
    const results = searchEntities('ZOMBIE')
    expect(results.length).toBeGreaterThan(0)
  })

  it('无匹配返回空', () => {
    expect(searchEntities('zzzzz_nonexistent')).toHaveLength(0)
  })
})