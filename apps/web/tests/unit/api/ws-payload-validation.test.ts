import { describe, it, expect, vi, afterEach } from 'vitest'
import { validateWsPayload } from '@/api/ws-payload-validation'

const statusSnapshot = {
  status: 'running',
  isRunning: true,
  players: [],
  tps: 20,
  msmpPush: false,
}

const perfPayload = {
  cpu: 1,
  memory: 2,
  tps: 20,
  mspt: 3,
  worldTime: 0,
  worldDay: 1,
  sleepingPlayers: 0,
  sleepingPlayerNames: [],
  awakePlayerNames: [],
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('validateWsPayload：按契约观测载荷', () => {
  it('合法载荷返回空问题列表，且不告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateWsPayload('statusSnapshot', statusSnapshot)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('缺字段的载荷返回问题路径并告警（不抛异常，由调用方继续宽松读取）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const issues = validateWsPayload('statusSnapshot', { status: 'running' })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((i) => i.startsWith('isRunning') || i.startsWith('players'))).toBe(true)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('非事件类型直接放行（pong/auth 是客户端消息的应答，不在事件目录里）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateWsPayload('pong', { anything: true })).toEqual([])
    expect(validateWsPayload('auth', { ok: true })).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('玩家事件按类型各自校验：缺该事件必填字段即报出', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 形状相近不等于共用一份契约：chat 缺 message 必须被指出
    expect(validateWsPayload('playerChat', { name: 'Steve' }).length).toBeGreaterThan(0)
    expect(validateWsPayload('playerChat', { name: 'Steve', message: 'hi' })).toEqual([])
  })

  it('death 的两种真实形态都通过：单条与 5s 窗口聚合的批量', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateWsPayload('playerDeath', { name: 'Steve', cause: '被射杀' })).toEqual([])
    expect(
      validateWsPayload('playerDeath', {
        players: [{ name: 'Steve', cause: '被射杀' }],
        count: 1,
      }),
    ).toEqual([])
  })

  it('性能载荷缺项会被指出（这类字段消费方会逐项读取）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateWsPayload('performanceUpdate', perfPayload)).toEqual([])
    const issues = validateWsPayload('performanceUpdate', { cpu: 1 })
    expect(issues.length).toBeGreaterThan(0)
  })

  it('备份生命周期要求 content：通知中心的文案由服务端给', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const type of ['backupStart', 'backupComplete', 'backupFailed', 'backupCancelled']) {
      expect(
        validateWsPayload(type, { instanceId: 's1', backupId: 1, content: '备份完成' }),
      ).toEqual([])
      expect(validateWsPayload(type, { instanceId: 's1', backupId: 1 }).length).toBeGreaterThan(0)
    }
  })

  it('部署与升级进度事件有契约：载荷字段逐项受约束', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      validateWsPayload('deployProgress', {
        stage: 'download',
        percent: 0.5,
        transferred: 1024,
        total: 2048,
      }),
    ).toEqual([])
    expect(
      validateWsPayload('upgradeComplete', {
        instanceId: 's1',
        stage: 'completed',
        percent: 100,
        detail: '升级完成',
        timestamp: 1,
        instanceName: 'Survival',
      }),
    ).toEqual([])
  })

  it('系统读数复用 REST 的同一份 schema', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      validateWsPayload('systemStatsUpdate', {
        cpuUsage: 12.5,
        memoryUsage: 4.2,
        totalMemory: 16,
        memoryPercent: 26.3,
        cpuCores: 8,
        loadAvg: [0.5],
        uptime: 3600,
      }),
    ).toEqual([])
  })
})
