/**
 * MC 命令补全静态表
 * 52 条命令 12 分类；图标/颜色映射；前缀匹配补全（最多 10 条）
 * 玩家页命令拼装（give/teleport/ban 等）消费此表
 */
import type { LucideIcon } from 'lucide-react'
import {
  Cloud,
  Gem,
  Navigation,
  Palette,
  Skull,
  Sparkles,
  Star,
  Sun,
  Terminal,
  Zap,
} from 'lucide-react'

export type CommandColor = 'info' | 'purple' | 'warning' | 'success' | 'error' | 'orange' | 'accent'

export interface McCommandDef {
  /** 命令名（无前导斜杠） */
  name: string
  /** 参数模板（供展示；多个模板按空格分隔的表单变体） */
  usage: string
  category: string
}

export const COMMAND_CATEGORIES = [
  '基础',
  '时间',
  '天气',
  '游戏',
  '传送',
  '物品',
  '实体',
  '效果',
  '附魔',
  '经验',
  '服务器',
  '管理',
  '消息',
  '建筑',
] as const

/** 52 条命令静态表 */
export const MC_COMMANDS: McCommandDef[] = [
  // 基础
  { name: 'help', usage: '', category: '基础' },
  { name: 'list', usage: '', category: '基础' },
  { name: 'msg', usage: '<玩家> <消息>', category: '基础' },
  { name: 'w', usage: '<玩家> <消息>', category: '基础' },
  { name: 'me', usage: '<动作>', category: '基础' },
  // 时间
  {
    name: 'time',
    usage: 'set day | set night | set noon | set midnight | add <数值>',
    category: '时间',
  },
  // 天气
  { name: 'weather', usage: 'clear | rain | thunder', category: '天气' },
  // 游戏
  {
    name: 'gamemode',
    usage: 'survival | creative | adventure | spectator [<玩家>]',
    category: '游戏',
  },
  { name: 'difficulty', usage: 'peaceful | easy | normal | hard', category: '游戏' },
  { name: 'gamerule', usage: '<规则> <值>', category: '游戏' },
  {
    name: 'scoreboard',
    usage: 'objectives add <名称> dummy | players add <玩家> <目标> <分数>',
    category: '游戏',
  },
  // 传送
  { name: 'tp', usage: '<玩家> <x> <y> <z> | <x> <y> <z> | @a <x> <y> <z>', category: '传送' },
  { name: 'teleport', usage: '<玩家> <x> <y> <z> | <x> <y> <z>', category: '传送' },
  // 物品
  { name: 'give', usage: '<玩家> <物品> <数量>', category: '物品' },
  { name: 'clear', usage: '<玩家>', category: '物品' },
  // 实体
  { name: 'kill', usage: '@a | @e[type=!player] | <玩家>', category: '实体' },
  { name: 'summon', usage: '<实体> <x> <y> <z>', category: '实体' },
  // 效果
  { name: 'effect', usage: 'give <玩家> <效果> <秒数> <等级> | clear <玩家>', category: '效果' },
  // 附魔
  { name: 'enchant', usage: '<玩家> <附魔> <等级>', category: '附魔' },
  // 经验
  { name: 'xp', usage: '<数值>L | <数值>', category: '经验' },
  // 服务器
  { name: 'save-all', usage: '', category: '服务器' },
  { name: 'stop', usage: '', category: '服务器' },
  // 管理
  { name: 'op', usage: '<玩家>', category: '管理' },
  { name: 'deop', usage: '<玩家>', category: '管理' },
  { name: 'ban', usage: '<玩家>', category: '管理' },
  { name: 'ban-ip', usage: '<玩家>', category: '管理' },
  { name: 'pardon', usage: '<玩家>', category: '管理' },
  { name: 'pardon-ip', usage: '<玩家>', category: '管理' },
  { name: 'kick', usage: '<玩家>', category: '管理' },
  { name: 'whitelist', usage: 'add <玩家> | remove <玩家> | on | off | list', category: '管理' },
  // 消息
  { name: 'say', usage: '<消息>', category: '消息' },
  { name: 'title', usage: '<玩家> title <文本> | <玩家> subtitle <文本>', category: '消息' },
  // 建筑
  { name: 'fill', usage: '<x1> <y1> <z1> <x2> <y2> <z2> <方块>', category: '建筑' },
]

/** 选择器条目（补全参数用） */
export const MC_SELECTORS = ['@a', '@p', '@s', '@e', '@r']

// ── 图标映射 ──
const ICON_BY_PREFIX: Array<[RegExp, LucideIcon]> = [
  [/^give$/, Gem],
  [/^gamemode$/, Palette],
  [/^time$/, Sun],
  [/^(tp|teleport)$/, Navigation],
  [/^kill$/, Skull],
  [/^weather$/, Cloud],
  [/^effect$/, Sparkles],
  [/^summon$/, Zap],
  [/^(xp|experience)$/, Star],
]

export function iconForCommand(name: string): LucideIcon {
  for (const [re, icon] of ICON_BY_PREFIX) {
    if (re.test(name)) return icon
  }
  return Terminal
}

// ── 颜色映射（→ --mcs-*-fg token 工具类）──
const COLOR_BY_PREFIX: Array<[RegExp, string]> = [
  [/^give$/, 'text-mcs-info-fg'],
  [/^gamemode$/, 'text-mcs-purple-fg'],
  [/^time$/, 'text-mcs-warning-fg'],
  [/^(tp|teleport)$/, 'text-mcs-success-fg'],
  [/^kill$/, 'text-mcs-error-fg'],
  [/^weather$/, 'text-mcs-info-fg'],
  [/^effect$/, 'text-mcs-purple-fg'],
  [/^summon$/, 'text-mcs-orange-fg'],
]

export function colorForCommand(name: string): string {
  for (const [re, cls] of COLOR_BY_PREFIX) {
    if (re.test(name)) return cls
  }
  return 'text-mcs-accent-fg'
}

// ── 补全逻辑（/ 开头；无空格命令名前缀；有空格参数子串；最多 10 条）──
export interface CompletionItem {
  kind: 'command' | 'selector'
  text: string
  name: string
  usage: string
}

export function completeCommands(input: string, limit = 10): CompletionItem[] {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return []
  const body = trimmed.slice(1)
  const hasSpace = body.includes(' ')

  if (!hasSpace) {
    const results: CompletionItem[] = []
    for (const cmd of MC_COMMANDS) {
      if (cmd.name.startsWith(body)) {
        results.push({ kind: 'command', text: `/${cmd.name}`, name: cmd.name, usage: cmd.usage })
      }
      if (results.length >= limit) break
    }
    // 无匹配时提示选择器
    if (results.length === 0) {
      for (const sel of MC_SELECTORS) {
        if (sel.startsWith(body)) {
          results.push({ kind: 'selector', text: sel, name: sel, usage: '目标选择器' })
        }
      }
    }
    return results
  }

  // 有空格：按已输入前缀（命令名+参数）做子串匹配
  const results: CompletionItem[] = []
  const query = body.trimEnd()
  for (const cmd of MC_COMMANDS) {
    if (`${cmd.name} ${cmd.usage}`.includes(query) || cmd.usage.includes(query)) {
      results.push({ kind: 'command', text: `/${cmd.name}`, name: cmd.name, usage: cmd.usage })
    }
    if (results.length >= limit) break
  }
  return results
}
