import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  completeCommands,
  colorForCommand,
  iconForCommand,
  COMMAND_CATEGORIES,
  MC_COMMANDS,
} from '../mc-commands'

describe('命令静态表', () => {
  it('条数与分类数是显式契约（此前无断言，注释与事实一起漂）', () => {
    // 这两个数字是**有意钉住**的：源码注释曾自述的条数/分类数与实际数量不一致，
    // 且没有任何断言 ⇒ 两边一起漂。改表就要改这里，让「新增/删除」出现在 diff 里。
    expect(MC_COMMANDS).toHaveLength(33)
    expect(COMMAND_CATEGORIES).toHaveLength(14)
    // 源码注释的自述数字必须与实现一致（注释失实本身是缺陷）
    const src = readFileSync(new URL('../mc-commands.ts', import.meta.url), 'utf-8')
    expect(src, '源码注释里的条数自述必须与实现一致').toContain('33 条命令 14 分类')
  })

  it('每条命令的分类都在 COMMAND_CATEGORIES 内（防造出无人认领的分类）', () => {
    const known = new Set<string>(COMMAND_CATEGORIES)
    for (const cmd of MC_COMMANDS) {
      expect(known.has(cmd.category), `命令 ${cmd.name} 的分类 ${cmd.category} 未登记`).toBe(true)
    }
  })

  it('每个已登记分类都至少有一条命令（防留下空分类）', () => {
    const used = new Set(MC_COMMANDS.map((c) => c.category))
    for (const cat of COMMAND_CATEGORIES) {
      expect(used.has(cat), `分类 ${cat} 下没有任何命令`).toBe(true)
    }
  })

  it('包含核心命令且无重复', () => {
    const names = MC_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const required of [
      'help',
      'give',
      'tp',
      'ban',
      'kick',
      'whitelist',
      'save-all',
      'stop',
      'say',
      'fill',
      'effect',
      'enchant',
      'xp',
    ]) {
      expect(names).toContain(required)
    }
  })

  it('所有命令有分类', () => {
    for (const cmd of MC_COMMANDS) {
      expect(cmd.category).toBeTruthy()
    }
  })
})

describe('补全逻辑', () => {
  it('非 / 开头不触发', () => {
    expect(completeCommands('say')).toEqual([])
    expect(completeCommands('')).toEqual([])
  })

  it('命令名前缀匹配', () => {
    const results = completeCommands('/ga')
    expect(results.some((r) => r.text === '/gamemode')).toBe(true)
    expect(results.every((r) => r.text.startsWith('/ga'))).toBe(true)
  })

  it('无命令匹配时回退选择器', () => {
    const results = completeCommands('/@a')
    expect(results.some((r) => r.kind === 'selector' && r.text === '@a')).toBe(true)
  })

  it('参数子串匹配（有空格）', () => {
    const results = completeCommands('/time set ')
    expect(results.some((r) => r.name === 'time')).toBe(true)
  })

  it('结果上限 10 条', () => {
    expect(completeCommands('/').length).toBeLessThanOrEqual(10)
  })
})

describe('图标/颜色映射', () => {
  it('give → 钻石图标 + info 色', () => {
    expect(colorForCommand('give')).toBe('text-mcs-info-fg')
    expect(iconForCommand('give')).toBeTruthy()
  })
  it('kill → error 色；tp → success 色；summon → orange 色', () => {
    expect(colorForCommand('kill')).toBe('text-mcs-error-fg')
    expect(colorForCommand('tp')).toBe('text-mcs-success-fg')
    expect(colorForCommand('summon')).toBe('text-mcs-orange-fg')
  })
  it('未知命令 → 默认 terminal 图标 + accent 色', () => {
    expect(colorForCommand('unknown')).toBe('text-mcs-accent-fg')
    expect(iconForCommand('unknown')).toBeTruthy()
  })
})
