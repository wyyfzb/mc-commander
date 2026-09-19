import { describe, it, expect } from 'vitest'
import { completeCommands, colorForCommand, iconForCommand, MC_COMMANDS } from '../mc-commands'

describe('命令静态表', () => {
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
