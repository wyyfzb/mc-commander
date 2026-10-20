/**
 * deploy/utils 单元测试
 * - formatMB：≥100MB 整数档，<100MB 一位小数
 */
import { describe, it, expect } from 'vitest'
import { formatMB } from '@/features/instances/components/deploy/utils'

describe('deploy/utils', () => {
  it('formatMB：<100MB 保留一位小数；≥100MB 整数档', () => {
    expect(formatMB(52_428_800)).toBe('50.0')
    expect(formatMB(104_857_600)).toBe('100')
    expect(formatMB(157_286_400)).toBe('150')
  })
})
