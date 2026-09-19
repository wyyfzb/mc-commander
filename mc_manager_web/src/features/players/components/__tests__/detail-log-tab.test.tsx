/**
 * LogTab 组件测试（契约：统计卡 6 项 / 会话树折叠展开 / 7 类型事件语义色 / 离线间隔 / 空态 / 重置）
 * 数据全部为虚构占位（Steve/Alex + 固定时间戳），严禁真实玩家/服务器数据
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Player, PlayerEvent, PlayerSession } from '@/api/types'
import { LogTab } from '../detail-log-tab'

// ── 虚构数据占位（固定过去时间戳保证确定性：会话 2 进行中 end=null，
//    事件归属上限取 Date.now()，必须全部落在过去时刻才不随运行时间漂移）────
const T10 = '2024-06-01T10:00:00.000Z'
const T10_05 = '2024-06-01T10:05:00.000Z'
const T10_06 = '2024-06-01T10:06:00.000Z'
const T10_10 = '2024-06-01T10:10:00.000Z'
const T10_10_30 = '2024-06-01T10:10:30.000Z'
const T10_20 = '2024-06-01T10:20:00.000Z'
const T10_21 = '2024-06-01T10:21:00.000Z'
const T10_30 = '2024-06-01T10:30:00.000Z'
/** 事件 timestamp 契约＝epoch 毫秒（与产出端 output-parser 的 Date.now() 一致） */
const ms = (iso: string) => new Date(iso).getTime()

const T13 = '2024-06-01T13:00:00.000Z'
const T13_05 = '2024-06-01T13:05:00.000Z'
const T13_20 = '2024-06-01T13:20:00.000Z'
const T13_21 = '2024-06-01T13:21:00.000Z'
const T13_40 = '2024-06-01T13:40:00.000Z'

const SESSION_1: PlayerSession = { start: ms(T10), end: ms(T10_30), duration: 1800 }
const SESSION_2: PlayerSession = { start: ms(T13), end: null, duration: 3600 }

/** 会话 1 内事件（进入/死亡/复活/离开，10:00-10:30） */
const EVENTS_1: PlayerEvent[] = [
  { type: 'join', message: 'Steve 进入游戏', timestamp: ms(T10) },
  { type: 'death', message: 'Steve 掉入虚空', timestamp: ms(T10_10) },
  { type: 'respawn', message: 'Steve 复活', timestamp: ms(T10_10_30) },
  { type: 'leave', message: 'Steve 离开游戏', timestamp: ms(T10_30) },
]

/** 会话 2 内事件（进入/进度/入睡/起床，13:00 起） */
const EVENTS_2: PlayerEvent[] = [
  { type: 'join', message: 'Steve 进入游戏', timestamp: ms(T13) },
  { type: 'achievement', message: '获得成就: 钻石！', timestamp: ms(T13_05) },
  { type: 'sleep', message: 'Steve 入睡', timestamp: ms(T13_20) },
  { type: 'wake', message: 'Steve 起床', timestamp: ms(T13_21) },
]

/** 7 类型全覆盖事件（单会话内） */
const EVENTS_ALL_7: PlayerEvent[] = [
  { type: 'join', message: 'Steve 进入游戏', timestamp: ms(T10) },
  { type: 'leave', message: 'Steve 离开游戏', timestamp: ms(T10_30) },
  { type: 'death', message: 'Steve 被苦力怕炸死', timestamp: ms(T10_05) },
  { type: 'respawn', message: 'Steve 复活', timestamp: ms(T10_10_30) },
  { type: 'achievement', message: '获得成就: 石之所在', timestamp: ms(T10_06) },
  { type: 'sleep', message: 'Steve 入睡', timestamp: ms(T10_20) },
  { type: 'wake', message: 'Steve 起床', timestamp: ms(T10_21) },
]

function makePlayer(overrides: Partial<Player>): Player {
  return {
    name: 'Steve',
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    isOnline: false,
    ip: '',
    joinTime: null,
    onlineTime: 0,
    totalPlayTime: 0,
    isOp: false,
    isWhitelisted: false,
    isBanned: false,
    banExpiresAt: null,
    isIpBanned: false,
    ipBanExpiresAt: null,
    isFakePlayer: false,
    lastSeen: T13,
    health: null,
    maxHealth: null,
    hunger: null,
    xpLevel: null,
    spawnPoint: null,
    respawnPoint: null,
    position: null,
    gameMode: null,
    dimension: null,
    armor: null,
    xpProgress: null,
    ping: null,
    isSleeping: false,
    isAfk: false,
    isFlying: false,
    isSneaking: false,
    isSprinting: false,
    isBurning: false,
    isFrozen: false,
    potionEffects: [],
    ipHistory: [],
    inventory: null,
    events: [],
    sessions: [],
    stats: {
      totalOnline: 0,
      loginCount: 0,
      offlineSince: 0,
      deathCount: 0,
      achievementCount: 0,
      sleepCount: 0,
    },
    ...overrides,
  }
}

/** 双会话玩家：会话1(10:00-10:30) + 会话2(13:00 进行中)，间隔 2.5h */
const twoSessionPlayer = makePlayer({
  events: [...EVENTS_1, ...EVENTS_2],
  sessions: [SESSION_1, SESSION_2],
})

describe('LogTab 空态', () => {
  it('无会话/事件 → 「暂无日志数据」，无统计卡与折叠按钮', () => {
    render(<LogTab player={makePlayer({})} />)
    expect(screen.getByText('暂无日志数据')).toBeInTheDocument()
    expect(screen.queryByText('总在线')).not.toBeInTheDocument()
    expect(screen.queryByText('全部折叠')).not.toBeInTheDocument()
    expect(screen.queryByText('全部展开')).not.toBeInTheDocument()
  })
})

describe('LogTab 统计卡 6 项', () => {
  it('渲染 6 项数值（总在线/累计登录/已离线/死亡/进度/入睡）', () => {
    render(
      <LogTab
        player={makePlayer({
          sessions: [SESSION_1],
          stats: {
            totalOnline: 7200,
            loginCount: 12,
            offlineSince: 9000,
            deathCount: 3,
            achievementCount: 5,
            sleepCount: 2,
          },
        })}
      />,
    )
    expect(screen.getByText('总在线')).toBeInTheDocument()
    expect(screen.getByText('2h00m')).toBeInTheDocument()
    expect(screen.getByText('累计登录')).toBeInTheDocument()
    expect(screen.getByText('12 次')).toBeInTheDocument()
    expect(screen.getByText('已离线')).toBeInTheDocument()
    expect(screen.getByText('2h30m')).toBeInTheDocument()
    expect(screen.getByText('死亡')).toBeInTheDocument()
    expect(screen.getByText('3 次')).toBeInTheDocument()
    expect(screen.getByText('进度')).toBeInTheDocument()
    expect(screen.getByText('5 个')).toBeInTheDocument()
    expect(screen.getByText('入睡')).toBeInTheDocument()
    expect(screen.getByText('2 次')).toBeInTheDocument()
  })

  it('死亡/进度/入睡数值用语义色 token', () => {
    render(
      <LogTab
        player={makePlayer({
          sessions: [SESSION_1],
          stats: {
            totalOnline: 7200,
            loginCount: 1,
            offlineSince: 0,
            deathCount: 3,
            achievementCount: 5,
            sleepCount: 2,
          },
        })}
      />,
    )
    expect(screen.getByText('3 次').className).toContain('text-mcs-error-fg')
    expect(screen.getByText('5 个').className).toContain('text-mcs-accent-fg')
    expect(screen.getByText('2 次').className).toContain('text-mcs-info-fg')
    expect(screen.getByText('2h00m').className).toContain('text-mcs-text-default')
  })
})

describe('LogTab 会话树（默认折叠 + 展开）', () => {
  it('默认折叠：会话标题可见，事件行隐藏（事件专属标签 进入/起床/获得进度 均不可见）', () => {
    render(<LogTab player={twoSessionPlayer} />)
    expect(screen.getByText(/登录日志1/)).toBeInTheDocument()
    expect(screen.getByText(/登录日志2/)).toBeInTheDocument()
    expect(screen.queryByText('进入')).not.toBeInTheDocument()
    expect(screen.queryByText('起床')).not.toBeInTheDocument()
    expect(screen.queryByText('获得进度')).not.toBeInTheDocument()
  })

  it('点击会话行展开显示事件，再点击折叠隐藏（aria-expanded 同步）', () => {
    render(<LogTab player={twoSessionPlayer} />)
    const row = screen.getByText(/登录日志2/)
    expect(row.closest('button')).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(row)
    expect(screen.getByText('进入')).toBeInTheDocument()
    expect(screen.getByText('获得进度')).toBeInTheDocument()
    expect(screen.getByText('起床')).toBeInTheDocument()
    expect(row.closest('button')).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(row)
    expect(screen.queryByText('进入')).not.toBeInTheDocument()
    expect(row.closest('button')).toHaveAttribute('aria-expanded', 'false')
  })

  it('展开后显示会话时长与结束时刻（进行中会话显示「现在」）', () => {
    render(<LogTab player={twoSessionPlayer} />)
    fireEvent.click(screen.getByText(/登录日志1/))
    fireEvent.click(screen.getByText(/登录日志2/))
    // 会话 1：30m00s；会话 2：1h00m + 进行中「现在」
    expect(screen.getByText(/30m00s/)).toBeInTheDocument()
    expect(screen.getByText(/1h00m/)).toBeInTheDocument()
    expect(screen.getByText(/现在/)).toBeInTheDocument()
  })

  it('最新会话在上（登录日志2 先于 登录日志1）', () => {
    render(<LogTab player={twoSessionPlayer} />)
    const titles = screen.getAllByText(/登录日志/)
    expect(titles[0]!.textContent).toContain('登录日志2')
    expect(titles[1]!.textContent).toContain('登录日志1')
  })

  it('会话无事件 → 展开后显示「（无事件记录）」', () => {
    render(<LogTab player={makePlayer({ sessions: [SESSION_1] })} />)
    fireEvent.click(screen.getByText(/登录日志1/))
    expect(screen.getByText('（无事件记录）')).toBeInTheDocument()
  })
})

describe('LogTab 7 类型事件行（语义色 + 图标 + 中文标签）', () => {
  it('全部类型渲染并带契约语义色 class', () => {
    render(<LogTab player={makePlayer({ sessions: [SESSION_1], events: EVENTS_ALL_7 })} />)
    fireEvent.click(screen.getByText(/登录日志1/))

    // 中文标签（死亡/入睡 与统计卡标签重名，按带边框的徽章元素定位）
    const badge = (label: string): HTMLElement => {
      const el = screen.getAllByText(label).find((n) => n.className.includes('border-'))
      expect(el).toBeDefined()
      return el as HTMLElement
    }
    for (const label of ['进入', '离开', '死亡', '复活', '获得进度', '入睡', '起床']) {
      expect(badge(label)).toBeInTheDocument()
    }

    // 语义色映射：join=success/leave=muted/death=error/respawn=info/achievement=accent/sleep=purple/wake=warning
    expect(badge('进入').className).toContain('text-mcs-success-fg')
    expect(badge('进入').className).toContain('bg-mcs-success-bg-subtle')
    expect(badge('离开').className).toContain('text-mcs-text-muted')
    expect(badge('死亡').className).toContain('text-mcs-error-fg')
    expect(badge('复活').className).toContain('text-mcs-info-fg')
    expect(badge('获得进度').className).toContain('text-mcs-accent-fg')
    expect(badge('入睡').className).toContain('text-mcs-purple-fg')
    expect(badge('起床').className).toContain('text-mcs-warning-fg')
  })

  it('成就消息去「获得成就: 」前缀，完成挑战单独标签', () => {
    render(
      <LogTab
        player={makePlayer({
          sessions: [SESSION_1],
          events: [
            { type: 'achievement', message: '获得成就: 钻石！', timestamp: ms(T10_05) },
            { type: 'achievement', message: '完成挑战: 超越梦境', timestamp: ms(T10_06) },
          ],
        })}
      />,
    )
    fireEvent.click(screen.getByText(/登录日志1/))
    expect(screen.getByText('钻石！')).toBeInTheDocument()
    expect(screen.getByText('超越梦境')).toBeInTheDocument()
    expect(screen.getByText('完成挑战')).toBeInTheDocument()
    expect(screen.getByText('获得进度')).toBeInTheDocument()
  })

  it('事件行显示完整时间戳（YYYY-MM-DD HH:mm:ss，本地时区计算）', () => {
    const d = new Date(T10_10)
    const p = (n: number) => String(n).padStart(2, '0')
    const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    render(
      <LogTab
        player={makePlayer({
          sessions: [SESSION_1],
          events: [{ type: 'death', message: 'Steve 掉入虚空', timestamp: ms(T10_10) }],
        })}
      />,
    )
    fireEvent.click(screen.getByText(/登录日志1/))
    expect(screen.getByText(expected)).toBeInTheDocument()
  })
})

describe('LogTab 全部折叠/全部展开', () => {
  it('默认全部折叠 → 按钮「全部展开」；点击展开全部，再点击全部折叠', () => {
    render(<LogTab player={twoSessionPlayer} />)
    const btn = screen.getByText('全部展开')
    fireEvent.click(btn)
    // 两个会话的事件都展开
    expect(screen.getAllByText('进入')).toHaveLength(2)
    expect(screen.getByText('起床')).toBeInTheDocument()
    expect(screen.getByText(/掉入虚空/)).toBeInTheDocument()
    // 按钮切换为「全部折叠」
    fireEvent.click(screen.getByText('全部折叠'))
    expect(screen.queryByText('进入')).not.toBeInTheDocument()
    expect(screen.getByText('全部展开')).toBeInTheDocument()
  })
})

describe('LogTab 离线间隔节点', () => {
  it('相邻会话 gap 渲染「离线 · X 时 X 分」（10:30 → 13:00 = 2 时 30 分）', () => {
    render(<LogTab player={twoSessionPlayer} />)
    expect(screen.getByText(/离线 · 2 时 30 分/)).toBeInTheDocument()
    // 离线标签单独存在
    expect(screen.getByText('离线')).toBeInTheDocument()
  })
})

describe('LogTab 折叠状态重置（索引防错位语义）', () => {
  it('切换玩家（name 变化）→ 重置为默认折叠', () => {
    const { rerender } = render(<LogTab player={twoSessionPlayer} />)
    fireEvent.click(screen.getByText(/登录日志2/))
    expect(screen.getByText('起床')).toBeInTheDocument()

    rerender(
      <LogTab player={makePlayer({ name: 'Alex', events: EVENTS_1, sessions: [SESSION_1] })} />,
    )
    expect(screen.queryByText('起床')).not.toBeInTheDocument()
    expect(screen.queryByText('进入')).not.toBeInTheDocument()
  })

  it('会话数变化（同玩家 sessions.length 变化）→ 重置为默认折叠', () => {
    const single = makePlayer({ events: EVENTS_1, sessions: [SESSION_1] })
    const { rerender } = render(<LogTab player={single} />)
    fireEvent.click(screen.getByText(/登录日志1/))
    expect(screen.getByText('进入')).toBeInTheDocument()

    rerender(<LogTab player={twoSessionPlayer} />)
    expect(screen.queryByText('进入')).not.toBeInTheDocument()
    expect(screen.getByText(/登录日志2/)).toBeInTheDocument()
  })

  it('会话数相同（仅事件变化）→ 折叠状态保留', () => {
    const { rerender } = render(<LogTab player={twoSessionPlayer} />)
    fireEvent.click(screen.getByText(/登录日志2/))
    expect(screen.getByText('起床')).toBeInTheDocument()

    // 同 name 同 sessions.length，仅事件新增
    rerender(
      <LogTab
        player={makePlayer({
          events: [
            ...EVENTS_2,
            { type: 'death', message: 'Steve 被骷髅射杀', timestamp: ms(T13_40) },
          ],
          sessions: [SESSION_1, SESSION_2],
        })}
      />,
    )
    expect(screen.getByText('起床')).toBeInTheDocument()
    expect(screen.getByText(/被骷髅射杀/)).toBeInTheDocument()
  })
})
