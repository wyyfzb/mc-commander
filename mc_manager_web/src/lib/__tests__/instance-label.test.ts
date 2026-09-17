import { describe, it, expect } from 'vitest'
import { instanceLabel } from '../instance-label'

/**
 * instanceLabel：实例展示名（空名/纯空白名回退 id）
 * 写入侧契约是 trim().min(1)，空名不可产生；这层是展示兜底，历史库里的空名旧行靠它
 * 才不会渲染成「无名卡片」「实例 ""」
 */
describe('instanceLabel', () => {
  it('正常名字原样返回（顺带 trim 首尾空白：引号里不该出现尾空格）', () => {
    expect(instanceLabel({ id: 'demo', name: '生存服' })).toBe('生存服')
    expect(instanceLabel({ id: 'demo', name: '  生存服 ' })).toBe('生存服')
  })

  it('空串 / 纯空白 / 缺失名字 → 回退 id', () => {
    expect(instanceLabel({ id: 'demo', name: '' })).toBe('demo')
    expect(instanceLabel({ id: 'demo', name: '   ' })).toBe('demo')
    expect(instanceLabel({ id: 'demo', name: null })).toBe('demo')
    expect(instanceLabel({ id: 'demo' })).toBe('demo')
  })
})
