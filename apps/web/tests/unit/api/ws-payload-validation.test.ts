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

  it('未登记契约的事件直接放行（不是所有事件都有 schema）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateWsPayload('deployProgress', { anything: true })).toEqual([])
    expect(validateWsPayload('systemStatsUpdate', {})).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('同一事件类型的多个事件共用一份载荷契约', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 六个 player* 事件都是 name/message/cause 这类字段，形状相同
    for (const type of ['playerJoin', 'playerLeave', 'playerDeath', 'playerChat']) {
      expect(validateWsPayload(type, { name: 'Steve' })).toEqual([])
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it('性能载荷缺项会被指出（这类字段消费方会逐项读取）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateWsPayload('performanceUpdate', perfPayload)).toEqual([])
    const issues = validateWsPayload('performanceUpdate', { cpu: 1 })
    expect(issues.length).toBeGreaterThan(0)
  })

  it('backup 系列共用同一份载荷契约', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const type of ['backupStart', 'backupComplete', 'backupFailed', 'backupCancelled']) {
      expect(validateWsPayload(type, { id: 1, name: 'b1' })).toEqual([])
    }
  })
})
