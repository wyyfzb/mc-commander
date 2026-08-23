import { describe, it, expect } from 'vitest'
import { ErrorCode, getFriendlyErrorMessage } from '../errors'

describe('错误码映射（对照服务端 ErrorCodes 契约）', () => {
  it('本地化文案按错误码返回', () => {
    expect(getFriendlyErrorMessage(ErrorCode.INSTANCE_NOT_FOUND)).toBe('服务器实例不存在')
    expect(getFriendlyErrorMessage(ErrorCode.BACKUP_IN_PROGRESS)).toBe('已有备份任务进行中')
    expect(getFriendlyErrorMessage(ErrorCode.RATE_LIMITED)).toBe('请求过于频繁，请稍后再试')
  })

  it('服务端已本地化的错误码透传 message（40902/40904）', () => {
    const serverMessage = '无法执行在线备份：服务器未启用 RCON。请先停止服务器，或在 server.properties 启用 RCON'
    expect(getFriendlyErrorMessage(ErrorCode.BACKUP_RCON_UNAVAILABLE, serverMessage)).toBe(serverMessage)
    expect(getFriendlyErrorMessage(ErrorCode.BACKUP_FORMAT_UNSUPPORTED, '旧格式备份（zip 压缩包）不支持恢复，仅可删除'))
      .toBe('旧格式备份（zip 压缩包）不支持恢复，仅可删除')
  })

  it('未知错误码回退服务端 message 或通用文案', () => {
    expect(getFriendlyErrorMessage(99999, 'Some server message')).toBe('Some server message')
    expect(getFriendlyErrorMessage(99999)).toBe('操作失败（错误码 99999）')
  })

  it('40003 同码场景：玩家不在线的本地化文案', () => {
    expect(getFriendlyErrorMessage(ErrorCode.PLAYER_NOT_ONLINE)).toBe('玩家不在线')
  })
})
