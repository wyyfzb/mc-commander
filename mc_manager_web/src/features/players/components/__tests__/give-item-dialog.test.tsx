/**
 * GiveItemPanel 测试（给予物品大表单）：
 * 物品选择/搜索/药水分类/数量/快速档/附魔面板（冲突禁用+等级）/药水面板（瓶型+等级+时长+瞬时）/
 * 命令预览/RCON 守卫/单个与批量执行链路/礼包 Tab（应用/缺失跳过/新建/编辑/删除/持久化）
 * mock 数据为结构占位（虚构玩家 Steve/Alex），严禁真实玩家/服务器信息
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
// 性能说明：普通按钮/输入交互统一 fireEvent（无 pointer 事件序列/逐字符延迟），本文件从 40s → 数秒；
// radix 的 Select/Dropdown/Tabs 打开依赖 pointerdown 序列，相关交互仍用 userEvent
import { Toaster, toast as sonnerToast } from 'sonner'
import { GiveItemPanel } from '../give-item-dialog'
import { MINECRAFT_ITEMS } from '@/lib/mc-items'
import { MINECRAFT_POTIONS } from '@/lib/mc-potions'
import { DEFAULT_KITS, KITS_STORAGE_KEY, type KitPreset } from '@/lib/mc-kits'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../../mutations'

// ── 结构占位 mock ────────────────────────────────────────────────

function makePlayer(name: string, overrides: Partial<Player> = {}): Player {
  return {
    name,
    uuid: '00000000-0000-4000-8000-000000000001',
    isOnline: true,
    ip: '',
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

interface RenderOptions {
  player?: Player | null
  batchTargets?: Player[]
  isBatchMode?: boolean
  isRconConnected?: boolean
  mcVersion?: string
  onAction?: (req: PlayerActionRequest) => Promise<void>
  onDone?: () => void
}

function renderPanel(opts: RenderOptions = {}) {
  const steve = makePlayer('Steve')
  const player = opts.player === undefined ? (opts.isBatchMode ? null : steve) : opts.player
  const batchTargets = opts.batchTargets ?? (opts.isBatchMode ? [] : [steve])
  const onAction = opts.onAction ?? vi.fn().mockResolvedValue(undefined)
  const onDone = opts.onDone ?? vi.fn()
  render(
    <>
      <GiveItemPanel
        player={player}
        batchTargets={batchTargets}
        isBatchMode={opts.isBatchMode ?? false}
        instanceId="demo"
        mcVersion={opts.mcVersion ?? '1.21.2'}
        isRconConnected={opts.isRconConnected ?? true}
        onAction={onAction}
        onDone={onDone}
      />
      <Toaster />
    </>,
  )
  return { onAction, onDone }
}

/** 礼包可解析物品统计（目录外 id 静默跳过语义） */
function kitResolvable(kit: KitPreset): { kinds: number; total: number } {
  let kinds = 0
  let total = 0
  for (const entry of kit.items) {
    if (MINECRAFT_ITEMS.some((i) => i.id === entry.id)) {
      kinds += 1
      total += entry.count
    }
  }
  return { kinds, total }
}

// jsdom 未实现 Pointer Capture API（radix Select/下拉依赖，缺失会崩溃）
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

beforeEach(() => {
  localStorage.clear()
  // sonner toast 存于模块级 store，跨测试残留会导致同文案 toast 重复匹配
  sonnerToast.dismiss()
})

// ── 物品选择与搜索 ────────────────────────────────────────────────

describe('GiveItemPanel 物品选择与搜索', { timeout: 15000 }, () => {
  it('默认渲染：主 Tab / 搜索框 / 分类 / 物品网格 / 空态页脚', () => {
    renderPanel()
    expect(screen.getByRole('tab', { name: '物品选择' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '预设礼包' })).toBeInTheDocument()
    expect(screen.getByLabelText('搜索物品')).toBeInTheDocument()
    expect(
      screen.getByText(`找到 ${MINECRAFT_ITEMS.length + MINECRAFT_POTIONS.length} 个物品`),
    ).toBeInTheDocument()
    expect(screen.getByTestId('item-cell-diamond')).toBeInTheDocument()
    expect(screen.getByText('请点击上方物品添加')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '给予' })).toBeDisabled()
  })

  it('搜索按名称/ID 过滤并显示匹配数；清空恢复', async () => {
    renderPanel()
    const expected = MINECRAFT_ITEMS.filter((i) => i.name.includes('钻石')).length
    fireEvent.change(screen.getByLabelText('搜索物品'), { target: { value: '钻石' } })
    expect(screen.getByText(`找到 ${expected} 个物品`)).toBeInTheDocument()
    expect(screen.getByTestId('item-cell-diamond_sword')).toBeInTheDocument()
    expect(screen.queryByTestId('item-cell-stone')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('清空搜索'))
    expect(screen.getByTestId('item-cell-stone')).toBeInTheDocument()
  })

  it('搜索无匹配显示空态', async () => {
    renderPanel()
    fireEvent.change(screen.getByLabelText('搜索物品'), { target: { value: '不存在的物品xyz' } })
    expect(screen.getByText('没有找到匹配的物品')).toBeInTheDocument()
  })

  it('「药水」分类渲染 20 种效果虚拟物品（效果色块+名称）', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '药水' }))
    expect(screen.getByText(`找到 ${MINECRAFT_POTIONS.length} 个物品`)).toBeInTheDocument()
    expect(screen.getByTestId('potion-dot-swiftness')).toBeInTheDocument()
    expect(screen.getByTestId('potion-dot-instant_health')).toBeInTheDocument()
    // 效果色块为游戏数据色（RGB int → #rrggbb）
    const swiftness = MINECRAFT_POTIONS.find((e) => e.effectId === 'swiftness')!
    const hex = `#${swiftness.color.toString(16).padStart(6, '0')}`
    expect(screen.getByTestId('potion-dot-swiftness')).toHaveStyle({ backgroundColor: hex })
    // 普通物品不再显示
    expect(screen.queryByTestId('item-cell-diamond')).not.toBeInTheDocument()
  })

  it('点击物品卡片：选中态 + 已选 chip + 摘要 + 给予启用', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    expect(screen.getByTestId('selected-chip-diamond')).toBeInTheDocument()
    expect(screen.getByText('已选 1 种物品，共 1 个')).toBeInTheDocument()
    expect(screen.getByText('将执行 1 条 give 命令')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '给予 (1)' })).toBeEnabled()
  })

  it('数量 −/+：clamp 1-6400，减到 0 移除', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByLabelText('增加 钻石 数量'))
    fireEvent.click(screen.getByLabelText('增加 钻石 数量'))
    expect(screen.getByText('已选 1 种物品，共 3 个')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('减少 钻石 数量'))
    fireEvent.click(screen.getByLabelText('减少 钻石 数量'))
    fireEvent.click(screen.getByLabelText('减少 钻石 数量'))
    expect(screen.queryByTestId('selected-chip-diamond')).not.toBeInTheDocument()
    expect(screen.getByText('请点击上方物品添加')).toBeInTheDocument()
  })

  it('快速数量档 1/16/64/256/640/6400，6400 封顶', async () => {
    const user = userEvent.setup()
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    // radix DropdownMenu 仅 pointerdown 打开 → userEvent
    await user.click(screen.getByLabelText('钻石 快速数量'))
    await user.click(screen.getByRole('menuitem', { name: '6400' }))
    expect(screen.getByText('已选 1 种物品，共 6400 个')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('增加 钻石 数量'))
    expect(screen.getByText('已选 1 种物品，共 6400 个')).toBeInTheDocument()
  })

  it('删除按钮移除已选物品', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-bread'))
    fireEvent.click(screen.getByLabelText('移除 面包'))
    expect(screen.queryByTestId('selected-chip-bread')).not.toBeInTheDocument()
    expect(screen.getByText('请点击上方物品添加')).toBeInTheDocument()
  })

  it('清空全部已选按钮：一键清空并回到空态', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByTestId('item-cell-bread'))
    fireEvent.click(screen.getByRole('button', { name: '清空已选物品' }))
    expect(screen.queryByTestId('selected-chip-diamond')).not.toBeInTheDocument()
    expect(screen.queryByTestId('selected-chip-bread')).not.toBeInTheDocument()
    expect(screen.getByText('请点击上方物品添加')).toBeInTheDocument()
  })
})

// ── 附魔面板 ─────────────────────────────────────────────────────

describe('GiveItemPanel 附魔面板', { timeout: 15000 }, () => {
  function openEnchantPanel() {
    fireEvent.click(screen.getByTestId('item-cell-diamond_sword'))
    fireEvent.click(screen.getByLabelText('钻石剑 附魔设置'))
  }

  it('展开附魔面板：可用附魔列表 + 等级范围 + Lv.1 显示', async () => {
    renderPanel()
    openEnchantPanel()
    expect(screen.getByText('附魔 · 钻石剑')).toBeInTheDocument()
    expect(screen.getByText('锋利')).toBeInTheDocument()
    expect(screen.getByText('耐久')).toBeInTheDocument()
    expect(screen.getAllByText('I-V').length).toBeGreaterThan(0) // 锋利等 1-5 范围
    // maxLevel=2 的火焰附加：开关打开后出现等级下拉
    fireEvent.click(screen.getByLabelText('火焰附加 附魔开关'))
    const levelSelect = screen.getByRole('combobox', { name: '火焰附加 等级' })
    expect(levelSelect).toHaveTextContent('1')
    fireEvent.click(levelSelect)
    fireEvent.click(screen.getByRole('option', { name: '2' }))
    expect(screen.getByRole('combobox', { name: '火焰附加 等级' })).toHaveTextContent('2')
    // maxLevel=1 的经验修补：显示 Lv.1
    fireEvent.click(screen.getByLabelText('经验修补 附魔开关'))
    expect(screen.getByText('Lv.1')).toBeInTheDocument()
    // 附魔数量角标
    expect(screen.getByText('附2')).toBeInTheDocument()
  })

  it('冲突附魔禁用（锋利↔亡灵杀手），解除冲突后恢复', async () => {
    renderPanel()
    openEnchantPanel()
    expect(screen.getByRole('switch', { name: '亡灵杀手 附魔开关' })).toBeEnabled()
    fireEvent.click(screen.getByLabelText('锋利 附魔开关'))
    expect(screen.getByRole('switch', { name: '亡灵杀手 附魔开关' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('锋利 附魔开关'))
    expect(screen.getByRole('switch', { name: '亡灵杀手 附魔开关' })).toBeEnabled()
  })

  it('附魔命令预览实时更新 + 复制按钮', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderPanel()
    openEnchantPanel()
    // 面板展开时主预览区跳过该条目（防重复渲染），仅面板内预览一处
    expect(screen.getAllByTestId('command-preview')).toHaveLength(1)
    expect(screen.queryByTestId('command-previews')).toBeEmptyDOMElement()
    fireEvent.click(screen.getByLabelText('锋利 附魔开关'))
    // 预览随配置实时更新
    for (const p of screen.getAllByTestId('command-preview')) {
      expect(p).toHaveTextContent('[enchantments={"minecraft:sharpness":1}]')
    }
    fireEvent.click(screen.getAllByLabelText('复制命令')[0]!)
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":1}] 1',
      ),
    )
    expect(await screen.findByText('命令已复制')).toBeInTheDocument()
  })
})

// ── 药水面板 ─────────────────────────────────────────────────────

describe('GiveItemPanel 药水面板', { timeout: 15000 }, () => {
  function openPotionPanel(effectId = 'swiftness') {
    fireEvent.click(screen.getByRole('button', { name: '药水' }))
    fireEvent.click(screen.getByTestId(`item-cell-${effectId}`))
    fireEvent.click(screen.getByLabelText(`${MINECRAFT_POTIONS.find((e) => e.effectId === effectId)!.name} 药水配置`))
  }

  it('瓶型/等级/时长三 Select + 命令预览实时更新', async () => {
    renderPanel()
    openPotionPanel()
    expect(screen.getByText('药水 · 迅捷')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '瓶型' })).toHaveTextContent('饮用药水')
    expect(screen.getByRole('combobox', { name: '效果等级' })).toHaveTextContent('I')
    expect(screen.getByRole('combobox', { name: '时长' })).toHaveTextContent('普通 3:00')
    // 面板展开时主预览区跳过该条目，仅药水面板内预览一处，含效果组件
    expect(screen.getAllByTestId('command-preview')).toHaveLength(1)
    for (const p of screen.getAllByTestId('command-preview')) {
      expect(p).toHaveTextContent('minecraft:swiftness')
      expect(p).toHaveTextContent('custom_effects')
    }
    // 切换瓶型 → 命令使用喷溅药水 id
    fireEvent.click(screen.getByRole('combobox', { name: '瓶型' }))
    fireEvent.click(screen.getByRole('option', { name: '喷溅药水' }))
    for (const p of screen.getAllByTestId('command-preview')) {
      expect(p).toHaveTextContent('minecraft:splash_potion')
    }
  })

  it('等级切换重置时长；超原版上限标「自定义」', async () => {
    renderPanel()
    openPotionPanel()
    // 等级 II → 强效 1:30
    fireEvent.click(screen.getByRole('combobox', { name: '效果等级' }))
    fireEvent.click(screen.getByRole('option', { name: 'II' }))
    expect(screen.getByRole('combobox', { name: '时长' })).toHaveTextContent('强效 1:30')
    // 等级 III → 自定义 + 时长重置为 30秒
    fireEvent.click(screen.getByRole('combobox', { name: '效果等级' }))
    fireEvent.click(screen.getByRole('option', { name: 'III·自定义' }))
    expect(screen.getByRole('combobox', { name: '时长' })).toHaveTextContent('30秒')
    expect(screen.getByText('等级 III（自定义）')).toBeInTheDocument()
  })

  it('瞬时效果（治疗）：无时长档 + duration=1tick 提示', async () => {
    renderPanel()
    openPotionPanel('instant_health')
    expect(screen.getByText(/瞬时效果（duration=1tick）/)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '时长' })).not.toBeInTheDocument()
  })

  it('附魔面板与药水面板互斥展开（同时仅一个）', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond_sword'))
    fireEvent.click(screen.getByLabelText('钻石剑 附魔设置'))
    expect(screen.getByText('附魔 · 钻石剑')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '药水' }))
    fireEvent.click(screen.getByTestId('item-cell-swiftness'))
    fireEvent.click(screen.getByLabelText('迅捷 药水配置'))
    expect(screen.getByText('药水 · 迅捷')).toBeInTheDocument()
    expect(screen.queryByText('附魔 · 钻石剑')).not.toBeInTheDocument()
  })
})

// ── 执行链路 ─────────────────────────────────────────────────────

describe('GiveItemPanel 执行链路', { timeout: 15000 }, () => {
  it('RCON 守卫：附魔物品未连接 RCON → 提示并中止', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({ isRconConnected: false, onAction })
    fireEvent.click(screen.getByTestId('item-cell-diamond_sword'))
    fireEvent.click(screen.getByLabelText('钻石剑 附魔设置'))
    fireEvent.click(screen.getByLabelText('锋利 附魔开关'))
    fireEvent.click(screen.getByRole('button', { name: '给予 (1)' }))
    expect(
      await screen.findByText('附魔物品给予需启用 RCON，请检查实例 RCON 配置'),
    ).toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('RCON 守卫：药水物品未连接 RCON → 提示并中止', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({ isRconConnected: false, onAction })
    fireEvent.click(screen.getByRole('button', { name: '药水' }))
    fireEvent.click(screen.getByTestId('item-cell-swiftness'))
    fireEvent.click(screen.getByRole('button', { name: '给予 (1)' }))
    expect(
      await screen.findByText('附魔/药水物品给予需启用 RCON，请检查实例 RCON 配置'),
    ).toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('附魔物品 + RCON 已连接：正常执行附魔命令', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({ onAction })
    fireEvent.click(screen.getByTestId('item-cell-diamond_sword'))
    fireEvent.click(screen.getByLabelText('钻石剑 附魔设置'))
    fireEvent.click(screen.getByLabelText('锋利 附魔开关'))
    fireEvent.click(screen.getByRole('button', { name: '给予 (1)' }))
    expect(await screen.findByText('已给予 Steve 1 种物品')).toBeInTheDocument()
    expect(onAction).toHaveBeenCalledWith({
      kind: 'command',
      command: 'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":1}] 1',
    })
  })

  it('单个模式：逐条执行 + 成功 toast + onDone', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    const onDone = vi.fn()
    renderPanel({ onAction, onDone })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByTestId('item-cell-bread'))
    fireEvent.click(screen.getByRole('button', { name: '给予 (2)' }))
    expect(await screen.findByText('已给予 Steve 2 种物品')).toBeInTheDocument()
    expect(onAction).toHaveBeenCalledTimes(2)
    expect(onAction).toHaveBeenNthCalledWith(1, {
      kind: 'command',
      command: 'give Steve minecraft:diamond 1',
    })
    expect(onAction).toHaveBeenNthCalledWith(2, {
      kind: 'command',
      command: 'give Steve minecraft:bread 1',
    })
    expect(onDone).toHaveBeenCalled()
  })

  it('单个模式：失败单条 toast（不影响其余执行）', async () => {
    const onAction = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    renderPanel({ onAction })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByTestId('item-cell-bread'))
    fireEvent.click(screen.getByRole('button', { name: '给予 (2)' }))
    expect(await screen.findByText('钻石 给予失败：网络错误')).toBeInTheDocument()
    expect(await screen.findByText('已给予 Steve 1 种物品')).toBeInTheDocument()
  })

  it('批量模式：在线执行 / 离线跳过 + 汇总 toast（不逐条提示）', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({
      isBatchMode: true,
      batchTargets: [makePlayer('Steve'), makePlayer('Alex', { isOnline: false })],
      onAction,
    })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByRole('button', { name: '给予 (1)' }))
    // 批量需一次性确认后才发送命令
    expect(onAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认给予' }))
    expect(
      await screen.findByText('批量给予完成：成功 1，失败 0，跳过离线 1'),
    ).toBeInTheDocument()
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({
      kind: 'command',
      command: 'give Steve minecraft:diamond 1',
    })
  })

  it('批量模式：确认弹窗取消时不发送任何命令', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({
      isBatchMode: true,
      batchTargets: [makePlayer('Steve')],
      onAction,
    })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByRole('button', { name: '给予 (1)' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.queryByText('批量给予完成：成功 1，失败 0，跳过离线 0')).not.toBeInTheDocument()
  })

  it('批量模式：全部离线不执行任何命令', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({
      isBatchMode: true,
      batchTargets: [makePlayer('Alex', { isOnline: false })],
      onAction,
    })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByRole('button', { name: '给予 (1)' }))
    expect(await screen.findByText('所选玩家均已离线，无法执行')).toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })
})

// ── 预设礼包 ─────────────────────────────────────────────────────

describe('GiveItemPanel 预设礼包', { timeout: 15000 }, () => {
  async function openKitsTab(user: ReturnType<typeof userEvent.setup>) {
    // radix Tabs 激活依赖 pointerdown 序列，fireEvent 打不开 → 保留 userEvent
    await user.click(screen.getByRole('tab', { name: '预设礼包' }))
  }

  it('默认礼包 Tab：6 个默认礼包卡 + 新建礼包卡', async () => {
    const user = userEvent.setup()
    renderPanel()
    await openKitsTab(user)
    for (const kit of DEFAULT_KITS) {
      expect(screen.getByTestId(`kit-card-${kit.name}`)).toBeInTheDocument()
      expect(screen.getByText(kit.desc)).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: /新建礼包/ })).toBeInTheDocument()
  })

  it('应用礼包：已选增加 + 切回物品 Tab + toast', async () => {
    const user = userEvent.setup()
    renderPanel()
    await openKitsTab(user)
    const kit = DEFAULT_KITS[0]!
    const { kinds, total } = kitResolvable(kit)
    fireEvent.click(
      within(screen.getByTestId(`kit-card-${kit.name}`)).getByRole('button', { name: '添加' }),
    )
    expect(await screen.findByText(`已添加「${kit.name}」到已选列表`)).toBeInTheDocument()
    expect(screen.getByText(`已选 ${kinds} 种物品，共 ${total} 个`)).toBeInTheDocument()
    expect(screen.getByTestId('item-cell-diamond')).toBeInTheDocument() // 已切回物品 Tab
  })

  it('应用礼包：目录外 id 静默跳过（建材包 brick_block/quartz_block 缺失）', async () => {
    const user = userEvent.setup()
    renderPanel()
    await openKitsTab(user)
    const kit = DEFAULT_KITS.find((k) => k.name === '建材包')!
    fireEvent.click(
      within(screen.getByTestId(`kit-card-${kit.name}`)).getByRole('button', { name: '添加' }),
    )
    expect(await screen.findByText(`已添加「${kit.name}」到已选列表`)).toBeInTheDocument()
    expect(screen.getByText(/已选 8 种物品/)).toBeInTheDocument()
  })

  it('新建礼包：编辑器校验 + 创建 + localStorage 持久化', async () => {
    const user = userEvent.setup()
    renderPanel()
    await openKitsTab(user)
    fireEvent.click(screen.getByRole('button', { name: /新建礼包/ }))
    const dialog = await screen.findByRole('dialog')
    // 校验：空名称拦截
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }))
    expect(await screen.findByText('请输入礼包名称')).toBeInTheDocument()
    // 填写名称 + 图标 + 物品
    fireEvent.change(within(dialog).getByLabelText('礼包名称'), { target: { value: '测试礼包' } })
    fireEvent.click(within(dialog).getByLabelText('选择图标 ⭐'))
    fireEvent.change(within(dialog).getByLabelText('搜索礼包物品'), { target: { value: '钻石' } })
    // 网格首个「钻石」卡片（多件钻石系物品，取第一个）
    fireEvent.click(within(dialog).getAllByRole('button', { name: /^钻石/ })[0]!)
    expect(within(dialog).getByText('当前物品（1）')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }))
    expect(await screen.findByText('已添加礼包「测试礼包」')).toBeInTheDocument()
    // localStorage 持久化（schema：{name, icon, desc, items}）
    const stored = JSON.parse(localStorage.getItem(KITS_STORAGE_KEY)!) as KitPreset[]
    expect(stored).toHaveLength(DEFAULT_KITS.length + 1)
    const created = stored.find((k) => k.name === '测试礼包')
    expect(created?.icon).toBe('⭐')
    expect(created?.items).toEqual([{ id: 'diamond', count: 1 }])
    // 新卡片渲染
    expect(screen.getByTestId('kit-card-测试礼包')).toBeInTheDocument()
  })

  it('编辑礼包：⋮ → 编辑 → 改名保存', async () => {
    const user = userEvent.setup()
    renderPanel()
    await openKitsTab(user)
    // radix DropdownMenu 仅 pointerdown 打开 → userEvent
    await user.click(screen.getByLabelText('新手起步包 礼包操作'))
    await user.click(screen.getByRole('menuitem', { name: /编辑/ }))
    const dialog = await screen.findByRole('dialog')
    const nameInput = within(dialog).getByLabelText('礼包名称')
    fireEvent.change(nameInput, { target: { value: '' } })
    fireEvent.change(nameInput, { target: { value: '起步包改' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已更新礼包「起步包改」')).toBeInTheDocument()
    expect(screen.getByTestId('kit-card-起步包改')).toBeInTheDocument()
    const stored = JSON.parse(localStorage.getItem(KITS_STORAGE_KEY)!) as KitPreset[]
    expect(stored.some((k) => k.name === '起步包改')).toBe(true)
  })

  it('删除礼包：确认对话框 → 移除 + 持久化', async () => {
    const user = userEvent.setup()
    renderPanel()
    await openKitsTab(user)
    // radix DropdownMenu 仅 pointerdown 打开 → userEvent
    await user.click(screen.getByLabelText('新手起步包 礼包操作'))
    await user.click(screen.getByRole('menuitem', { name: /删除/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/确定要删除「新手起步包」吗/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    expect(await screen.findByText('已删除礼包「新手起步包」')).toBeInTheDocument()
    expect(screen.queryByTestId('kit-card-新手起步包')).not.toBeInTheDocument()
    const stored = JSON.parse(localStorage.getItem(KITS_STORAGE_KEY)!) as KitPreset[]
    expect(stored).toHaveLength(DEFAULT_KITS.length - 1)
    expect(stored.some((k) => k.name === '新手起步包')).toBe(false)
  })
})
