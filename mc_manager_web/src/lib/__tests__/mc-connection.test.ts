/**
 * mc-connection 单测：normalizeBaseUrl / panelAddress / sessionAppliesToPanel /
 * isInternalHost / needsHttpPlaintextWarning
 */
import { describe, expect, it } from 'vitest'
import {
  isInternalHost,
  needsHttpPlaintextWarning,
  normalizeBaseUrl,
  panelAddress,
  sessionAppliesToPanel,
} from '../mc-connection'

describe('normalizeBaseUrl', () => {
  it('无协议输入默认补 https', () => {
    expect(normalizeBaseUrl('192.168.1.100:25566')).toBe('https://192.168.1.100:25566')
    expect(normalizeBaseUrl('example.com')).toBe('https://example.com')
  })

  it('已有协议保持不变', () => {
    expect(normalizeBaseUrl('http://192.168.1.100')).toBe('http://192.168.1.100')
    expect(normalizeBaseUrl('https://example.com')).toBe('https://example.com')
  })

  it('协议前缀大小写不敏感（大写 HTTPS 不再被二次补协议，避免拼出 https://HTTPS://…）', () => {
    expect(normalizeBaseUrl('HTTPS://panel.example.com')).toBe('HTTPS://panel.example.com')
    expect(normalizeBaseUrl('HTTP://panel.example.com/')).toBe('HTTP://panel.example.com')
  })

  it('去尾斜杠', () => {
    expect(normalizeBaseUrl('https://example.com/')).toBe('https://example.com')
    expect(normalizeBaseUrl('https://example.com')).toBe('https://example.com')
  })

  it('trim 首尾空白', () => {
    expect(normalizeBaseUrl('  https://example.com  ')).toBe('https://example.com')
  })
})

describe('isInternalHost', () => {
  it('本机名与 IPv6 回环', () => {
    expect(isInternalHost('localhost')).toBe(true)
    expect(isInternalHost('LOCALHOST')).toBe(true)
    expect(isInternalHost('::1')).toBe(true)
  })

  it('回环段 127.0.0.0/8', () => {
    expect(isInternalHost('127.0.0.1')).toBe(true)
    expect(isInternalHost('127.255.255.254')).toBe(true)
  })

  it('内网段 10/8、192.168/16、172.16-31/12', () => {
    expect(isInternalHost('10.0.0.1')).toBe(true)
    expect(isInternalHost('192.168.1.100')).toBe(true)
    expect(isInternalHost('172.16.0.1')).toBe(true)
    expect(isInternalHost('172.31.255.255')).toBe(true)
  })

  it('172 段边界外与公网地址为 false', () => {
    expect(isInternalHost('172.15.0.1')).toBe(false)
    expect(isInternalHost('172.32.0.1')).toBe(false)
    expect(isInternalHost('203.0.113.5')).toBe(false) // RFC 5737 文档保留地址
    expect(isInternalHost('198.51.100.7')).toBe(false)
  })

  it('非 IPv4 主机名（域名）为 false', () => {
    expect(isInternalHost('mc.example.com')).toBe(false)
  })
})

describe('needsHttpPlaintextWarning', () => {
  it('公网 http 触发警告', () => {
    expect(needsHttpPlaintextWarning('http://203.0.113.5:25566')).toBe(true)
    expect(needsHttpPlaintextWarning('http://mc.example.com')).toBe(true)
  })

  it('内网/本机 http 不触发（局域网自建不打扰）', () => {
    expect(needsHttpPlaintextWarning('http://192.168.1.100:25566')).toBe(false)
    expect(needsHttpPlaintextWarning('http://localhost:25566')).toBe(false)
    expect(needsHttpPlaintextWarning('http://10.0.0.1')).toBe(false)
    expect(needsHttpPlaintextWarning('http://172.20.0.1')).toBe(false)
  })

  it('https 一律不触发', () => {
    expect(needsHttpPlaintextWarning('https://mc.example.com')).toBe(false)
    expect(needsHttpPlaintextWarning('https://203.0.113.5')).toBe(false)
  })

  it('非法 URL 不触发（不崩溃）', () => {
    expect(needsHttpPlaintextWarning('')).toBe(false)
    expect(needsHttpPlaintextWarning('not a url')).toBe(false)
  })
})

describe('panelAddress（面板身份）', () => {
  it('空地址＝同源部署，取当前站点根', () => {
    expect(panelAddress('')).toBe(window.location.origin)
    expect(panelAddress('   ')).toBe(window.location.origin)
  })

  it('无协议输入按 https 归一（与 normalizeBaseUrl 同口径）', () => {
    expect(panelAddress('panel.example.com:25566')).toBe('https://panel.example.com:25566')
  })

  it('大小写与尾斜杠归一为同一面板', () => {
    expect(panelAddress('https://Panel.Example.com/')).toBe('https://panel.example.com')
    expect(panelAddress('HTTPS://panel.example.com')).toBe('https://panel.example.com')
  })

  it('路径保留：同一主机的不同子路径是两个面板', () => {
    expect(panelAddress('https://panel.example.com/mc/')).toBe('https://panel.example.com/mc')
    expect(panelAddress('https://panel.example.com/other')).toBe('https://panel.example.com/other')
  })

  it('路径大小写不折叠（大小写敏感的服务端上 /MC 与 /mc 是两块面板）', () => {
    expect(panelAddress('https://panel.example.com/MC')).toBe('https://panel.example.com/MC')
    expect(panelAddress('https://panel.example.com/MC')).not.toBe(
      panelAddress('https://panel.example.com/mc'),
    )
  })

  it('协议与端口参与身份（http/https、不同端口都不算同一面板）', () => {
    expect(panelAddress('http://panel.example.com')).not.toBe(panelAddress('https://panel.example.com'))
    expect(panelAddress('https://panel.example.com:25566')).not.toBe(panelAddress('https://panel.example.com'))
  })
})

describe('sessionAppliesToPanel（会话是否属于目标面板）', () => {
  const session = { token: 'tok-1', issuedFor: 'https://panel-a.example.com' }

  it('无会话 → 不适用', () => {
    expect(sessionAppliesToPanel(null, 'https://panel-a.example.com')).toBe(false)
  })

  it('签发面板一致 → 适用（归一后比较）', () => {
    expect(sessionAppliesToPanel(session, 'https://Panel-A.example.com/')).toBe(true)
  })

  it('地址不同 → 不适用', () => {
    expect(sessionAppliesToPanel(session, 'https://panel-b.example.com')).toBe(false)
    expect(sessionAppliesToPanel(session, '')).toBe(false)
  })

  it('旧会话（无签发面板信息）按适用处理：宽限到下次登录', () => {
    expect(sessionAppliesToPanel({ token: 'tok-legacy' }, 'https://panel-b.example.com')).toBe(true)
  })

  it('有 token 但签发面板为空串 → 按旧会话口径兜底', () => {
    expect(sessionAppliesToPanel({ token: 'tok-1', issuedFor: '' }, 'https://panel-b.example.com')).toBe(true)
  })
})
