/**
 * InventoryTab 测试：41 格布局 / 数量角标 / hover tooltip / 子 Tab 切换 / 快照与截断提示 / 空态三分支
 * mock 数据为结构占位（虚构玩家 Steve/Alex），严禁真实玩家/服务器信息
 */
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { InventoryTab } from '../detail-inventory-tab'
import type { InventoryItem, Player, PlayerInventory } from '@/api/types'

// ── 结构占位 mock ────────────────────────────────────────────────

function makeInventory(overrides: Partial<PlayerInventory> = {}): PlayerInventory {
  return {
    quickbar: [],
    main: [],
    equipment: { helmet: null, chestplate: null, leggings: null, boots: null, offhand: null },
    enderChest: [],
    source: 'realtime',
    partial: false,
    ...overrides,
  }
}

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    name: 'Steve',
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

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'diamond',
    count: 1,
    slot: 0,
    durability: null,
    enchanted: false,
    customName: null,
    ...overrides,
  }
}

function renderTab(player: Player) {
  return render(
    <TooltipProvider>
      <InventoryTab player={player} />
    </TooltipProvider>,
  )
}

/** 含 5 件物品的完整 41 格数据（装备 2 + 主背包 2 + 快捷栏 1） */
function samplePlayer(overrides: Partial<Player> = {}): Player {
  return makePlayer({
    inventory: makeInventory({
      quickbar: [
        makeItem({
          id: 'diamond_sword',
          count: 1,
          slot: 0,
          durability: 0.8,
          enchanted: true,
          customName: '神剑',
        }),
      ],
      main: [
        makeItem({ id: 'diamond', count: 64, slot: 0 }),
        makeItem({ id: 'bread', count: 16, slot: 9 }),
      ],
      equipment: {
        helmet: makeItem({
          id: 'diamond_helmet',
          count: 1,
          slot: 103,
          durability: 0.2,
          enchanted: true,
        }),
        chestplate: null,
        leggings: null,
        boots: null,
        offhand: makeItem({ id: 'shield', count: 1, slot: -106 }),
      },
    }),
    ...overrides,
  })
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('InventoryTab 41 格布局', () => {
  it('渲染 41 格：装备 5 + 主背包 27 + 快捷栏 9，装备带标签', () => {
    renderTab(samplePlayer())

    // 41 格（含空槽）
    expect(screen.getAllByTestId('inv-slot')).toHaveLength(41)
    // 物品贴图（5 件物品）
    expect(screen.getByAltText('diamond_sword')).toBeInTheDocument()
    expect(screen.getByAltText('diamond_helmet')).toBeInTheDocument()
    expect(screen.getByAltText('shield')).toBeInTheDocument()
    // 装备标签
    for (const label of ['头盔', '胸甲', '护腿', '靴子', '副手']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // 统计行
    expect(screen.getByText('快捷栏')).toBeInTheDocument()
    expect(screen.getByText('1/9')).toBeInTheDocument()
    expect(screen.getByText('2/27')).toBeInTheDocument()
    expect(screen.getByText('2/5')).toBeInTheDocument()
  })

  it('数量角标仅在 count>1 时显示', () => {
    renderTab(samplePlayer())
    expect(screen.getByText('64')).toBeInTheDocument()
    expect(screen.getByText('16')).toBeInTheDocument()
    // count=1 的物品（钻石剑/头盔/盾牌）不显示角标
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })

  it('空物品栏也渲染完整 41 格（全空槽）', () => {
    renderTab(makePlayer({ inventory: makeInventory() }))
    expect(screen.getAllByTestId('inv-slot')).toHaveLength(41)
    expect(screen.getByText('0/9')).toBeInTheDocument()
    expect(screen.getByText('0/27')).toBeInTheDocument()
  })

  it('服务端含 null 空槽的数组正常渲染（防回归：曾因 item.slot 访问 null 崩溃）', () => {
    // 空槽位为 null 是服务端契约（定长数组 + null 占位，按槽位有序）
    renderTab(
      makePlayer({
        inventory: makeInventory({
          quickbar: [null, makeItem({ id: 'diamond_sword', slot: 1 }), null],
          main: [null, null, makeItem({ id: 'diamond', count: 64, slot: 2 })],
        }),
      }),
    )
    expect(screen.getAllByTestId('inv-slot')).toHaveLength(41)
    expect(screen.getByAltText('diamond_sword')).toBeInTheDocument()
    expect(screen.getByAltText('diamond')).toBeInTheDocument()
    // 统计按实际物品数（快捷栏 1/9、背包 1/27）
    expect(screen.getByText('1/9')).toBeInTheDocument()
    expect(screen.getByText('1/27')).toBeInTheDocument()
  })
})

describe('InventoryTab 格子浮层（点按取解释，非 hover-only）', () => {
  it('显示 id/数量/耐久/附魔标记/自定义名', async () => {
    const user = userEvent.setup()
    renderTab(samplePlayer())

    await user.click(screen.getByAltText('diamond_sword'))
    await waitFor(() => {
      expect(screen.getByText('minecraft:diamond_sword')).toBeInTheDocument()
    })
    expect(screen.getByText('神剑')).toBeInTheDocument()
    expect(screen.getByText(/数量 ×1/)).toBeInTheDocument()
    expect(screen.getByText(/耐久 80%/)).toBeInTheDocument()
    expect(screen.getByText(/已附魔/)).toBeInTheDocument()
  })

  it('普通物品浮层不含耐久/附魔标记（无该信息）', async () => {
    const user = userEvent.setup()
    renderTab(samplePlayer())

    await user.click(screen.getByAltText('bread'))
    await waitFor(() => {
      expect(screen.getByText('minecraft:bread')).toBeInTheDocument()
    })
    expect(screen.getByText(/数量 ×16/)).toBeInTheDocument()
    expect(screen.queryByText(/耐久/)).not.toBeInTheDocument()
    expect(screen.queryByText(/已附魔/)).not.toBeInTheDocument()
  })

  it('自定义名 break-all：玩家可控长串折行防溢出浮层框', async () => {
    const player = samplePlayer()
    // 混入拉丁无空白段：CJK 串本可逐字折行（min-content=单字宽），拉丁串才真正触发溢出
    player.inventory!.quickbar[0] = makeItem({
      id: 'diamond_sword',
      customName: 'LongCustomNameAaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 通过命令写入的超长自定义名',
    })
    const user = userEvent.setup()
    renderTab(player)

    await user.click(screen.getByAltText('diamond_sword'))
    expect(await screen.findByText(/LongCustomNameAaaa/)).toHaveClass('break-all')
    // 物品 ID 行同防护：数据包可引入自定义命名空间 ID，长度无上限
    expect(screen.getByText('minecraft:diamond_sword')).toHaveClass('break-all')
  })
})

describe('InventoryTab 子 Tab 切换', () => {
  it('切到末影箱显示 27 格 + 统计 + 存档说明', async () => {
    const user = userEvent.setup()
    renderTab(
      samplePlayer({
        inventory: makeInventory({
          enderChest: [makeItem({ id: 'netherite_ingot', count: 8, slot: 0 })],
        }),
      }),
    )

    expect(screen.getAllByTestId('inv-slot')).toHaveLength(41)
    await user.click(screen.getByRole('tab', { name: '末影箱' }))

    expect(screen.getAllByTestId('inv-slot')).toHaveLength(27)
    expect(screen.getByAltText('netherite_ingot')).toBeInTheDocument()
    expect(screen.getByText('1/27')).toBeInTheDocument()
    expect(screen.getByText('26')).toBeInTheDocument() // 空位
    expect(screen.getByText('末影箱数据来自玩家存档（playerdata EnderItems）')).toBeInTheDocument()
    // 玩家物品栏专属内容不再显示
    expect(screen.queryByText('头盔')).not.toBeInTheDocument()
  })

  it('切回玩家物品栏恢复 41 格', async () => {
    const user = userEvent.setup()
    renderTab(samplePlayer())

    await user.click(screen.getByRole('tab', { name: '末影箱' }))
    await user.click(screen.getByRole('tab', { name: '玩家物品栏' }))
    expect(screen.getAllByTestId('inv-slot')).toHaveLength(41)
  })
})

describe('InventoryTab 提示条', () => {
  it('source=snapshot 显示快照提示条', () => {
    renderTab(
      samplePlayer({
        inventory: makeInventory({ source: 'snapshot' }),
      }),
    )
    expect(screen.getByText('数据来自上次存档快照，可能非实时')).toBeInTheDocument()
  })

  it('source=realtime 不显示快照提示条', () => {
    renderTab(samplePlayer())
    expect(screen.queryByText(/存档快照/)).not.toBeInTheDocument()
  })

  it('partial=true 显示截断降级提示', () => {
    renderTab(
      samplePlayer({
        inventory: makeInventory({ partial: true }),
      }),
    )
    expect(screen.getByText(/物品栏数据不完整/)).toBeInTheDocument()
  })

  it('partial=false 不显示截断提示', () => {
    renderTab(samplePlayer())
    expect(screen.queryByText(/截断/)).not.toBeInTheDocument()
  })
})

describe('InventoryTab 空态三分支', () => {
  it('封禁 → 锁图标提示', () => {
    renderTab(makePlayer({ isBanned: true, inventory: makeInventory() }))
    expect(screen.getByText('该玩家已被封禁，无法查看物品栏')).toBeInTheDocument()
    expect(screen.queryAllByTestId('inv-slot')).toHaveLength(0)
  })

  it('旁观模式 → 无物品栏提示', () => {
    renderTab(makePlayer({ gameMode: 'spectator', inventory: makeInventory() }))
    expect(screen.getByText('旁观模式无物品栏')).toBeInTheDocument()
  })

  it('在线且无数据 → RCON 不可用', () => {
    renderTab(makePlayer({ isOnline: true, inventory: null }))
    expect(screen.getByText('RCON 不可用')).toBeInTheDocument()
    expect(screen.getByText(/请确认服务器已开启 RCON/)).toBeInTheDocument()
  })

  it('离线且无数据 → 无存档数据', () => {
    renderTab(makePlayer({ isOnline: false, inventory: null }))
    expect(screen.getByText('无存档数据')).toBeInTheDocument()
    expect(screen.getByText(/无 playerdata 存档文件/)).toBeInTheDocument()
  })

  it('封禁优先于无数据分支', () => {
    renderTab(makePlayer({ isBanned: true, isOnline: true, inventory: null }))
    expect(screen.getByText('该玩家已被封禁，无法查看物品栏')).toBeInTheDocument()
    expect(screen.queryByText('RCON 不可用')).not.toBeInTheDocument()
  })
  it('漫游焦点：每张格网只占一个 Tab 落点，方向键按网格几何走不出行', async () => {
    const user = userEvent.setup()
    const player = samplePlayer()
    // 摆成上下关系：diamond 在 slot 0、bread 在 slot 9（九列网格的正下方）
    player.inventory!.main = [
      makeItem({ id: 'diamond', count: 64, slot: 0 }),
      ...Array(8).fill(null),
      makeItem({ id: 'bread', count: 16, slot: 9 }),
    ]
    renderTab(player)

    const slots = screen.getAllByTestId('inv-slot').filter((el) => el.tagName === 'BUTTON')
    expect(slots).toHaveLength(5)
    // 装备 / 主背包 / 快捷栏各留一个落点，其余占用格靠方向键到达
    expect(slots.filter((el) => el.getAttribute('tabindex') === '0')).toHaveLength(3)
    expect(slots.filter((el) => el.getAttribute('tabindex') === '-1')).toHaveLength(2)

    const diamond = screen.getByRole('button', { name: 'minecraft:diamond' })
    const bread = screen.getByRole('button', { name: 'minecraft:bread' })

    // 「下」按列走：slot 0 → slot 9
    diamond.focus()
    await user.keyboard('{ArrowDown}')
    expect(bread).toHaveFocus()

    // 「右」不得跨行：slot 0 往右到行尾全是空槽，必须原地停住，
    // 不能绕到下一行的 slot 9（那是按渲染序号步进才会犯的错）
    diamond.focus()
    await user.keyboard('{ArrowRight}')
    expect(diamond).toHaveFocus()

    // 「上」越界不循环：slot 9 往上是 slot 0（有物品）→ 应回到 diamond；
    // 再按一次上越出表头，停在 diamond 而不是绕到表尾
    await user.keyboard('{ArrowUp}')
    expect(diamond).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(diamond).toHaveFocus()
  })
})
