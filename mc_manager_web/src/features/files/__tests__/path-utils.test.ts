/**
 * parentDirOf 契约测试（I 类「两处各写一份公式」的技术债收编，见 path-utils.ts 注释）
 * 口径：'/' 前缀风格，根/无斜杠一律归一为 '/'。
 */
import { describe, it, expect } from 'vitest'
import { parentDirOf } from '../path-utils'

describe('parentDirOf', () => {
  it('嵌套路径取上一级', () => {
    expect(parentDirOf('/a/b')).toBe('/a')
    expect(parentDirOf('/a/b/c.txt')).toBe('/a/b')
  })

  it('根目录下一级 → 根（不返回空串）', () => {
    expect(parentDirOf('/a')).toBe('/')
    expect(parentDirOf('/a.txt')).toBe('/')
  })

  it('无斜杠路径 → 根（列表请求的 dir 参数不接受空串）', () => {
    expect(parentDirOf('a.txt')).toBe('/')
    expect(parentDirOf('')).toBe('/')
  })

  it('相对路径取上一级（保留相对语义）', () => {
    expect(parentDirOf('a/b')).toBe('a')
  })
})
