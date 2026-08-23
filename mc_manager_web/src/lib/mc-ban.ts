/**
 * 封禁参数与时长解析
 * 服务端为 temp_bans 自实现路线：POST /instances/:id/players/:player/ban {reason?, duration?, ip?}
 * - duration 缺省或不可解析 → 永久封禁（仅原版 ban，不写记录）
 * - duration 可解析 → 先写 temp_bans 再 ban，命令失败回滚
 * - 到期自动解封由服务端 TaskScheduler 轮询执行
 * 档位/理由枚举服务端不提供，由前端静态定义。
 */

/** 封禁时长档位（6 档） */
export interface BanDurationOption {
  /** 显示标签 */
  label: string
  /** duration 参数值（null = 永久封禁） */
  value: string | null
}

export const BAN_DURATION_OPTIONS: BanDurationOption[] = [
  { label: '1小时', value: '1h' },
  { label: '12小时', value: '12h' },
  { label: '1天', value: '1d' },
  { label: '7天', value: '7d' },
  { label: '30天', value: '30d' },
  { label: '永久', value: null },
]

/** 封禁理由（9 项，选「其他」展开自定义输入，空回退「其他」） */
export const BAN_REASONS = [
  '作弊',
  '辱骂/骚扰',
  '恶意破坏',
  '广告',
  '刷屏',
  '恶意PVP',
  '不当语言',
  '使用Bug',
  '其他',
] as const

export type BanReason = (typeof BAN_REASONS)[number]

/** 「其他」理由（自定义输入为空时的回退值） */
export const BAN_REASON_FALLBACK = '其他'

/**
 * 服务端 parseDuration 语法复刻（mc_commander_server/routes/players.js L39-48）：
 * 正则 ^(\d+)(s|m|h|d|w|mo)$，1mo = 30 天。
 * 返回毫秒数；无法解析返回 null。
 */
export function parseDurationToMs(duration: string): number | null {
  const match = /^(\d+)(s|m|h|d|w|mo)$/.exec(duration)
  if (!match) return null
  const value = Number.parseInt(match[1]!, 10)
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    mo: 2_592_000_000,
  }
  return value * (multipliers[match[2]!] ?? 0)
}

/**
 * 封禁剩余时间文案（封禁徽章：剩X天/X小时/X分钟）。
 * 返回 null 表示已过期（即将解封）。
 */
export function formatBanRemaining(expiresAt: number, now: number): string | null {
  const remaining = expiresAt - now
  if (remaining <= 0) return null
  const totalMinutes = Math.floor(remaining / 60_000)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `剩${days}天${hours}小时`
  if (hours > 0) return `剩${hours}小时${minutes}分钟`
  return `剩${Math.max(minutes, 1)}分钟`
}

/** 封禁类型 */
export type BanTargetType = 'player' | 'ip'

/** 封禁弹窗表单模型 */
export interface BanFormModel {
  /** 封禁类型：玩家封禁 / IP 封禁（IP 封禁要求玩家有 IP 地址） */
  targetType: BanTargetType
  /** 时长档位（value 为 null = 永久） */
  duration: string | null
  /** 理由文本 */
  reason: string
  /** 同时踢出在线玩家（kick 失败不阻断封禁） */
  kickFirst: boolean
}

/** 校验封禁表单：IP 封禁需玩家有 IP 地址 */
export function validateBanForm(model: BanFormModel, playerIp: string | null | undefined): string | null {
  if (model.targetType === 'ip' && (!playerIp || playerIp.length === 0)) {
    return '该玩家暂无 IP 信息'
  }
  return null
}
