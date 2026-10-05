/**
 * 免确认命令白名单的两处瑕疵。
 *
 * 承重点：这是**安全判据**——放行即意味着「按偏好免二次确认直接下发」。
 * 故两个方向都要钉住：只读命令必须放行（否则用户被无谓打扰），
 * 写命令必须不放行（否则确认偏好被绕过）。
 */
import { describe, it, expect } from 'vitest'
import { isSafeCommand } from '../command-bridge'

describe('免确认白名单', () => {
  it.each([
    ['单个规则名（读该规则；1.21.x 的 camelCase）', 'gamerule keepInventory'],
    ['单个规则名（26.3 起规则名是 snake_case）', 'gamerule keep_inventory'],
    ['带前导斜杠的读规则', '/gamerule keepInventory'],
    ['list', 'list'],
    ['带前导斜杠的 seed', '/seed'],
    ['裸 seed', 'seed'],
    ['tps', 'tps'],
    ['whitelist list', 'whitelist list'],
    ['whitelist show', 'whitelist show'],
    ['say 带内容', 'say 你好'],
    ['version', 'version'],
    ['首尾空白', '  list  '],
  ])('放行只读形态：%s', (_label, cmd) => {
    expect(isSafeCommand(cmd)).toBe(true)
  })

  it.each([
    ['裸 gamerule（实测两版都是 incomplete command，不是只读列表）', 'gamerule'],
    ['带前导斜杠的裸 gamerule', '/gamerule'],
    ['设置规则值（写）', 'gamerule keepInventory true'],
    ['设置规则值（26.3 snake_case 写）', 'gamerule keep_inventory true'],
    ['带斜杠的设置规则值', '/gamerule keepInventory true'],
    ['任意其它命令', 'op Steve'],
    ['带斜杠的任意命令', '/op Steve'],
    ['给玩家物品', 'give Steve diamond 1'],
    ['停服', 'stop'],
  ])('不放行写形态：%s', (_label, cmd) => {
    expect(isSafeCommand(cmd)).toBe(false)
  })

  it('只读列表面走 help（裸 gamerule 不是列表面：实测两版均报 incomplete command）', () => {
    // 曾以为裸 gamerule 是「只读列出全部规则」，实测两个版本都返回
    // `Unknown or incomplete command`；真正的列表面是 /help gamerule
    expect(isSafeCommand('help gamerule')).toBe(true)
    expect(isSafeCommand('gamerule')).toBe(false)
  })

  it('前导斜杠不再造成同一种命令两种待遇（此前只有 seed 容忍斜杠）', () => {
    for (const cmd of ['list', 'tps', 'help', 'seed', 'version']) {
      expect(isSafeCommand(cmd), cmd).toBe(isSafeCommand(`/${cmd}`))
    }
  })
})
