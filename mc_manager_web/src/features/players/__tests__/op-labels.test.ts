/**
 * OP 动作文案单一来源（W2-07 回归防线）
 * 三处入口（行内菜单 / 详情抽屉 / 批量条）必须用同一份常量——
 * 以前各写各的，同一动作出现「设为 OP」「设为OP」「设置OP」三种写法。
 */
import { describe, it, expect } from 'vitest'
import { OP_LABELS } from '../mutations'

describe('OP_LABELS 单一来源', () => {
  it('按钮文案统一为「设为 OP」/「取消 OP」（带空格，与仓库主流一致）', () => {
    expect(OP_LABELS.grant).toBe('设为 OP')
    expect(OP_LABELS.revoke).toBe('取消 OP')
  })

  it('批量动作用名词化写法，且与按钮档区分（拼进「批量<动作>完成」）', () => {
    expect(OP_LABELS.batchGrant).toBe('设置 OP')
    expect(OP_LABELS.batchRevoke).toBe('取消 OP')
  })

  it('回执文案不出现无空格写法', () => {
    expect(OP_LABELS.granted).toBe('已设置 OP')
    expect(OP_LABELS.revoked).toBe('已取消 OP')
  })
})
