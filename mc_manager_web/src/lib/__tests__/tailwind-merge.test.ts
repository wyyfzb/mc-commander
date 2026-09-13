/**
 * cn（tailwind-merge 配置）契约：字号 token 与语义色 token 同串时**都不得被吞**，
 * 已写出的行高类也不得被字号类静默删除。
 *
 * 背景：twMerge 默认按前缀猜分组，`text-mcs-*-fg`（颜色）与 `text-mcs-xs`（字号）
 * 被它归入同一组，后写者挤掉前者（元素回落继承字号）。本用例是承重防线——
 * 它是唯一发现「新增字号档忘了登记进 utils.ts」的地方，故用真实 index.css
 * 里注册的 --text-mcs-* 驱动，避免用例与配置各写一份清单。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { twMerge } from 'tailwind-merge'
import { describe, expect, it } from 'vitest'
import { SEMANTIC_TONE_CLASSES, SEMANTIC_TONES } from '@/components/mcs/tone'
import { cn } from '../utils'

const INDEX_CSS = readFileSync(join(import.meta.dirname, '..', '..', 'index.css'), 'utf-8')

/**
 * 字号 token 声明：整段 token 名后紧跟冒号，故 `--text-mcs-xs--line-height`
 * 这类配对行高子键不会被误当成独立档位（J13 登记配对行高后这条约束才真正生效）。
 */
const FONT_SIZE_DECLARATION = /--text-(mcs-(?:[a-z0-9]+-)*[a-z0-9]+)[^\S\n]*:/g

function parseFontSizeClasses(css: string): string[] {
  return [...css.matchAll(FONT_SIZE_DECLARATION)].map((m) => `text-${m[1]}`)
}

const REGISTERED_FONT_SIZE_CLASSES = parseFontSizeClasses(INDEX_CSS)
/** 语义色类取自词表，新增颜色档时守卫自动覆盖 */
const COLOR_CLASSES = SEMANTIC_TONES.map((tone) => SEMANTIC_TONE_CLASSES[tone].text)

describe('cn 字号/颜色不再互吞', () => {
  it('解析到 index.css 注册的字号 token（守卫本身有效）', () => {
    expect(REGISTERED_FONT_SIZE_CLASSES.length).toBeGreaterThanOrEqual(8)
    expect(REGISTERED_FONT_SIZE_CLASSES).toContain('text-mcs-display')
  })

  it('解析器不把配对行高子键当成字号档', () => {
    // 档名拼出来，避免出现尚未注册的字号类字面量（门禁会拦）
    const future = 'mcs-3xl'
    const synthetic = [
      '  --text-mcs-xs: 1rem;',
      '  --text-mcs-xs--line-height: 1.5;',
      `  @theme inline { --text-${future}: 2rem }`,
    ].join('\n')
    expect(parseFontSizeClasses(synthetic)).toEqual(['text-mcs-xs', `text-${future}`])
  })

  it.each(REGISTERED_FONT_SIZE_CLASSES)('%s 与语义色同串时两者都保留', (sizeClass) => {
    for (const color of COLOR_CLASSES) {
      const out = cn(sizeClass, color).split(/\s+/)
      expect(out, `${sizeClass} + ${color}`).toContain(sizeClass)
      expect(out, `${sizeClass} + ${color}`).toContain(color)
    }
  })

  it('复杂实参（基础串 + 条件分支 + 颜色）不丢字号', () => {
    const out = cn('mcs-num text-mcs-display leading-none', 'text-mcs-success-fg', false)
    expect(out).toContain('text-mcs-display')
    expect(out).toContain('text-mcs-success-fg')
  })

  it('变体前缀各自成组，互不干扰', () => {
    const out = cn('hover:text-mcs-xs hover:text-mcs-error-fg')
    expect(out).toContain('hover:text-mcs-xs')
    expect(out).toContain('hover:text-mcs-error-fg')
  })
})

describe('cn 不再静默删除行高', () => {
  it('字号类后写不吃掉先写的 leading-*（本仓字号无配对行高）', () => {
    expect(cn('text-sm leading-none', 'text-mcs-xs')).toBe('leading-none text-mcs-xs')
    expect(cn('leading-none', 'text-mcs-sm')).toBe('leading-none text-mcs-sm')
    expect(cn('leading-relaxed', 'text-mcs-lg')).toBe('leading-relaxed text-mcs-lg')
  })

  it('标准字号与 leading-* 同时保留（由 --tw-leading 组合）', () => {
    expect(cn('leading-none', 'text-sm')).toBe('leading-none text-sm')
    expect(cn('text-sm', 'leading-none')).toBe('text-sm leading-none')
  })

  it('带行高修饰的字号类仍与 leading-* 互斥（自带行高，与标准档同口径）', () => {
    expect(cn('leading-none', 'text-mcs-xs/2')).toBe('text-mcs-xs/2')
    expect(cn('text-mcs-xs/2', 'leading-none')).toBe('text-mcs-xs/2 leading-none')
    expect(cn('leading-6', 'text-sm/6')).toBe('text-sm/6')
  })
})

describe('cn 的合并语义未被削弱', () => {
  it('字号之间仍然后写者胜（含标准档、任意长度档与变体）', () => {
    expect(cn('text-mcs-xs', 'text-mcs-sm')).toBe('text-mcs-sm')
    expect(cn('text-sm', 'text-lg')).toBe('text-lg')
    expect(cn('text-base', 'text-sm')).toBe('text-sm')
    expect(cn('text-[13px]', 'text-sm')).toBe('text-sm')
    expect(cn('text-(length:--mcs-xs)', 'text-sm')).toBe('text-sm')
    expect(cn('hover:text-mcs-xs', 'hover:text-lg')).toBe('hover:text-lg')
  })

  it('颜色之间仍然后写者胜', () => {
    expect(cn('text-mcs-info-fg', 'text-mcs-error-fg')).toBe('text-mcs-error-fg')
  })

  it.each(['p-4 px-2', 'flex block', 'inset-0 top-2', 'font-medium font-bold', 'rounded-lg rounded-t-sm'])(
    '与字号/行高无关的合并仍走 twMerge 默认规则：%s',
    (classes) => {
      expect(cn(classes)).toBe(twMerge(classes))
    },
  )

  it('类名去重与条件值照常工作', () => {
    const hidden: boolean = false
    expect(cn('p-2', hidden && 'hidden', undefined, 'p-2')).toBe('p-2')
  })
})
