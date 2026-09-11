/**
 * 语义色词表（components/mcs/tone）契约用例
 * 该表是标签、徽章、图标底块等所有「语义着色」的唯一来源：任何一档被改动，
 * 这里必须一起变——用例的作用是让改动可见，而不是锁死具体色值（色值本身由
 * src/styles/ 的 --mcs-* token 决定）。
 */
import { describe, expect, it } from 'vitest'
import {
  SEMANTIC_TONES,
  SEMANTIC_TONE_CLASSES,
  toneClasses,
  toneOutlineClasses,
} from '../tone'

describe('mcs/tone 语义色词表', () => {
  it('六档语义色，每档都是 border + bg-subtle + fg 的完整字面量 token 类', () => {
    expect(SEMANTIC_TONES).toEqual(['accent', 'success', 'warning', 'error', 'info', 'purple'])
    for (const tone of SEMANTIC_TONES) {
      const c = SEMANTIC_TONE_CLASSES[tone]
      expect(c.text).toBe(`text-mcs-${tone}-fg`)
      expect(c.bg).toBe(`bg-mcs-${tone}-bg-subtle`)
      expect(c.border).toBe(`border-mcs-${tone}-border`)
    }
  })

  it('toneClasses 拼出三件套，toneOutlineClasses 只留描边与前景', () => {
    expect(toneClasses('success')).toBe(
      'border-mcs-success-border bg-mcs-success-bg-subtle text-mcs-success-fg',
    )
    expect(toneOutlineClasses('success')).toBe('border-mcs-success-border text-mcs-success-fg')
    // outline 不得带填充（半透明/不透明 tint 都会与宿主面打架）
    for (const tone of SEMANTIC_TONES) {
      expect(toneOutlineClasses(tone)).not.toContain('-bg-')
    }
  })

  it('内容面 tint 一律不透明（禁用半透明色阶写法，否则有效色随宿主面漂移）', () => {
    for (const tone of SEMANTIC_TONES) {
      expect(SEMANTIC_TONE_CLASSES[tone].bg).toContain('bg-subtle')
      expect(SEMANTIC_TONE_CLASSES[tone].bg).not.toMatch(/\/(\d+|\[)/)
    }
  })
})
