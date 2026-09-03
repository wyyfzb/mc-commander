/**
 * deploy/utils 单元测试（拆分自 deploy-dialog.tsx 的纯函数）
 * - memoryToGB：档位字符串 → GB 数值
 * - recommendedMemoryGB：total×0.5 clamp [1,total] → 0.5 步进 → 最近档位
 * - formatMB：≥100MB 整数档，<100MB 一位小数
 */
import { describe, it, expect } from 'vitest'
import { memoryToGB, recommendedMemoryGB, formatMB } from '../utils'

describe('deploy/utils', () => {
  it('memoryToGB：档位字符串解析为 GB 数值', () => {
    expect(memoryToGB('1G')).toBe(1)
    expect(memoryToGB('2G')).toBe(2)
    expect(memoryToGB('8G')).toBe(8)
  })

  it('recommendedMemoryGB：16G 总内存推荐 8G（50%）', () => {
    expect(recommendedMemoryGB(16)).toBe(8)
  })

  it('recommendedMemoryGB：4G 总内存推荐 2G', () => {
    expect(recommendedMemoryGB(4)).toBe(2)
  })

  it('recommendedMemoryGB：推荐值映射到最近档位（10G → 5.0 → 4G 档）', () => {
    expect(recommendedMemoryGB(10)).toBe(4)
  })

  it('recommendedMemoryGB：极小总内存 clamp 到最低档 1G', () => {
    expect(recommendedMemoryGB(0.5)).toBe(1)
  })

  it('formatMB：<100MB 保留一位小数；≥100MB 整数档', () => {
    expect(formatMB(52_428_800)).toBe('50.0')
    expect(formatMB(104_857_600)).toBe('100')
    expect(formatMB(157_286_400)).toBe('150')
  })
})
