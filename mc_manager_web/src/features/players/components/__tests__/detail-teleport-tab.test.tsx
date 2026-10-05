import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { Toaster } from 'sonner'
import { TeleportTab, type TeleportTabProps } from '../detail-teleport-tab'
import { useConnectionStore } from '@/stores/connection'
import { QUICK_TELEPORT_STORAGE_KEY } from '@/lib/mc-teleport'
import type { Player } from '@/api/types'

/**
 * TeleportTab 传送 Tab 测试
 * 覆盖：正常渲染 / 离线拦截 / 坐标表单 / 传送到玩家（含空态）/ 世界出生点编辑二次确认 /
 *      主世界原点隐藏持久化 / 自定义点增删持久化 / 批量跳过离线 / 批量全离线 / 复制坐标
 * mock 数据为结构占位虚构玩家（Steve/Alex/Bob），严禁真实玩家/服务器信息
 */

/** 结构占位玩家工厂（虚构数据） */
function makePlayer(overrides: Partial<Player>): Player {
  return {
    name: 'Steve',
    uuid: '00000000-0000-4000-8000-000000000001',
    isOnline: true,
    ip: '',
    joinTime: Date.now() - 3_600_000,
    onlineTime: 3600,
    totalPlayTime: 36_000,
    isOp: false,
    isWhitelisted: false,
    isBanned: false,
    banExpiresAt: null,
    isIpBanned: false,
    ipBanExpiresAt: null,
    isFakePlayer: false,
    lastSeen: new Date().toISOString(),
    health: 20,
    maxHealth: 20,
    hunger: 18,
    xpLevel: 12,
    spawnPoint: { x: 0, y: 64, z: 0 },
    respawnPoint: null,
    position: { x: 123.5, y: 64, z: -456.2 },
    gameMode: 'survival',
    dimension: 'overworld',
    armor: 15,
    xpProgress: 0.4,
    ping: 35,
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
      totalOnline: 86_400,
      loginCount: 12,
      offlineSince: 0,
      deathCount: 3,
      achievementCount: 25,
      sleepCount: 2,
    },
    ...overrides,
  }
}

const steve = makePlayer({})
const alex = makePlayer({
  name: 'Alex',
  uuid: '00000000-0000-4000-8000-000000000002',
  position: { x: 10, y: 11, z: 12 },
  dimension: 'nether',
})
const bob = makePlayer({
  name: 'Bob',
  uuid: '00000000-0000-4000-8000-000000000003',
  isOnline: false,
  position: null,
  health: null,
  maxHealth: null,
  hunger: null,
  xpLevel: null,
  armor: null,
  ping: null,
})

/** 玩家列表端点（可整体替换以测空态等分支） */
let serverPlayers: Player[] = [steve, alex, bob]

const server = setupServer(
  http.get('*/api/v1/instances/:id/players', () =>
    HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'Success',
      data: serverPlayers,
      timestamp: new Date().toISOString(),
    }),
  ),
)

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  serverPlayers = [steve, alex, bob]
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
})

function renderTab(overrides: Partial<TeleportTabProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onAction = vi.fn().mockResolvedValue(undefined)
  const props: TeleportTabProps = {
    player: steve,
    batchTargets: [steve],
    isBatchMode: false,
    instanceId: 'demo',
    isRconConnected: true,
    onAction,
    ...overrides,
  }
  render(
    <QueryClientProvider client={qc}>
      <TeleportTab {...props} />
      <Toaster />
    </QueryClientProvider>,
  )
  return { onAction }
}

/** 打开修改世界出生点弹窗并进入第二步（改 X=5 → 保存 → 二次确认） */
async function openWorldSpawnConfirm() {
  fireEvent.click(screen.getByRole('button', { name: '编辑世界出生点' }))
  const draftDialog = await screen.findByRole('dialog', { name: /修改世界出生点/ })
  fireEvent.change(within(draftDialog).getByLabelText('X'), { target: { value: '5' } })
  fireEvent.click(within(draftDialog).getByRole('button', { name: '保存' }))
  return screen.findByRole('dialog', { name: /确认修改世界出生点/ })
}

describe('TeleportTab', () => {
  it('单个模式在线：渲染当前位置/快捷点/坐标表单/在线玩家列表', async () => {
    renderTab()
    expect(screen.getByText('当前位置')).toBeInTheDocument()
    expect(screen.getByText('快捷传送点')).toBeInTheDocument()
    expect(screen.getByText('坐标传送')).toBeInTheDocument()
    expect(screen.getByText('传送到玩家')).toBeInTheDocument()

    // 当前位置：维度中文标签 + 取整坐标
    expect(screen.getByText('主世界')).toBeInTheDocument()
    expect(screen.getByText('124, 64, -456')).toBeInTheDocument()

    // 快捷点 chips：世界出生点/个人复活点/主世界原点/添加按钮
    expect(screen.getByText('世界出生点')).toBeInTheDocument()
    expect(screen.getByText('个人复活点')).toBeInTheDocument()
    expect(screen.getByText('主世界原点')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加快捷传送点' })).toBeInTheDocument()

    // 坐标表单初值取玩家当前位置（Math.round(123.5)=124）
    expect(screen.getByLabelText('X')).toHaveValue(124)
    expect(screen.getByLabelText('Y')).toHaveValue(64)
    expect(screen.getByLabelText('Z')).toHaveValue(-456)

    // 在线玩家列表：显示 Alex，排除目标自身 Steve
    expect(await screen.findByText('Alex')).toBeInTheDocument()
    expect(screen.queryByText('Steve')).not.toBeInTheDocument()
    expect(screen.getByText('10, 11, 12')).toBeInTheDocument()
    // RCON 已连接时不显示提示
    expect(screen.queryByText(/RCON 未连接/)).not.toBeInTheDocument()
  })

  it('单个模式离线：整 Tab 离线提示卡', () => {
    renderTab({ player: { ...steve, isOnline: false } })
    expect(screen.getByText('玩家已离线，无法执行传送')).toBeInTheDocument()
    expect(screen.getByText('传送操作需要玩家在线')).toBeInTheDocument()
    expect(screen.queryByText('快捷传送点')).not.toBeInTheDocument()
    expect(screen.queryByText('坐标传送')).not.toBeInTheDocument()
  })

  it('RCON 未连接时显示提示', async () => {
    renderTab({ isRconConnected: false })
    expect(await screen.findByText(/提示：RCON 未连接/)).toBeInTheDocument()
  })

  it('坐标表单传送：发送 tp <name> x y z', async () => {
    const { onAction } = renderTab()
    fireEvent.change(screen.getByLabelText('X'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Y'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('Z'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '传送' }))
    await vi.waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'tp Steve 10 20 30' }),
    )
  })

  it('坐标表单：非法输入不执行并提示', async () => {
    const { onAction } = renderTab()
    fireEvent.change(screen.getByLabelText('X'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: '传送' }))
    expect(await screen.findByText('请输入有效的坐标数值')).toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('传送到玩家：点击前往发送 tp <name> <target>', async () => {
    const { onAction } = renderTab()
    fireEvent.click(await screen.findByRole('button', { name: /前往/ }))
    await vi.waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'tp Steve Alex' }),
    )
  })

  it('传送到玩家空态：暂无其他在线玩家', async () => {
    serverPlayers = [steve]
    renderTab()
    expect(await screen.findByText('暂无其他在线玩家')).toBeInTheDocument()
  })

  it('世界出生点 chip：传送到 spawnPoint 坐标', async () => {
    const { onAction } = renderTab({
      player: { ...steve, spawnPoint: { x: -10, y: 70, z: 5 } },
    })
    fireEvent.click(screen.getByText('世界出生点'))
    await vi.waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'tp Steve -10 70 5' }),
    )
  })

  it('个人复活点：优先 respawnPoint', async () => {
    const { onAction } = renderTab({
      player: { ...steve, respawnPoint: { x: 100, y: 65, z: -200 } },
    })
    fireEvent.click(screen.getByText('个人复活点'))
    await vi.waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'tp Steve 100 65 -200' }),
    )
  })

  it('个人复活点：未设置时回退世界出生点（spawnPoint）', async () => {
    const { onAction } = renderTab()
    fireEvent.click(screen.getByText('个人复活点'))
    await vi.waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'tp Steve 0 64 0' }),
    )
  })

  it('编辑世界出生点：两步确认后发送 setworldspawn', async () => {
    const { onAction } = renderTab()
    const confirmDialog = await openWorldSpawnConfirm()
    expect(
      within(confirmDialog).getByText('确定要将世界出生点修改为 (5, 64, 0) 吗？'),
    ).toBeInTheDocument()
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '确认修改' }))
    await vi.waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'setworldspawn 5 64 0' }),
    )
    expect(await screen.findByText('世界出生点已修改')).toBeInTheDocument()
  })

  it('主世界原点：点击传送 0,64,0；删除后 hideOrigin 持久化', async () => {
    const { onAction } = renderTab()
    fireEvent.click(screen.getByText('主世界原点'))
    await vi.waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'tp Steve 0 64 0' }),
    )
    // 删除 → chip 消失 + localStorage 持久化
    fireEvent.click(screen.getByRole('button', { name: '删除主世界原点' }))
    expect(screen.queryByText('主世界原点')).not.toBeInTheDocument()
    const saved = JSON.parse(localStorage.getItem(QUICK_TELEPORT_STORAGE_KEY) ?? '{}') as {
      hideOrigin: boolean
    }
    expect(saved.hideOrigin).toBe(true)
    // 重新挂载后仍隐藏
    renderTab()
    expect(screen.queryByText('主世界原点')).not.toBeInTheDocument()
  })

  it('自定义快捷点：弹窗添加 → 持久化 → 点击传送 → 删除', async () => {
    const { onAction } = renderTab()
    fireEvent.click(screen.getByRole('button', { name: '添加快捷传送点' }))
    const dialog = await screen.findByRole('dialog', { name: /添加快捷传送点/ })
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '基地' } })
    fireEvent.change(within(dialog).getByLabelText('X'), { target: { value: '1' } })
    fireEvent.change(within(dialog).getByLabelText('Y'), { target: { value: '2' } })
    fireEvent.change(within(dialog).getByLabelText('Z'), { target: { value: '3' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '添加' }))

    // chip 出现且持久化
    expect(screen.getByText('基地')).toBeInTheDocument()
    const saved = JSON.parse(localStorage.getItem(QUICK_TELEPORT_STORAGE_KEY) ?? '{}') as {
      items: Array<{ name: string; x: number; y: number; z: number }>
    }
    expect(saved.items).toEqual([{ name: '基地', x: 1, y: 2, z: 3 }])

    // 点击 chip 传送
    fireEvent.click(screen.getByText('基地'))
    await vi.waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'tp Steve 1 2 3' }),
    )

    // 删除 → chip 消失 + 持久化清空
    fireEvent.click(screen.getByRole('button', { name: '删除基地' }))
    expect(screen.queryByText('基地')).not.toBeInTheDocument()
    const afterDelete = JSON.parse(localStorage.getItem(QUICK_TELEPORT_STORAGE_KEY) ?? '{}') as {
      items: unknown[]
    }
    expect(afterDelete.items).toEqual([])
  })

  it('自定义快捷点：名称为空时拦截', async () => {
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: '添加快捷传送点' }))
    const dialog = await screen.findByRole('dialog', { name: /添加快捷传送点/ })
    fireEvent.click(within(dialog).getByRole('button', { name: '添加' }))
    expect(await screen.findByText('请输入名称')).toBeInTheDocument()
    expect(localStorage.getItem(QUICK_TELEPORT_STORAGE_KEY)).toBeNull()
  })

  it('批量模式：当前位置多行列表 + 跳过离线目标 + 汇总 toast', async () => {
    const { onAction } = renderTab({
      player: null,
      batchTargets: [steve, bob],
      isBatchMode: true,
    })
    // 当前位置多行（含离线目标行）
    expect(screen.getByText('当前位置')).toBeInTheDocument()
    expect(screen.getByText('124, 64, -456')).toBeInTheDocument()
    // 传送到玩家列表排除全部选中目标（Steve/Bob），仅剩 Alex（Steve 仅出现在当前位置列表）
    const playerListSection = screen.getByText('传送到玩家').parentElement!
    expect(await within(playerListSection).findByText('Alex')).toBeInTheDocument()
    expect(within(playerListSection).queryByText('Steve')).not.toBeInTheDocument()
    expect(within(playerListSection).queryByText('Bob')).not.toBeInTheDocument()

    // 世界出生点：仅在线目标 Steve 执行；Bob 计入跳过离线
    fireEvent.click(screen.getByText('世界出生点'))
    await vi.waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'tp Steve 0 64 0' }),
    )
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByText('批量传送到世界出生点完成：成功 1，失败 0，跳过离线 1'),
    ).toBeInTheDocument()
  })

  it('批量模式：全部离线时警告 toast 且不执行命令', async () => {
    const { onAction } = renderTab({
      player: null,
      batchTargets: [bob],
      isBatchMode: true,
    })
    fireEvent.click(screen.getByText('世界出生点'))
    expect(await screen.findByText('所选玩家均已离线，无法执行')).toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('复制坐标按钮：写入剪贴板并 toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: '复制坐标' }))
    expect(writeText).toHaveBeenCalledWith('124, 64, -456')
    expect(await screen.findByText('已复制坐标')).toBeInTheDocument()
  })
})
