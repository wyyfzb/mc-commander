/**
 * BanDialog 自定义理由脏状态关闭拦截测试（issue #347）：
 * 「其他」理由有未提交输入时取消/ESC 需确认（继续编辑保留 / 放弃修改关闭）；
 * 无输入、纯空白、切回预设理由（无提交风险）时直接关闭。
 * mock 数据为结构占位（虚构玩家 Steve），严禁真实玩家/服务器信息
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BanDialog } from '../ban-dialog'
import type { Player } from '@/api/types'

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    name: 'Steve',
    uuid: '00000000-0000-4000-8000-000000000002',
    isOnline: true,
    ip: '1.2.3.4',
    joinTime: null,
    onlineTime: 0,
    totalPlayTime: 0,
    isOp: false,
    isWhitelisted: false,
    isBanned: false,
    banExpiresAt: null,
    isIpBanned: false,
    ipBanExpiresAt: null,
    isFakePlayer: false,
    lastSeen: '',
    health: null,
    maxHealth: null,
    hunger: null,
    xpLevel: null,
    spawnPoint: null,
    respawnPoint: null,
    position: null,
    gameMode: 'survival',
    dimension: 'overworld',
    armor: null,
    xpProgress: null,
    ping: null,
    isSleeping: false,
    isAfk: false,
    isFlying: false,
    isSneaking: false,
    isSprinting: false,
    isBurning: false,
    isFrozen: false,
    potionEffects: [],
    ipHistory: [],
    inventory: null,
    events: [],
    sessions: [],
    stats: {
      totalOnline: 0,
      loginCount: 0,
      offlineSince: 0,
      deathCount: 0,
      achievementCount: 0,
      sleepCount: 0,
    },
    ...overrides,
  }
}

function renderDialog() {
  const onOpenChange = vi.fn()
  const onConfirm = vi.fn().mockResolvedValue(undefined)
  render(<BanDialog open onOpenChange={onOpenChange} player={makePlayer()} onConfirm={onConfirm} />)
  return { onOpenChange, onConfirm }
}

async function typeCustomReason(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByRole('radio', { name: '其他' }))
  await user.type(screen.getByPlaceholderText(/自定义理由/), text)
}

/** dirty 确认弹窗定位（嵌套 Dialog 时外层内容可能 aria-hidden，逐层找标题） */
async function findConfirmDialog() {
  const dialogs = await screen.findAllByRole('dialog')
  const confirm = dialogs.find((d) => within(d).queryByText('放弃未保存的修改？'))
  expect(confirm).toBeDefined()
  return confirm!
}

describe('BanDialog 干净状态关闭', { timeout: 15000 }, () => {
  it('无自定义输入：取消直接关闭，不弹确认', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByText('放弃未保存的修改？')).not.toBeInTheDocument()
  })

  it('切到「其他」但未输入：取消直接关闭（空输入回退默认理由，无可丢失内容）', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog()
    await user.click(screen.getByRole('radio', { name: '其他' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByText('放弃未保存的修改？')).not.toBeInTheDocument()
  })
})

describe('BanDialog 自定义理由关闭拦截', { timeout: 15000 }, () => {
  it('有输入时取消需确认：继续编辑保留，放弃修改才关闭', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog()
    await typeCustomReason(user, '用语不当')
    await user.click(screen.getByRole('button', { name: '取消' }))
    const confirm = await findConfirmDialog()
    expect(onOpenChange).not.toHaveBeenCalled()
    // 继续编辑 → 确认关闭，输入保留
    await user.click(within(confirm).getByRole('button', { name: '继续编辑' }))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText(/自定义理由/)).toHaveValue('用语不当')
    // 再次取消 → 放弃修改 → onOpenChange(false)
    await user.click(screen.getByRole('button', { name: '取消' }))
    const confirm2 = await findConfirmDialog()
    await user.click(within(confirm2).getByRole('button', { name: '放弃修改' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('有输入时按 ESC 需确认；继续编辑不关闭', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog()
    await typeCustomReason(user, '恶意搭建')
    await user.keyboard('{Escape}')
    const confirm = await findConfirmDialog()
    await user.click(within(confirm).getByRole('button', { name: '继续编辑' }))
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('输入后切回预设理由：提交不依赖自定义输入，取消直接关闭', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog()
    await typeCustomReason(user, '用语不当')
    await user.click(screen.getByRole('radio', { name: '作弊' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByText('放弃未保存的修改？')).not.toBeInTheDocument()
  })

  it('纯空白输入视为无改动：取消直接关闭', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog()
    await typeCustomReason(user, '   ')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByText('放弃未保存的修改？')).not.toBeInTheDocument()
  })

  describe('BanDialog 单选组键盘模型', { timeout: 15000 }, () => {
    it('时长/理由是单选组：方向键移动即选中且焦点跟随（含回绕）', () => {
      renderDialog()

      const durationGroup = screen.getByRole('radiogroup', { name: '封禁时长' })
      const durations = within(durationGroup).getAllByRole('radio')
      expect(durations[0]).toHaveAttribute('aria-checked', 'true')
      expect(durations[0]).toHaveAttribute('tabindex', '0')
      fireEvent.keyDown(durationGroup, { key: 'ArrowRight' })
      expect(durations[1]).toHaveAttribute('aria-checked', 'true')
      expect(document.activeElement).toBe(durations[1])

      const reasonGroup = screen.getByRole('radiogroup', { name: '封禁理由' })
      const reasons = within(reasonGroup).getAllByRole('radio')
      expect(reasons[0]).toHaveAttribute('aria-checked', 'true')
      fireEvent.keyDown(reasonGroup, { key: 'ArrowLeft' }) // 首项左移回绕到末项
      expect(reasons[reasons.length - 1]).toHaveAttribute('aria-checked', 'true')
    })
  })
})
