import { describe, it, expect } from 'vitest'
import {
  describeReachability,
  portFromAddress,
  type ReachabilityState,
} from '@/lib/mc-reachability'

describe('端口解析', () => {
  it('从 地址:端口 取端口', () => {
    expect(portFromAddress('1.2.3.4:25565')).toBe('25565')
    expect(portFromAddress('10.0.0.1:25567')).toBe('25567')
  })

  it('IPv6 面状地址取末段', () => {
    expect(portFromAddress('[::1]:25565')).toBe('25565')
  })

  it('没有端口时返回 null，不臆造默认值', () => {
    // 默认 25565 是别人的端口：填错会让用户放行了错误的规则还查不出原因
    expect(portFromAddress('1.2.3.4')).toBeNull()
    expect(portFromAddress('')).toBeNull()
    expect(portFromAddress(null)).toBeNull()
    expect(portFromAddress(undefined)).toBeNull()
    expect(portFromAddress('1.2.3.4:abc')).toBeNull()
  })
})

describe('可达性四态各有对应说明', () => {
  const states: ReachabilityState[] = ['reachable', 'blocked', 'not_listening', 'no_public_address']

  it('每种状态都有非空结论，且互不相同', () => {
    const summaries = states.map((s) => describeReachability(s, '1.2.3.4:25565').summary)
    for (const s of summaries) expect(s.length).toBeGreaterThan(0)
    expect(new Set(summaries).size).toBe(states.length)
  })

  it('只有 reachable 不给动作（其余三种用户都得做点什么）', () => {
    expect(describeReachability('reachable', '1.2.3.4:25565').action).toBeNull()
    for (const s of states.filter((x) => x !== 'reachable')) {
      expect(describeReachability(s, '1.2.3.4:25565').action).not.toBeNull()
    }
  })

  it('blocked 的动作写进去哪放行、放行哪个端口', () => {
    const { action } = describeReachability('blocked', '1.2.3.4:25567')
    expect(action).toContain('25567')
    expect(action).toContain('安全组')
    expect(action).toContain('控制台')
  })

  it('blocked 且地址里取不到端口时，不给具体端口但仍指出去哪放行', () => {
    const { action } = describeReachability('blocked', '1.2.3.4')
    expect(action).toContain('安全组')
    expect(action).not.toMatch(/TCP \d+/)
  })
})
