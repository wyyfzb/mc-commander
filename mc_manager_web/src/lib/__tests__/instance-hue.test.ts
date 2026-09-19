/**
 * instance-hue（实例固定色相标识）契约：
 * - 稳定性：同一 id 恒得同一槽（哈希里无随机源、无时间源），且槽位值被钉死——
 *   换哈希实现会让既有实例的标识色整体漂移，必须由本用例拦下
 * - 值域与全覆盖：任意 id（含空串/Unicode）返回 1..6 且类名只出自 identity 六槽
 * - 分布：真实实例名形态是「同前缀 + 序号」（s1/s2/server-1），这类 id 对弱哈希最敏感，
 *   故按形态家族做均匀性断言（裸 FNV-1a 高位在这类家族上卡方远超临界值）
 */
import { describe, expect, it } from 'vitest'
import {
  INSTANCE_HUE_SLOTS,
  instanceHueFillClass,
  instanceHueSlot,
  type InstanceHueSlot,
} from '../instance-hue'

/** 槽位 → 类名字面量清单（与 token 注册一一对应；本清单即「唯一映射源」的断言） */
const EXPECTED_FILL_CLASSES: Record<InstanceHueSlot, string> = {
  1: 'bg-mcs-identity-1',
  2: 'bg-mcs-identity-2',
  3: 'bg-mcs-identity-3',
  4: 'bg-mcs-identity-4',
  5: 'bg-mcs-identity-5',
  6: 'bg-mcs-identity-6',
}

describe('instanceHueSlot · 稳定性与值域', () => {
  it('槽位数与 token 注册数一致（6）', () => {
    expect(INSTANCE_HUE_SLOTS).toBe(6)
  })

  it('同一 id 重复调用恒得同一槽（无随机源/时间源）', () => {
    for (const id of ['default', 'survival', 'server-1', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d']) {
      const first = instanceHueSlot(id)
      const all = Array.from({ length: 200 }, () => instanceHueSlot(id))
      expect(new Set(all)).toEqual(new Set([first]))
    }
  })

  it('槽位值钉死（换哈希实现即红）', () => {
    // 值本身无语义，唯一作用是防止哈希被无意改动导致全站标识色漂移
    expect(
      ['default', 'survival', 'creative', 's1', 's2', 'server-1', 'test-server'].map(
        instanceHueSlot,
      ),
    ).toEqual([6, 2, 6, 3, 3, 4, 4])
  })

  it('任意 id（空串 / 空白 / 中文 / 代理对 / NUL）都返回合法槽位', () => {
    for (const id of ['', ' ', '0', '一', '服务器一', '🙂', '\u0000', 'a'.repeat(200)]) {
      const slot = instanceHueSlot(id)
      expect(Number.isInteger(slot)).toBe(true)
      expect(slot).toBeGreaterThanOrEqual(1)
      expect(slot).toBeLessThanOrEqual(6)
    }
  })
})

describe('instanceHueFillClass · 唯一映射源', () => {
  it('每个槽位对应的类名与 token 注册一一对应（无拼写/序号漂移）', () => {
    const pool = Array.from({ length: 100 }, (_, i) => `inst-${i}`)
    for (const slot of [1, 2, 3, 4, 5, 6] as const) {
      // 用 id 反查：先找落该槽的 id，再断言类名（同一映射源，不重写第二份映射）
      const id = pool.find((candidate) => instanceHueSlot(candidate) === slot)
      expect(id).toBeDefined()
      expect(instanceHueFillClass(id!)).toBe(EXPECTED_FILL_CLASSES[slot])
    }
  })

  it('6 槽全部可达（不存在永不出现的档位）', () => {
    const seen = new Set(Array.from({ length: 300 }, (_, i) => instanceHueSlot(`inst-${i}`)))
    expect(seen.size).toBe(6)
  })
})

describe('instanceHueSlot · 分布均匀性（真实 id 形态家族）', () => {
  const N = 6000
  const families: Record<string, string[]> = {
    's{i}': Array.from({ length: N }, (_, i) => `s${i}`),
    'server-{i}': Array.from({ length: N }, (_, i) => `server-${i}`),
    'inst-{i}': Array.from({ length: N }, (_, i) => `inst-${i}`),
  }

  for (const [name, ids] of Object.entries(families)) {
    it(`${name} 6000 个 id：各槽计数落在理想值 ±10% 内`, () => {
      const counts = new Array<number>(INSTANCE_HUE_SLOTS).fill(0)
      for (const id of ids) {
        const index = instanceHueSlot(id) - 1
        counts[index] = (counts[index] ?? 0) + 1
      }
      const ideal = ids.length / INSTANCE_HUE_SLOTS
      for (const count of counts) {
        expect(count).toBeGreaterThanOrEqual(ideal * 0.9)
        expect(count).toBeLessThanOrEqual(ideal * 1.1)
      }
      expect(counts.reduce((a, b) => a + b, 0)).toBe(ids.length)
    })
  }
})
