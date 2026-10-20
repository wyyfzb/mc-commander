/**
 * 实例内存账本：决定「还能分多少」的口径必须钉死，否则面板会给出装不下的档位。
 */
import { describe, it, expect } from 'vitest'
import {
  allocatableMemoryGB,
  floorToHalfGB,
  formatMemoryForJvm,
  hasRoomForInstance,
  MEMORY_TIERS_GB,
  memoryBudget,
  parseMemoryGB,
  recommendNewInstanceGB,
  remainingMemoryHint,
  selectableTiersGB,
  sumAllocatedGB,
  systemReserveGB,
} from '@/lib/instance-memory'

describe('instance-memory', () => {
  it('parseMemoryGB：G/M 字符串与旧库的 MB 数值都归一为 GB', () => {
    expect(parseMemoryGB('4G')).toBe(4)
    expect(parseMemoryGB('2048M')).toBe(2)
    expect(parseMemoryGB('1.5G')).toBe(1.5)
    // 旧库与 mock 都按 MB 存数值
    expect(parseMemoryGB(4096)).toBe(4)
  })

  it('parseMemoryGB：空/非法/非正数一律 null（不计入已分配，也不让内存凭空消失）', () => {
    expect(parseMemoryGB(null)).toBeNull()
    expect(parseMemoryGB(undefined)).toBeNull()
    expect(parseMemoryGB('')).toBeNull()
    expect(parseMemoryGB(0)).toBeNull()
    expect(parseMemoryGB('4GB')).toBeNull()
  })

  it('formatMemoryForJvm：整数用 G，非整数转 M（-Xmx 不吃小数 G 后缀）', () => {
    expect(formatMemoryForJvm(2)).toBe('2G')
    expect(formatMemoryForJvm(1.5)).toBe('1536M')
    expect(formatMemoryForJvm(2.5)).toBe('2560M')
  })

  it('floorToHalfGB：向下取半档，不留 6.3 这种选不中的值', () => {
    expect(floorToHalfGB(6.3)).toBe(6)
    expect(floorToHalfGB(6.4)).toBe(6)
    expect(floorToHalfGB(6.5)).toBe(6.5)
  })

  it('系统保留：取 15%，且不低于 1 GB', () => {
    expect(systemReserveGB(16)).toBe(2)
    expect(systemReserveGB(7.4)).toBe(1)
    // 2 GB 的机器按 15% 只有 0.3 GB，低于下限 ⇒ 抬到 1 GB
    expect(systemReserveGB(2)).toBe(1)
  })

  it('可分配总量 = 总内存 − 系统保留', () => {
    expect(allocatableMemoryGB(16)).toBe(14)
    expect(allocatableMemoryGB(7.4)).toBe(6)
    expect(allocatableMemoryGB(0)).toBe(0)
  })

  it('sumAllocatedGB：无法解析的条目按 0 计', () => {
    expect(sumAllocatedGB(['4G', 2048, null, 'bad'])).toBe(6)
  })

  it('memoryBudget：扣掉其他实例的 -Xmx（不按运行状态打折）', () => {
    const budget = memoryBudget(16, ['4G', '2G'])
    expect(budget).toEqual({
      totalGB: 16,
      reserveGB: 2,
      othersGB: 6,
      otherCount: 2,
      allocatableGB: 14,
      availableGB: 8,
    })
  })

  it('memoryBudget：超卖时不返回负数（两个 4G 实例已占满 7.4 GB 的机器）', () => {
    expect(memoryBudget(7.4, ['4G', '4G']).availableGB).toBe(0)
  })

  it('selectableTiersGB：只留装得下的档，一个都装不下仍留最低档', () => {
    expect(selectableTiersGB(14)).toEqual([1, 2, 4, 8])
    // 大内存机器要能一次选到位（否则只能先建 8G 再进设置里拖）
    expect(selectableTiersGB(60)).toEqual([1, 2, 4, 8, 16, 32])
    expect(selectableTiersGB(64)).toEqual([...MEMORY_TIERS_GB])
    expect(selectableTiersGB(3)).toEqual([1, 2])
    expect(selectableTiersGB(0)).toEqual([1])
  })

  it('hasRoomForInstance：余量低于最低档即为装不下', () => {
    expect(hasRoomForInstance(1)).toBe(true)
    expect(hasRoomForInstance(0.5)).toBe(false)
  })

  it('remainingMemoryHint：报余量而不是「还能开几个」，分完时给出处置动作', () => {
    expect(remainingMemoryHint(memoryBudget(16, ['4G']))).toBe('还能分给新实例 10.0 GB')
    expect(remainingMemoryHint(memoryBudget(7.4, ['4G', '4G']))).toBe(
      '内存已分完（2 个实例共分配 8 GB），再加需先卸载',
    )
    /* 读数缺失时不编结论：说「已分完」是个拿不到依据的断言，用户会照着去卸载实例。
       调用点渲染 null 时整行不出现，只是比平时少一行信息 */
    expect(remainingMemoryHint(memoryBudget(0, []))).toBeNull()
  })

  it('recommendNewInstanceGB：按可分配量的一半给，取最近档并封顶到当前余量', () => {
    // 可用 14 GB（= 可分配量，无其他实例）→ 7 GB → 就近 8G 档
    expect(recommendNewInstanceGB(14, 14)).toBe(8)
    // 可分配 14 GB 但已被别处占走 6 GB → 目标 7 GB，受可用量 8 GB 封顶 ⇒ 8G
    expect(recommendNewInstanceGB(8, 14)).toBe(8)
    // 64 GB 机器：可分配 54 GB ⇒ 目标 27 GB ⇒ 就近 32G，但可用量封顶到 54（不超）
    expect(recommendNewInstanceGB(54, 54)).toBe(32)
    // 只剩 3 GB：目标 7 GB 但装不下，封顶到可用量 ⇒ 就近 4G 不可选，落到 2G
    expect(recommendNewInstanceGB(3, 14)).toBe(2)
    // 小机器同理：可分配 4 GB ⇒ 一半 2 GB
    expect(recommendNewInstanceGB(4, 4)).toBe(2)
    expect(recommendNewInstanceGB(2, 2)).toBe(2)
    // 2 GB 机器扣掉 1 GB 系统保留只剩 1 GB 可分配
    expect(recommendNewInstanceGB(1, 1)).toBe(1)
    // 余量只剩 1 GB：下限 2 GB 装不下，退回唯一可用的 1G
    expect(recommendNewInstanceGB(1, 1)).toBe(1)
    expect(recommendNewInstanceGB(0, 0)).toBe(1)
  })
})
