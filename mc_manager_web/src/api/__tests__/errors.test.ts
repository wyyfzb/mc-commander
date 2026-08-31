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

  it('40003 碰撞已消除：INSTANCE_RUNNING 独占 40003', () => {
    // 40003 曾经与 PLAYER_NOT_ONLINE 碰撞，现已拆分
    // PLAYER_NOT_ONLINE 已随僵尸码清理移除，40003 仅 INSTANCE_RUNNING 使用
    expect(ErrorCode.INSTANCE_RUNNING).toBe(40003)
    // 确认不再有其他枚举值映射到 40003
    const values = Object.values(ErrorCode)
    const count40003 = values.filter(v => v === 40003).length
    expect(count40003).toBe(1)
  })

  it('新增升级错误码枚举与本地化', () => {
    expect(ErrorCode.UPGRADE_IN_PROGRESS).toBe(40907)
    expect(ErrorCode.UPGRADE_VERSION_SAME).toBe(40012)
    expect(getFriendlyErrorMessage(ErrorCode.UPGRADE_IN_PROGRESS)).toBe('已有升级任务进行中')
    expect(getFriendlyErrorMessage(ErrorCode.UPGRADE_VERSION_SAME)).toBe('目标版本与当前版本相同')
  })

  it('INSTANCE_RUNNING 有本地化文案', () => {
    expect(getFriendlyErrorMessage(ErrorCode.INSTANCE_RUNNING)).toBe('实例正在运行')
  })
})
