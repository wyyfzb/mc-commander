/**
 * server store WS 数据合并链路单测（issue 407）
 * - 基础 setter：setStatus / setSystemStats / setInstanceId（含 null 清除）与连接态 setter
 * - applyWsSnapshot：实例匹配合并 / instanceId 不匹配早退 / status 为 null 早退 / tps 缺省回落
 * - applyWsPerformance：status 为 null 早退 / 九字段全量合并（其余字段保留）
 * - applyWsStatusEvent：跃迁记录（lastStatusEvent 仅保留最近一次）
 * 夹具复用 mockInstanceStatus（经 instanceStatusSchema 校验的结构占位数据，虚构值）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useServerStore } from '../server'
import { mockInstanceStatus } from '@/test/mocks/handlers'
import type {
  InstanceStatus,
  SystemStats,
  WsPerformancePayload,
  WsStatusSnapshot,
} from '@/api/types'

const makeStatus = (overrides: Partial<InstanceStatus> = {}): InstanceStatus => ({
  ...mockInstanceStatus,
  ...overrides,
})

const makeSnapshot = (overrides: Partial<WsStatusSnapshot> = {}): WsStatusSnapshot => ({
  status: 'running',
  isRunning: true,
  players: [],
  tps: 20,
  ...overrides,
})

const makePerf = (overrides: Partial<WsPerformancePayload> = {}): WsPerformancePayload => ({
  cpu: 55.5,
  memory: 6.6,
  tps: 19.8,
  mspt: 25,
  worldTime: 12_345,
  worldDay: 7,
  sleepingPlayers: 2,
  sleepingPlayerNames: ['Alex'],
  awakePlayerNames: ['Steve'],
  ...overrides,
})

const makeStats = (overrides: Partial<SystemStats> = {}): SystemStats => ({
  cpuUsage: 30.5,
  memoryUsage: 45.2,
  totalMemory: 16,
  memoryPercent: 45.2,
  cpuCores: 8,
  loadAvg: [0.5, 0.8, 1.1],
  uptime: 86_400,
  ...overrides,
})

beforeEach(() => {
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: null,
    socketConnected: false,
    hasConnectedOnce: false,
    lastStatusEvent: null,
    phase: {},
  })
})

describe('server store 基础 setter', () => {
  it('setStatus：置入实例状态，null 清除', () => {
    const { setStatus } = useServerStore.getState()
    const status = makeStatus()
    setStatus(status)
    expect(useServerStore.getState().status).toEqual(status)

    setStatus(null)
    expect(useServerStore.getState().status).toBeNull()
  })

  it('setSystemStats：置入系统资源，null 清除', () => {
    const { setSystemStats } = useServerStore.getState()
    setSystemStats(makeStats())
    expect(useServerStore.getState().systemStats?.cpuCores).toBe(8)

    setSystemStats(null)
    expect(useServerStore.getState().systemStats).toBeNull()
  })

  it('setInstanceId：切换订阅实例，null 清除', () => {
    const { setInstanceId } = useServerStore.getState()
    setInstanceId('demo')
    expect(useServerStore.getState().instanceId).toBe('demo')

    setInstanceId(null)
    expect(useServerStore.getState().instanceId).toBeNull()
  })

  it('setSocketConnected / setHasConnectedOnce：连接态翻转', () => {
    const { setSocketConnected, setHasConnectedOnce } = useServerStore.getState()
    setSocketConnected(true)
    setHasConnectedOnce(true)
    expect(useServerStore.getState().socketConnected).toBe(true)
    expect(useServerStore.getState().hasConnectedOnce).toBe(true)

    setSocketConnected(false)
    expect(useServerStore.getState().socketConnected).toBe(false)
    // hasConnectedOnce 不随断开复位（区分“初次连接中”与“实时通道断开”）
    expect(useServerStore.getState().hasConnectedOnce).toBe(true)
  })
})

describe('applyWsSnapshot（status 快照合并）', () => {
  it('匹配实例：合并 isRunning 与 tps，其余字段保留', () => {
    const { setInstanceId, setStatus, applyWsSnapshot } = useServerStore.getState()
    setInstanceId('demo')
    setStatus(makeStatus({ isRunning: false, tps: 20 }))
    applyWsSnapshot('demo', makeSnapshot({ isRunning: true, tps: 19.5 }))

    const s = useServerStore.getState().status
    expect(s?.isRunning).toBe(true)
    expect(s?.tps).toBe(19.5)
    expect(s?.name).toBe(mockInstanceStatus.name)
    expect(s?.mcVersion).toBe(mockInstanceStatus.mcVersion)
    expect(s?.playerCount).toBe(mockInstanceStatus.playerCount)
  })

  it('tps 缺省回落：快照 tps 为 null 时保留原 tps', () => {
    const { setInstanceId, setStatus, applyWsSnapshot } = useServerStore.getState()
    setInstanceId('demo')
    setStatus(makeStatus({ tps: 20 }))
    applyWsSnapshot('demo', makeSnapshot({ isRunning: true, tps: null }))

    const s = useServerStore.getState().status
    expect(s?.tps).toBe(20)
    expect(s?.isRunning).toBe(true)
  })

  it('instanceId 不匹配：早退不合并（状态引用不变）', () => {
    const { setInstanceId, setStatus, applyWsSnapshot } = useServerStore.getState()
    setInstanceId('demo')
    setStatus(makeStatus({ tps: 20, isRunning: false }))
    const before = useServerStore.getState().status

    applyWsSnapshot('other-inst', makeSnapshot({ isRunning: true, tps: 1 }))
    expect(useServerStore.getState().status).toBe(before)
  })

  it('status 为 null：快照不产生状态', () => {
    const { setInstanceId, applyWsSnapshot } = useServerStore.getState()
    setInstanceId('demo')
    applyWsSnapshot('demo', makeSnapshot())
    expect(useServerStore.getState().status).toBeNull()
  })
})

describe('applyWsPerformance（性能字段合并）', () => {
  it('status 为 null：早退不产生状态', () => {
    useServerStore.getState().applyWsPerformance(makePerf())
    expect(useServerStore.getState().status).toBeNull()
  })

  it('九字段全量合并，其余字段保留', () => {
    const { setInstanceId, setStatus, applyWsPerformance } = useServerStore.getState()
    setInstanceId('demo')
    setStatus(
      makeStatus({
        cpuUsage: 1,
        memoryUsage: 1,
        tps: 20,
        mspt: 5,
        worldTime: 0,
        worldDay: 0,
        sleepingPlayers: 0,
        sleepingPlayerNames: [],
        awakePlayerNames: [],
      }),
    )
    applyWsPerformance(makePerf())

    const s = useServerStore.getState().status
    expect(s?.cpuUsage).toBe(55.5)
    expect(s?.memoryUsage).toBe(6.6)
    expect(s?.tps).toBe(19.8)
    expect(s?.mspt).toBe(25)
    expect(s?.worldTime).toBe(12_345)
    expect(s?.worldDay).toBe(7)
    expect(s?.sleepingPlayers).toBe(2)
    expect(s?.sleepingPlayerNames).toEqual(['Alex'])
    expect(s?.awakePlayerNames).toEqual(['Steve'])
    // 非性能字段不受性能包影响
    expect(s?.name).toBe(mockInstanceStatus.name)
    expect(s?.playerCount).toBe(mockInstanceStatus.playerCount)
  })
})

describe('applyWsStatusEvent（状态跃迁记录）', () => {
  it('记录事件类型与时间戳', () => {
    const before = Date.now()
    useServerStore.getState().applyWsStatusEvent('started')
    const ev = useServerStore.getState().lastStatusEvent
    expect(ev?.event).toBe('started')
    expect(ev?.timestamp).toBeGreaterThanOrEqual(before)
    expect(ev?.timestamp).toBeLessThanOrEqual(Date.now())
  })

  it('连续事件仅保留最近一次', () => {
    const { applyWsStatusEvent } = useServerStore.getState()
    applyWsStatusEvent('crash')
    applyWsStatusEvent('ready')
    expect(useServerStore.getState().lastStatusEvent?.event).toBe('ready')
  })
})
