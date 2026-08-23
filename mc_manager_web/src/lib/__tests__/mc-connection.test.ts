/**
 * mc-connection 单测：normalizeBaseUrl / isInternalHost / needsHttpPlaintextWarning
 */
import { describe, expect, it } from 'vitest'
import { isInternalHost, needsHttpPlaintextWarning, normalizeBaseUrl } from '../mc-connection'

describe('normalizeBaseUrl', () => {
  it('无协议输入默认补 https', () => {
    expect(normalizeBaseUrl('192.168.1.100:25566')).toBe('https://192.168.1.100:25566')
    expect(normalizeBaseUrl('example.com')).toBe('https://example.com')
  })

  it('已有协议保持不变', () => {
    expect(normalizeBaseUrl('http://192.168.1.100')).toBe('http://192.168.1.100')
    expect(normalizeBaseUrl('https://example.com')).toBe('https://example.com')
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
