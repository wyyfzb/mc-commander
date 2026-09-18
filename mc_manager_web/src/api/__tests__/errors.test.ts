import { describe, it, expect } from 'vitest'
import { ErrorCode, getFriendlyErrorMessage } from '../errors'

describe('错误码映射（对照服务端 ErrorCodes 契约）', () => {
  it('本地化文案按错误码返回', () => {
    expect(getFriendlyErrorMessage(ErrorCode.INSTANCE_NOT_FOUND)).toBe('服务器实例不存在')
    expect(getFriendlyErrorMessage(ErrorCode.BACKUP_IN_PROGRESS)).toBe('已有备份任务进行中')
    expect(getFriendlyErrorMessage(ErrorCode.RATE_LIMITED)).toBe('请求过于频繁，请稍后再试')
  })

  it('服务端已本地化的错误码透传 message（40902）', () => {
    const serverMessage = '无法执行在线备份：服务器未启用 RCON。请先停止服务器，或在 server.properties 启用 RCON'
    expect(getFriendlyErrorMessage(ErrorCode.BACKUP_RCON_UNAVAILABLE, serverMessage)).toBe(serverMessage)
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

  it('部署取消相关错误码枚举与本地化（与服务端 response.js 同值）', () => {
    expect(ErrorCode.DEPLOY_NOT_IN_FLIGHT).toBe(40906)
    expect(ErrorCode.TASK_CANCELLED).toBe(40915)
    expect(getFriendlyErrorMessage(ErrorCode.DEPLOY_NOT_IN_FLIGHT)).toBe('该部署已结束或不在进行中，无需取消')
    expect(getFriendlyErrorMessage(ErrorCode.TASK_CANCELLED)).toBe('操作已取消')
  })

  it('备份恢复确认与空名卸载错误码枚举与本地化（与服务端 response.js 同值）', () => {
    expect(ErrorCode.BACKUP_RESTORE_CONFIRM_REQUIRED).toBe(40017)
    expect(ErrorCode.INSTANCE_DELETE_UNNAMED).toBe(40916)
    expect(getFriendlyErrorMessage(ErrorCode.BACKUP_RESTORE_CONFIRM_REQUIRED)).toBe(
      '需输入该备份所属实例的名称以确认恢复',
    )
    expect(getFriendlyErrorMessage(ErrorCode.INSTANCE_DELETE_UNNAMED)).toContain('该实例无名称')
  })

  it('INSTANCE_RUNNING 有本地化文案', () => {
    expect(getFriendlyErrorMessage(ErrorCode.INSTANCE_RUNNING)).toBe('实例正在运行')
  })

  it('401 定向文案：未提供凭据（40107）与凭据无效（40101）分开', () => {
    expect(ErrorCode.AUTH_CREDENTIALS_REQUIRED).toBe(40107)
    expect(ErrorCode.INVALID_API_KEY).toBe(40101)
    const required = getFriendlyErrorMessage(ErrorCode.AUTH_CREDENTIALS_REQUIRED)
    const invalid = getFriendlyErrorMessage(ErrorCode.INVALID_API_KEY)
    expect(required).toBe('尚未提供访问凭据：请在设置页配置 API Key，或登录本面板')
    expect(invalid).toBe('API Key 无效或已过期')
    // 处置动作不同：一个是「去配置/登录」，一个是「核对或轮换 Key」——文案不得合并
    expect(required).not.toBe(invalid)
  })

  it('40000 携带 details 数组时拼接字段级错误文案', () => {
    const details = [
      { path: 'mcVersion', code: 'invalid_type', message: 'Required' },
      { path: 'name', code: 'too_small', message: 'Too short' },
    ]
    expect(getFriendlyErrorMessage(ErrorCode.VALIDATION_ERROR, 'name Required; mcVersion Required', details)).toBe(
      '请求参数校验失败：mcVersion Required；name Too short'
    )
  })

  it('40000 无 details / 空 details / 非法 details 时维持通用文案（链路不破坏）', () => {
    expect(getFriendlyErrorMessage(ErrorCode.VALIDATION_ERROR, 'name Required')).toBe('请求参数校验失败')
    expect(getFriendlyErrorMessage(ErrorCode.VALIDATION_ERROR, undefined, [])).toBe('请求参数校验失败')
    expect(getFriendlyErrorMessage(ErrorCode.VALIDATION_ERROR, undefined, 'not-an-array')).toBe('请求参数校验失败')
    expect(getFriendlyErrorMessage(ErrorCode.VALIDATION_ERROR, undefined, [null, 42])).toBe('请求参数校验失败')
  })

  it('40000 details 缺 path/message 字段时逐项降级拼接', () => {
    expect(getFriendlyErrorMessage(ErrorCode.VALIDATION_ERROR, undefined, [{ path: 'mcVersion' }, { message: 'Required' }])).toBe(
      '请求参数校验失败：mcVersion；Required'
    )
  })

  it('非 40000 错误即使带 details 也不拼接（行为不变）', () => {
    expect(getFriendlyErrorMessage(ErrorCode.INSTANCE_NOT_FOUND, undefined, [{ path: 'id', message: 'Required' }])).toBe(
      '服务器实例不存在'
    )
  })
})
