/**
 * GiveItemPanel（给予物品工作台）测试：
 * 目录检索/分类/最近/礼包预设、清单行（数量/快速档/移除/清空/堆叠组数）、
 * 行内附魔与药水配置、版本拦截（不崩面板、不加入清单）、命令折叠与复制、
 * RCON 守卫、单个与批量执行链路、礼包管理与持久化、键盘模型（roving tabindex）。
 * mock 数据为结构占位（虚构玩家 Steve/Alex），严禁真实玩家/服务器信息
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
// 性能说明：普通按钮/输入交互统一 fireEvent（无 pointer 事件序列/逐字符延迟）；
// radix 的 Select/DropdownMenu 打开依赖 pointerdown 序列，相关交互仍用 userEvent
import { Toaster, toast as sonnerToast } from 'sonner'
import { GiveItemPanel } from '@/features/players/components/give-item-panel'
import { useGiveDraftStore } from '@/features/players/give-draft'
import { MINECRAFT_ITEMS } from '@/lib/mc-items'
import { MINECRAFT_POTIONS } from '@/lib/mc-potions'
import { isItemAvailableIn } from '@/lib/mc-item-versions'
import { DEFAULT_KITS, type KitPreset } from '@/lib/mc-kits'
import { usePanelPreferencesStore } from '@/stores/panel-preferences'
import { mockContainerWidth } from '@tests/support/mock-container-width'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '@/features/players/mutations'

// 面板偏好走服务端：假实现记录每次 PUT 的补丁并返回合并后的快照，
// 与真实路由「整份写入单项、返回完整快照」一致
const preferences = vi.hoisted(() => {
  const state: { remote: Record<string, unknown>; writes: Record<string, unknown>[] } = {
    remote: {},
    writes: [],
  }
  return state
})

vi.mock('@/api/preferences', () => ({
  apiGetPreferences: async () => preferences.remote,
  apiPutPreferences: async (_config: unknown, patch: Record<string, unknown>) => {
    preferences.remote = { ...preferences.remote, ...patch }
    preferences.writes.push(patch)
    return preferences.remote
  },
}))

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
  /** 容器宽（默认 960 = 双栏；<760 走窄屏抽屉） */
  containerWidth?: number
}

function renderPanel(opts: RenderOptions = {}) {
  const steve = makePlayer('Steve')
  const player = opts.player === undefined ? (opts.isBatchMode ? null : steve) : opts.player
  const batchTargets = opts.batchTargets ?? (opts.isBatchMode ? [] : [steve])
  const onAction = opts.onAction ?? vi.fn().mockResolvedValue(undefined)
  const onDone = opts.onDone ?? vi.fn()
  mockContainerWidth(opts.containerWidth ?? 960)
  const result = render(
    <>
      <GiveItemPanel
        player={player}
        batchTargets={batchTargets}
        isBatchMode={opts.isBatchMode ?? false}
        mcVersion={opts.mcVersion ?? '1.21.2'}
        isRconConnected={opts.isRconConnected ?? true}
        onAction={onAction}
        onDone={onDone}
      />
      <Toaster />
    </>,
  )
  return { onAction, onDone, unmount: result.unmount }
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
  // 偏好快照按「已拉回且为空」起测：未拉回时写入会被 store 拒绝，属单独用例
  preferences.remote = {}
  preferences.writes = []
  usePanelPreferencesStore.setState({ remote: {}, saving: false })
  // 草稿挂在 store：跨用例必须清，否则上一个用例的清单会带进来
  useGiveDraftStore.getState().reset()
  // sonner toast 存于模块级 store，跨测试残留会导致同文案 toast 重复匹配
  sonnerToast.dismiss()
})

// ── 目录与清单 ───────────────────────────────────────────────────

/** 该版本货架上应有多少件（目录按实例版本过滤，不再靠角标提示） */
function availableCatalogSize(mcVersion: string): number {
  return (
    MINECRAFT_ITEMS.filter((i) => isItemAvailableIn(i.id, mcVersion)).length +
    MINECRAFT_POTIONS.length
  )
}

describe('给予工作台：目录与清单', { timeout: 15000 }, () => {
  it('默认渲染：搜索框 / 分类 / 结果数 / 清单空态 / 发放按钮禁用', () => {
    renderPanel()
    expect(screen.getByLabelText('搜索物品')).toBeInTheDocument()
    // 结果行现在带「N 件需更高版本」后缀，用正则只锁件数前缀
    expect(
      screen.getByText(new RegExp(`^找到 ${availableCatalogSize('1.21.2')} 件`)),
    ).toBeInTheDocument()
    expect(screen.getByTestId('item-cell-diamond')).toBeInTheDocument()
    expect(screen.getByText(/还没有物品/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '给予 Steve' })).toBeDisabled()
  })

  it('版本未知（mcVersion 为空）不过滤：无法判定时不猜', () => {
    renderPanel({ mcVersion: '' })
    expect(
      screen.getByText(`找到 ${MINECRAFT_ITEMS.length + MINECRAFT_POTIONS.length} 件`),
    ).toBeInTheDocument()
  })

  it('搜索按名称/ID 过滤并显示匹配数；清空恢复', () => {
    renderPanel()
    const expected = MINECRAFT_ITEMS.filter(
      (i) => i.name.includes('钻石') && isItemAvailableIn(i.id, '1.21.2'),
    ).length
    fireEvent.change(screen.getByLabelText('搜索物品'), { target: { value: '钻石' } })
    expect(screen.getByText(`找到 ${expected} 件 · “钻石”`)).toBeInTheDocument()
    expect(screen.getByTestId('item-cell-diamond_sword')).toBeInTheDocument()
    expect(screen.queryByTestId('item-cell-stone')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('清空搜索'))
    expect(screen.getByTestId('item-cell-stone')).toBeInTheDocument()
  })

  it('搜索无匹配显示空态 + 一键清空搜索', () => {
    renderPanel()
    fireEvent.change(screen.getByLabelText('搜索物品'), { target: { value: '不存在的物品xyz' } })
    expect(screen.getByText('没有找到匹配的物品')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('清空搜索'))
    expect(screen.getByTestId('item-cell-diamond')).toBeInTheDocument()
  })

  it('「药水」分类渲染 20 种效果虚拟物品（效果色块 + 名称）', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '药水' }))
    expect(screen.getByText(`找到 ${MINECRAFT_POTIONS.length} 件`)).toBeInTheDocument()
    expect(screen.getByTestId('potion-dot-speed')).toBeInTheDocument()
    expect(screen.queryByTestId('item-cell-diamond')).not.toBeInTheDocument()
  })

  it('点击物品：清单出一行 + 选中态 + 摘要 + 发放启用（CTA 写明目标）', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    expect(screen.getByTestId('give-line-diamond')).toBeInTheDocument()
    expect(screen.getByTestId('item-cell-diamond')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('give-summary')).toHaveTextContent('共 1 个 · 1 条 give 命令')
    expect(screen.getByRole('button', { name: '给予 Steve' })).toBeEnabled()
  })

  it('数量 −/+：clamp 1-6400，减到 0 移除', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByLabelText('增加 钻石 数量'))
    fireEvent.click(screen.getByLabelText('增加 钻石 数量'))
    expect(screen.getByTestId('give-summary')).toHaveTextContent('共 3 个 · 1 条 give 命令')
    fireEvent.click(screen.getByLabelText('减少 钻石 数量'))
    fireEvent.click(screen.getByLabelText('减少 钻石 数量'))
    fireEvent.click(screen.getByLabelText('减少 钻石 数量'))
    expect(screen.queryByTestId('give-line-diamond')).not.toBeInTheDocument()
    expect(screen.getByText(/还没有物品/)).toBeInTheDocument()
  })

  it('快速数量档 1/16/64/256/640/6400，6400 封顶', async () => {
    const user = userEvent.setup()
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    await user.click(screen.getByLabelText('钻石 快速数量'))
    await user.click(screen.getByRole('menuitem', { name: '6400' }))
    expect(screen.getByTestId('give-summary')).toHaveTextContent('共 6400 个 · 1 条 give 命令')
    fireEvent.click(screen.getByLabelText('增加 钻石 数量'))
    expect(screen.getByTestId('give-summary')).toHaveTextContent('共 6400 个 · 1 条 give 命令')
  })

  it('超过一组时摘要补「≈N组」（640 钻石 ≈10 组）', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.change(screen.getByLabelText('钻石 数量'), { target: { value: '640' } })
    fireEvent.blur(screen.getByLabelText('钻石 数量'))
    expect(screen.getByText('=10组')).toBeInTheDocument()
  })

  it('移除按钮与清空：回到空态', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-bread'))
    fireEvent.click(screen.getByLabelText('移除 面包'))
    expect(screen.queryByTestId('give-line-bread')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByTestId('item-cell-bread'))
    fireEvent.click(screen.getByRole('button', { name: '清空已选物品' }))
    expect(screen.getByText(/还没有物品/)).toBeInTheDocument()
  })

  it('清单头显式写明发放目标（换人时清单保留，由用户决定是否清空）', () => {
    renderPanel()
    expect(screen.getByText('发放给')).toBeInTheDocument()
    expect(screen.getAllByText('Steve').length).toBeGreaterThan(0)
  })
})

// ── 版本过滤 ─────────────────────────────────────────────────────

describe('给予工作台：按实例版本过滤目录', { timeout: 15000 }, () => {
  it('1.21.4 实例：26.x 物品根本不进货架（不是灰格子 + 点击才拒）', () => {
    renderPanel({ mcVersion: '1.21.4' })
    expect(screen.queryByTestId('item-cell-sulfur')).not.toBeInTheDocument()
    expect(screen.queryByTestId('item-cell-golden_dandelion')).not.toBeInTheDocument()
    // 同分类里 1.20.5 起就有的物品仍在，货架没被整类误伤
    expect(screen.getByTestId('item-cell-diamond')).toBeInTheDocument()
  })

  it('26.2 实例：这些物品回到货架', () => {
    renderPanel({ mcVersion: '26.2' })
    expect(screen.getByTestId('item-cell-sulfur')).toBeInTheDocument()
    expect(screen.getByTestId('item-cell-golden_dandelion')).toBeInTheDocument()
  })

  it('26.1 与 26.2 之间按逐物品首见版本切分（金蒲公英 vs 硫磺）', () => {
    renderPanel({ mcVersion: '26.1' })
    expect(screen.getByTestId('item-cell-golden_dandelion')).toBeInTheDocument()
    expect(screen.queryByTestId('item-cell-sulfur')).not.toBeInTheDocument()
  })

  it('版本不可解析（周快照 / unknown）不过滤：判据不存在时不能替用户删物品', () => {
    // 服务端 _getMcVersion 读不到 JAR 且 DB 无记录时给 'unknown'，
    // 用户手动换快照 JAR 时给 25w35a —— parseVersion 对两种都返回 null
    for (const mcVersion of ['unknown', '25w35a']) {
      const { unmount } = render(
        <GiveItemPanel
          player={makePlayer('Steve')}
          batchTargets={[makePlayer('Steve')]}
          isBatchMode={false}
          mcVersion={mcVersion}
          isRconConnected
          onAction={vi.fn().mockResolvedValue(undefined)}
        />,
      )
      expect(
        screen.getByText(`找到 ${MINECRAFT_ITEMS.length + MINECRAFT_POTIONS.length} 件`),
      ).toBeInTheDocument()
      expect(screen.getByTestId('item-cell-sulfur')).toBeInTheDocument()
      unmount()
    }
    useGiveDraftStore.getState().reset()
  })

  it('搜索命中被版本挡掉的物品：空态说明原因，且给出被挡数量', () => {
    renderPanel({ mcVersion: '1.21.4' })
    fireEvent.change(screen.getByLabelText('搜索物品'), { target: { value: '硫磺' } })
    expect(screen.getByText('该版本没有匹配的物品')).toBeInTheDocument()
    expect(screen.getByText(/但需要比 MC 1\.21\.4 更新的版本/)).toBeInTheDocument()
    expect(screen.queryByTestId('item-cell-sulfur')).not.toBeInTheDocument()
  })

  it('结果行注明被版本挡掉的件数', () => {
    renderPanel({ mcVersion: '1.21.4' })
    const hidden =
      MINECRAFT_ITEMS.length + MINECRAFT_POTIONS.length - availableCatalogSize('1.21.4')
    expect(
      screen.getByText(new RegExp(`找到 \\d+ 件（${hidden} 件需更高版本）`)),
    ).toBeInTheDocument()
  })

  it('最近发放里来自更高版本的 id 不入单（不变成可点入口）', () => {
    // 本机在 26.2 实例上发过硫磺；换到 1.21.4 实例后这条最近记录不该出现
    localStorage.setItem('mcs-give-recent-items', JSON.stringify(['sulfur', 'diamond']))
    renderPanel({ mcVersion: '1.21.4' })
    expect(screen.getByRole('button', { name: '最近：钻石' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '最近：硫磺' })).not.toBeInTheDocument()
  })
})

// ── 行内属性面板 ─────────────────────────────────────────────────

describe('给予工作台：附魔配置', { timeout: 15000 }, () => {
  function openEnchantPanel() {
    fireEvent.click(screen.getByTestId('item-cell-diamond_sword'))
    fireEvent.click(screen.getByLabelText('钻石剑 附魔设置'))
  }

  it('展开：可用附魔 + 等级范围 + 开关', () => {
    renderPanel()
    openEnchantPanel()
    expect(screen.getByText('附魔 · 钻石剑')).toBeInTheDocument()
    expect(screen.getByText('锋利')).toBeInTheDocument()
    expect(screen.getAllByText('I-V').length).toBeGreaterThan(0)
    // maxLevel=2 的火焰附加：开关打开后出现等级下拉
    fireEvent.click(screen.getByLabelText('火焰附加 附魔开关'))
    const levelSelect = screen.getByRole('combobox', { name: '火焰附加 等级' })
    expect(levelSelect).toHaveTextContent('1')
    fireEvent.click(levelSelect)
    fireEvent.click(screen.getByRole('option', { name: '2' }))
    expect(screen.getByRole('combobox', { name: '火焰附加 等级' })).toHaveTextContent('2')
    // 清单行摘要随附魔更新（本用例只开了火焰附加）
    expect(screen.getByTestId('give-line-diamond_sword')).toHaveTextContent('火焰附加')
  })

  it('冲突附魔禁用（锋利↔亡灵杀手），解除冲突后恢复', () => {
    renderPanel()
    openEnchantPanel()
    expect(screen.getByRole('switch', { name: '亡灵杀手 附魔开关' })).toBeEnabled()
    fireEvent.click(screen.getByLabelText('锋利 附魔开关'))
    expect(screen.getByRole('switch', { name: '亡灵杀手 附魔开关' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('锋利 附魔开关'))
    expect(screen.getByRole('switch', { name: '亡灵杀手 附魔开关' })).toBeEnabled()
  })

  it('命令预览随配置更新 + 复制', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderPanel()
    openEnchantPanel()
    fireEvent.click(screen.getByLabelText('锋利 附魔开关'))
    expect(screen.getByTestId('give-command-preview')).toHaveTextContent(
      'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":1}] 1',
    )
    fireEvent.click(screen.getByLabelText('复制命令'))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":1}] 1',
      ),
    )
    expect(await screen.findByText('命令已复制')).toBeInTheDocument()
  })
})

describe('给予工作台：药水配置', { timeout: 15000 }, () => {
  function openPotionPanel(effectId = 'speed') {
    fireEvent.click(screen.getByRole('button', { name: '药水' }))
    fireEvent.click(screen.getByTestId(`item-cell-${effectId}`))
    fireEvent.click(
      screen.getByLabelText(
        `${MINECRAFT_POTIONS.find((e) => e.effectId === effectId)!.name} 药水配置`,
      ),
    )
  }

  it('瓶型/等级/时长三 Select + 命令预览', () => {
    renderPanel()
    openPotionPanel()
    expect(screen.getByText('药水 · 迅捷')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '瓶型' })).toHaveTextContent('饮用药水')
    expect(screen.getByRole('combobox', { name: '效果等级' })).toHaveTextContent('I')
    expect(screen.getByRole('combobox', { name: '时长' })).toHaveTextContent('普通 3:00')
    expect(screen.getByTestId('give-command-preview')).toHaveTextContent('custom_effects')
    fireEvent.click(screen.getByRole('combobox', { name: '瓶型' }))
    fireEvent.click(screen.getByRole('option', { name: '喷溅药水' }))
    expect(screen.getByTestId('give-command-preview')).toHaveTextContent('minecraft:splash_potion')
  })

  it('等级切换重置时长；超原版上限标「自定义」', () => {
    renderPanel()
    openPotionPanel()
    fireEvent.click(screen.getByRole('combobox', { name: '效果等级' }))
    fireEvent.click(screen.getByRole('option', { name: 'II' }))
    expect(screen.getByRole('combobox', { name: '时长' })).toHaveTextContent('强效 1:30')
    fireEvent.click(screen.getByRole('combobox', { name: '效果等级' }))
    fireEvent.click(screen.getByRole('option', { name: 'III·自定义' }))
    expect(screen.getByRole('combobox', { name: '时长' })).toHaveTextContent('30秒')
    expect(screen.getByText('等级 III（自定义）')).toBeInTheDocument()
  })

  it('瞬时效果（治疗）：无时长档 + duration=1tick 提示', () => {
    renderPanel()
    openPotionPanel('instant_health')
    expect(screen.getByText(/瞬时效果（duration=1tick）/)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '时长' })).not.toBeInTheDocument()
  })

  it('附魔与药水面板互斥展开（同时仅一个）', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond_sword'))
    fireEvent.click(screen.getByLabelText('钻石剑 附魔设置'))
    expect(screen.getByText('附魔 · 钻石剑')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '药水' }))
    fireEvent.click(screen.getByTestId('item-cell-speed'))
    fireEvent.click(screen.getByLabelText('迅捷 药水配置'))
    expect(screen.getByText('药水 · 迅捷')).toBeInTheDocument()
    expect(screen.queryByText('附魔 · 钻石剑')).not.toBeInTheDocument()
  })
})

// ── 执行链路 ─────────────────────────────────────────────────────

describe('给予工作台：执行链路', { timeout: 30000 }, () => {
  it('RCON 守卫：附魔物品未连接 RCON → 提示并中止', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({ isRconConnected: false, onAction })
    fireEvent.click(screen.getByTestId('item-cell-diamond_sword'))
    fireEvent.click(screen.getByLabelText('钻石剑 附魔设置'))
    fireEvent.click(screen.getByLabelText('锋利 附魔开关'))
    // 未连接时清单底部常驻告警，CTA 直接禁用（不再允许点了才报错）
    expect(screen.getByText(/附魔与药水命令需要 RCON/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '给予 Steve' })).toBeDisabled()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('RCON 守卫：药水物品未连接 RCON → 常驻告警 + CTA 禁用', () => {
    renderPanel({ isRconConnected: false })
    fireEvent.click(screen.getByRole('button', { name: '药水' }))
    fireEvent.click(screen.getByTestId('item-cell-speed'))
    expect(screen.getByText(/附魔与药水命令需要 RCON/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '给予 Steve' })).toBeDisabled()
  })

  it('附魔物品 + RCON 已连接：正常执行附魔命令', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({ onAction })
    fireEvent.click(screen.getByTestId('item-cell-diamond_sword'))
    fireEvent.click(screen.getByLabelText('钻石剑 附魔设置'))
    fireEvent.click(screen.getByLabelText('锋利 附魔开关'))
    fireEvent.click(screen.getByRole('button', { name: '给予 Steve' }))
    expect(await screen.findByText('已给予 Steve 1 种物品')).toBeInTheDocument()
    expect(onAction).toHaveBeenCalledWith({
      kind: 'command',
      command: 'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":1}] 1',
    })
  })

  it('单个模式：逐条执行 + 成功 toast + 收口（清单清空）+ onDone', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    const onDone = vi.fn()
    renderPanel({ onAction, onDone })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByTestId('item-cell-bread'))
    fireEvent.click(screen.getByRole('button', { name: '给予 Steve' }))
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
    expect(screen.getByText(/还没有物品/)).toBeInTheDocument()
  })

  it('单个模式：失败单条 toast（不影响其余执行，清单保留可重试）', async () => {
    const onAction = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    renderPanel({ onAction })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByTestId('item-cell-bread'))
    fireEvent.click(screen.getByRole('button', { name: '给予 Steve' }))
    expect(await screen.findByText('钻石 给予失败：网络错误')).toBeInTheDocument()
    expect(await screen.findByText('已给予 Steve 1 种物品')).toBeInTheDocument()
    // 有失败时不收口：清单仍在，用户可直接重试
    expect(screen.getByTestId('give-line-diamond')).toBeInTheDocument()
    expect(screen.getByTestId('give-line-bread')).toBeInTheDocument()
  })

  it('批量模式：在线执行 / 离线跳过 + 汇总 toast + CTA 写明人数', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({
      isBatchMode: true,
      batchTargets: [makePlayer('Steve'), makePlayer('Alex', { isOnline: false })],
      onAction,
    })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    // 批量 CTA 必须显式带人数，避免「以为是给一个人」
    fireEvent.click(screen.getByRole('button', { name: '给予 2 名玩家' }))
    expect(onAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认给予' }))
    expect(await screen.findByText('批量给予完成：成功 1，失败 0，跳过离线 1')).toBeInTheDocument()
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({
      kind: 'command',
      command: 'give Steve minecraft:diamond 1',
    })
  })

  it('批量模式：确认弹窗取消时不发送任何命令', () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({ isBatchMode: true, batchTargets: [makePlayer('Steve')], onAction })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByRole('button', { name: '给予 1 名玩家' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('批量模式：全部离线不执行任何命令', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({
      isBatchMode: true,
      batchTargets: [makePlayer('Alex', { isOnline: false })],
      onAction,
    })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByRole('button', { name: '给予 1 名玩家' }))
    expect(await screen.findByText('所选玩家均已离线，无法执行')).toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('成功后写入「最近发放」，可直接从最近再给一个', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    renderPanel({ onAction })
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByRole('button', { name: '给予 Steve' }))
    await screen.findByText('已给予 Steve 1 种物品')
    expect(screen.getByText('最近')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '最近：钻石' }))
    expect(screen.getByTestId('give-line-diamond')).toBeInTheDocument()
  })
})

// ── 命令折叠 ─────────────────────────────────────────────────────

describe('给予工作台：命令折叠', { timeout: 15000 }, () => {
  it('默认只显示第一条 +「等 N 条」；展开可见全部，复制为多行', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderPanel()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(screen.getByTestId('item-cell-bread'))
    expect(screen.getByTestId('give-command-preview')).toHaveTextContent(
      'give Steve minecraft:diamond 1',
    )
    fireEvent.click(screen.getByRole('button', { name: '等 2 条' }))
    expect(screen.getByText('give Steve minecraft:bread 1')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('复制命令'))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'give Steve minecraft:diamond 1\ngive Steve minecraft:bread 1',
      ),
    )
  })
})

// ── 礼包预设 ─────────────────────────────────────────────────────

describe('给予工作台：礼包预设', { timeout: 15000 }, () => {
  it('目录顶部一行礼包 chips + 管理入口', () => {
    renderPanel()
    for (const kit of DEFAULT_KITS) {
      expect(screen.getByTestId(`kit-chip-${kit.name}`)).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: '管理' })).toBeInTheDocument()
  })

  it('应用礼包：清单并入（数量累加）+ toast', async () => {
    renderPanel()
    const kit = DEFAULT_KITS[0]!
    const { kinds, total } = kitResolvable(kit)
    fireEvent.click(screen.getByTestId(`kit-chip-${kit.name}`))
    expect(await screen.findByText(`已添加「${kit.name}」到发放清单`)).toBeInTheDocument()
    expect(screen.getByTestId('give-summary')).toHaveTextContent(
      `共 ${total} 个 · ${kinds} 条 give 命令`,
    )
  })

  it('应用礼包：目录外 id 不静默丢弃（建材包 quartz_block 缺失须告知）', async () => {
    renderPanel()
    const kit = DEFAULT_KITS.find((k) => k.name === '建材包')!
    fireEvent.click(screen.getByTestId(`kit-chip-${kit.name}`))
    expect(await screen.findByText(/1 件物品不在目录中已跳过/)).toBeInTheDocument()
    expect(screen.getByText(/quartz_block/)).toBeInTheDocument()
  })

  it('应用礼包：当前版本没有的物品同样跳过并点名（礼包是跨实例的偏好快照）', async () => {
    usePanelPreferencesStore.setState({
      remote: {
        kits: [
          {
            name: '混合包',
            icon: '📦',
            desc: '',
            items: [
              { id: 'diamond', count: 1 },
              { id: 'sulfur', count: 2 },
              { id: 'cinnabar', count: 2 },
            ],
          },
        ],
      } as never,
      saving: false,
    })
    renderPanel({ mcVersion: '1.21.4' })
    fireEvent.click(screen.getByTestId('kit-chip-混合包'))
    expect(await screen.findByText(/2 件物品在 MC 1\.21\.4 不存在已跳过/)).toBeInTheDocument()
    expect(screen.getByText(/硫磺、朱砂/)).toBeInTheDocument()
    // 版本可用的那件要真的入单，不能整包作废
    expect(screen.getByTestId('give-line-diamond')).toBeInTheDocument()
    expect(screen.queryByTestId('give-line-sulfur')).not.toBeInTheDocument()
  })

  it('管理礼包：新建 → 校验 → 创建 → 写入面板偏好', async () => {
    const user = userEvent.setup()
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    const manager = await screen.findByRole('dialog')
    fireEvent.click(within(manager).getByRole('button', { name: /新建礼包/ }))
    const editor = await screen.findByRole('dialog', { name: /新建礼包/ })
    // 校验：空名称拦截
    fireEvent.click(within(editor).getByRole('button', { name: '创建' }))
    expect(await screen.findByText('请输入礼包名称')).toBeInTheDocument()
    fireEvent.change(within(editor).getByLabelText('礼包名称'), { target: { value: '测试礼包' } })
    fireEvent.click(within(editor).getByLabelText('选择图标 ⭐'))
    fireEvent.change(within(editor).getByLabelText('搜索礼包物品'), { target: { value: '钻石' } })
    fireEvent.click(within(editor).getAllByRole('button', { name: /^钻石/ })[0]!)
    expect(within(editor).getByText('当前物品（1）')).toBeInTheDocument()
    fireEvent.click(within(editor).getByRole('button', { name: '创建' }))
    expect(await screen.findByText('已添加礼包「测试礼包」')).toBeInTheDocument()
    const stored = preferences.writes.at(-1)?.kits as KitPreset[]
    expect(stored).toHaveLength(DEFAULT_KITS.length + 1)
    const created = stored.find((k) => k.name === '测试礼包')
    expect(created?.icon).toBe('⭐')
    expect(created?.items).toEqual([{ id: 'diamond', count: 1 }])
    await user.keyboard('{Escape}')
  })

  it('删除礼包：确认对话框 → 移除 + 持久化', async () => {
    const user = userEvent.setup()
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    const manager = await screen.findByRole('dialog')
    await user.click(within(manager).getByLabelText('新手起步包 礼包操作'))
    await user.click(await screen.findByRole('menuitem', { name: /删除/ }))
    const dialog = await screen.findByRole('dialog', { name: '删除礼包' })
    expect(within(dialog).getByText(/确定要删除「新手起步包」吗/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    expect(await screen.findByText('已删除礼包「新手起步包」')).toBeInTheDocument()
    const stored = preferences.writes.at(-1)?.kits as KitPreset[]
    expect(stored).toHaveLength(DEFAULT_KITS.length - 1)
  })

  it('偏好尚未拉回时保存：提示失败且服务端礼包不变', async () => {
    const user = userEvent.setup()
    usePanelPreferencesStore.setState({ remote: null, saving: false })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    const manager = await screen.findByRole('dialog')
    await user.click(within(manager).getByLabelText('新手起步包 礼包操作'))
    await user.click(await screen.findByRole('menuitem', { name: /删除/ }))
    const dialog = await screen.findByRole('dialog', { name: '删除礼包' })
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    expect(await screen.findByText('礼包保存失败，请重试')).toBeInTheDocument()
    expect(preferences.writes).toEqual([])
  })
})

// ── 键盘模型 ─────────────────────────────────────────────────────

describe('给予工作台：键盘模型', { timeout: 15000 }, () => {
  it('整张栅格只占一个 Tab 停靠点，方向键走格、Home/End 到首尾', () => {
    renderPanel()
    const grid = screen.getByTestId('give-item-grid')
    const cells = within(grid).getAllByRole('button')
    const tabbable = cells.filter((c) => c.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]).toBe(cells[0])

    act(() => (cells[0] as HTMLElement).focus())
    // jsdom 无布局：gridTemplateColumns 取不到列数 → 横向仍然可用（列数按 1 兜底）
    fireEvent.keyDown(cells[0]!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(cells[1])
    fireEvent.keyDown(cells[1]!, { key: 'End' })
    expect(document.activeElement).toBe(cells[cells.length - 1])
    fireEvent.keyDown(cells[cells.length - 1]!, { key: 'Home' })
    expect(document.activeElement).toBe(cells[0])
  })

  it('「/」回搜索框；焦点在输入类元素里时不抢键（提示与行为一致）', async () => {
    renderPanel()
    const search = screen.getByLabelText('搜索物品')
    // 挂载即聚焦搜索框（目录是主入口）；聚焦在下一帧执行——同一帧内会被 Tabs 的
    // mousedown 聚焦回滚，故这里等帧而不是直接断言
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    expect(document.activeElement).toBe(search)

    // 焦点在搜索框内时「/」是普通字符，不能被吞掉
    fireEvent.keyDown(search, { key: '/' })
    expect(document.activeElement).toBe(search)

    act(() => search.blur())
    fireEvent.keyDown(document.body, { key: '/' })
    expect(document.activeElement).toBe(search)
  })

  it('窄容器（<760）清单收成底部抽屉：购物车条 + 查看清单', async () => {
    renderPanel({ containerWidth: 600 })
    // 宽度由 ResizeObserver 微任务投递，等它生效后双栏才切成抽屉
    const openButton = await screen.findByRole('button', { name: '查看清单' })
    expect(screen.queryByTestId('give-ticket')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('item-cell-diamond'))
    fireEvent.click(openButton)
    expect(await screen.findByTestId('give-line-diamond')).toBeInTheDocument()
  })
})
