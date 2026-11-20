import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * /theme-init.js 是 public 原样发布的纯 IIFE（不经打包），只能求值原文来测。
 * 覆盖首帧定色的每个输入：新 key、旧版 mcs-theme、system、坏 JSON、脏主题值、
 * matchMedia 抛错。html 初始类名是 dark，故 catch 路径保持 dark。
 */
const code = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'public', 'theme-init.js'),
  'utf-8',
)

interface RunOptions {
  storage?: Record<string, string>
  osDark?: boolean
  matchMediaThrows?: boolean
}

/** 在假 DOM/localStorage 里执行脚本原文，返回最终的 html 类名集合 */
function run({ storage = {}, osDark = true, matchMediaThrows = false }: RunOptions = {}) {
  const classes = new Set(['dark']) // 对应 index.html 的 class="dark"
  const documentElement = {
    classList: {
      toggle(name: string, force?: boolean) {
        if (force) classes.add(name)
        else classes.delete(name)
      },
    },
  }
  const fakeWindow = {
    matchMedia: (query: string) => {
      if (matchMediaThrows) throw new Error('matchMedia 不可用')
      return {
        matches: query === '(prefers-color-scheme: dark)' ? osDark : false,
      }
    },
  }
  const fakeStorage = {
    getItem: (key: string) => storage[key] ?? null,
  }
  new Function('window', 'localStorage', 'document', code)(
    fakeWindow,
    fakeStorage,
    { documentElement },
  )
  return classes
}

/** html 最终类名（排序：断言写成 ['dark'] / ['light']，两个类名都在时自然不等） */
function classesOf(classes: Set<string>) {
  return [...classes].sort()
}

const persist = (theme: string) => JSON.stringify({ state: { theme }, version: 0 })

describe('theme-init.js 首帧定色', () => {
  it('没有持久化偏好 → dark（与 store 默认值一致）', () => {
    expect(classesOf(run())).toEqual(['dark'])
  })

  it('新 key 的固定档 → 按偏好定色', () => {
    expect([
      classesOf(run({ storage: { 'mcs-ui-preferences': persist('light') } })),
      classesOf(run({ storage: { 'mcs-ui-preferences': persist('dark') } })),
    ]).toEqual([['light'], ['dark']])
  })

  it('system → 跟随操作系统', () => {
    const storage = { 'mcs-ui-preferences': persist('system') }
    expect([
      classesOf(run({ storage, osDark: true })),
      classesOf(run({ storage, osDark: false })),
    ]).toEqual([['dark'], ['light']])
  })

  it('旧版 mcs-theme 单独存在（迁移尚未写入新 key）→ 用旧值定色，不暗闪', () => {
    expect([
      classesOf(run({ storage: { 'mcs-theme': 'light' } })),
      classesOf(run({ storage: { 'mcs-theme': 'dark' } })),
    ]).toEqual([['light'], ['dark']])
  })

  it('坏 JSON / 脏主题值 / matchMedia 抛错 → 保持 dark', () => {
    expect([
      classesOf(run({ storage: { 'mcs-ui-preferences': '{not json' } })),
      classesOf(run({ storage: { 'mcs-ui-preferences': persist('sepia') } })),
      classesOf(
        run({ storage: { 'mcs-ui-preferences': persist('system') }, matchMediaThrows: true }),
      ),
    ]).toEqual([['dark'], ['dark'], ['dark']])
  })
})