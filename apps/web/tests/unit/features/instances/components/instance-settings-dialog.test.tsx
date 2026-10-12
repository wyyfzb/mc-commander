/**
 * InstanceSettingsDialog 测试
 * - 预填：结构化字段（maxMemory/jvmArgs/javaPath）与旧 startCommand 解析（含 aikars 开关判定）
 * - 交互：滑块 0.5G 步进联动预览 / Aikar 开关生成与移除 / 高级参数展开
 * - 保存：PUT /instances/:id 载荷校验（maxMemory/minMemory/jvmArgs/javaPath 白名单）
 *   + 成功 toast + 关闭 + 实例详情失效重拉；失败 toast 且不关闭
 * - 实时推送（MSMP）：与启动配置同属一次事务（拨动只改草稿、点保存才落库），两者同置「待重启」；
 *   读失败 / 在途 / 已读到三态分明，都不落成「已关闭」
 * - 两处设置开关行共用同一容器配方：逐类等集 + 行外无额外包裹锁定外观；在途 / 连接未就绪两态分别锁定
 * mock 数据为结构占位虚构（虚构实例名/版本），严禁真实服务器信息
 */
import { describe, expect, it, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { Toaster, toast as sonnerToast } from 'sonner'
import { apiGet } from '@/api/client'
import { queryKeys, FALLBACK_POLL_INTERVAL_MS } from '@/api/queries'
import { handlers, mockInstanceStatus } from '@tests/support/handlers'
import { useConnectionStore } from '@/stores/connection'
import { useRestartPendingStore } from '@/stores/restart-pending'
import { InstanceSettingsDialog } from '@/features/instances/components/instance-settings-dialog'
import type { InstanceStatus, InstanceSummary, PushChannelState } from '@/api/types'

// 推送通道接口按用例打桩（其余域仍走真实 MSW）：像读失败、写失败这类分支要精确编排状态。
// 代价是 mock 缺端点时这里不会变红——那条守卫由 support 下的端点用例
// 承担（它刻意不打桩 API 层）
const { apiGetPushChannel, apiSetPushChannel } = vi.hoisted(() => ({
  apiGetPushChannel: vi.fn(),
  apiSetPushChannel: vi.fn(),
}))

vi.mock('@/api/world', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/world')>()),
  apiGetPushChannel,
  apiSetPushChannel,
}))

/** 夹具：通道默认是关的（与 status.capabilities.msmpPush=false 同一套说法） */
const PUSH_OFF: PushChannelState = {
  enabled: false,
  tlsEnabled: true,
  host: 'localhost',
  port: 0,
  secretConfigured: false,
}
const PUSH_ON: PushChannelState = { ...PUSH_OFF, enabled: true, tlsEnabled: false }

// ── 虚构占位数据 ────────────────────────────────────────────────

const alpha: InstanceSummary = { id: 'alpha', name: '虚构甲服', isRunning: true, playerCount: 3 }

function detailWith(overrides: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    ...mockInstanceStatus,
    id: 'alpha',
    name: '虚构甲服',
    startCommand: null,
    jvmArgs: null,
    javaPath: 'java',
    maxMemory: '2G',
    minMemory: '1G',
    totalMemory: 16,
    ...overrides,
  }
}

// ── MSW：PUT 捕获 + 详情请求计数（失效断言）──────────────────────

let putBodies: Record<string, unknown>[]
let putShouldFail: boolean
let detailFetches: number

const putCapture = http.put('*/api/v1/instances/:id', async ({ request }) => {
  const body = (await request.json()) as Record<string, unknown>
  if (putShouldFail) {
    return HttpResponse.json(
      {
        status: 'error',
        code: 40000,
        message: '不支持的启动参数',
        details: null,
        timestamp: new Date().toISOString(),
      },
      { status: 400 },
    )
  }
  putBodies.push(body)
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data: { ...mockInstanceStatus, ...body },
    timestamp: new Date().toISOString(),
  })
})

const detailCounter = http.get('*/api/v1/instances/:id', () => {
  detailFetches += 1
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data: mockInstanceStatus,
    timestamp: new Date().toISOString(),
  })
})

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())
// 运行时 use() 覆盖同名端点（优先级高于 setupServer 列表；afterEach 恢复基座）
beforeEach(() => {
  server.use(putCapture, detailCounter)
})
afterEach(() => {
  server.resetHandlers()
})

// radix Slider/Select 依赖 Pointer Capture API（jsdom 未实现，缺失会崩溃）
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

/** 详情查询探针：让 queryKeys.instance 处于活跃订阅状态，使保存后失效可被观测（重拉计数） */
function DetailProbe() {
  const config = useConnectionStore()
  const { data } = useQuery({
    queryKey: queryKeys.instance('alpha'),
    queryFn: () => apiGet<InstanceStatus>('/api/v1/instances/alpha', config),
  })
  return <span data-testid="detail-probe">{data ? 'loaded' : 'loading'}</span>
}

function renderDialog(detail?: InstanceStatus) {
  // 显式传 undefined = 详情未就绪场景；省略参数 = 默认详情（默认参数机制会把
  // 显式 undefined 替换成默认值，需用 arguments.length 区分）
  const d = arguments.length === 0 ? detailWith() : detail
  const qc = new QueryClient()
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <InstanceSettingsDialog instance={alpha} detail={d} onOpenChange={onOpenChange} />
      <DetailProbe />
      <Toaster />
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

beforeEach(() => {
  putBodies = []
  putShouldFail = false
  detailFetches = 0
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  // 「待重启」集合按实例 id 记且跨用例残留，会污染「未改动就不置位」的判定
  useRestartPendingStore.setState({ pending: {} })
  // sonner toast 存于模块级 store，跨测试残留会导致同文案 toast 重复匹配
  sonnerToast.dismiss()
  apiGetPushChannel.mockReset()
  apiGetPushChannel.mockResolvedValue(PUSH_OFF)
  apiSetPushChannel.mockReset()
  apiSetPushChannel.mockResolvedValue({
    enabled: true,
    restartRequired: true,
    secretGenerated: true,
  })
})

describe('InstanceSettingsDialog', () => {
  it('结构化字段预填：内存 2G / Aikar 默认开（生成标志进预览）/ 高级参数默认折叠', () => {
    renderDialog()

    expect(screen.getByRole('heading', { name: '实例设置' })).toBeInTheDocument()
    expect(screen.getByText('虚构甲服')).toBeInTheDocument()
    expect(screen.getByText('2.0 GB')).toBeInTheDocument()
    expect(screen.getByText('/ 16.0 GB')).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: '内存分配' })).toHaveAttribute('aria-valuenow', '2')
    expect(screen.getByRole('switch', { name: "JVM 优化 (Aikar's Flags)" })).toBeChecked()

    // 预览 = java + -Xms1G -Xmx2G + Aikar 生成行 + -jar server.jar nogui
    const preview = screen.getByText(/java -Xms1G -Xmx2G/)
    expect(preview).toBeInTheDocument()
    expect(preview).toHaveTextContent('-XX:+UseG1GC')
    expect(preview).toHaveTextContent('-Daikars.new.flags=true')
    expect(preview).toHaveTextContent('-jar server.jar nogui')

    // 高级参数默认折叠：Java 路径输入不可见
    expect(screen.queryByLabelText('Java 路径（可选）')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /高级参数/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('高级参数展开：Java 路径 + JVM 参数多行 + 参数说明（含逐行参数与说明）', async () => {
    renderDialog()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /高级参数/ }))

    const javaPath = screen.getByLabelText('Java 路径（可选）')
    expect(javaPath).toHaveValue('java')
    const jvmArgs = screen.getByLabelText('JVM 参数（每行一个）') as HTMLTextAreaElement
    expect(jvmArgs.value).toContain('-XX:+UseG1GC')
    // 参数说明：系统参数行 + 自定义参数行（每条自定义参数均带「自定义 JVM 参数」说明）
    expect(screen.getByText('-Xmx2G')).toBeInTheDocument()
    expect(screen.getByText('初始堆内存（自动设为最大值的一半）')).toBeInTheDocument()
    expect(screen.getAllByText('自定义 JVM 参数').length).toBeGreaterThan(0)
  })

  it('旧 startCommand 解析（无 aikars 标记）：内存 -Xmx3G + 附加参数保留、Aikar 开关关闭', () => {
    renderDialog(detailWith({ startCommand: 'java -Xmx3G -XX:+UseG1GC -jar server.jar nogui' }))

    expect(screen.getByText('3.0 GB')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: "JVM 优化 (Aikar's Flags)" })).not.toBeChecked()
    // 开关关闭：解析出的附加参数原样保留，且不生成 Aikar 标志
    // 初始堆 = 3/2 = 1.5G → 1536M
    const preview = screen.getByText(/java -Xms1536M -Xmx3G/)
    expect(preview).toHaveTextContent('-XX:+UseG1GC')
    expect(preview).not.toHaveTextContent('-XX:SurvivorRatio=32')
  })

  it('旧 startCommand 解析（含 aikars）：开关开启并生成完整 Aikar 标志', () => {
    renderDialog(
      detailWith({
        startCommand:
          'java -Xms1G -Xmx4G -Dusing.aikars.flags=https://mcflags.emc.gs -jar server.jar nogui',
      }),
    )

    expect(screen.getByText('4.0 GB')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: "JVM 优化 (Aikar's Flags)" })).toBeChecked()
    const preview = screen.getByText(/java -Xms2G -Xmx4G/)
    expect(preview).toHaveTextContent('-XX:MaxGCPauseMillis=200')
    expect(preview).toHaveTextContent('-Daikars.new.flags=true')
  })

  it('结构化 jvmArgs 预填：maxMemory 数值(MB) 解析 + 自定义行保留（Aikar 关）', () => {
    renderDialog(detailWith({ maxMemory: 4096, jvmArgs: ['-Dcustom=1'] }))

    expect(screen.getByText('4.0 GB')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: "JVM 优化 (Aikar's Flags)" })).not.toBeChecked()
    const preview = screen.getByText(/java -Xms2G -Xmx4G/)
    expect(preview).toHaveTextContent('-Dcustom=1')
    expect(preview).not.toHaveTextContent('-XX:SurvivorRatio=32')
  })

  it('滑块 0.5G 步进：数值与命令预览实时联动（非整数 G → M 后缀）', async () => {
    renderDialog()
    const user = userEvent.setup()

    const slider = screen.getByRole('slider', { name: '内存分配' })
    slider.focus()
    await user.keyboard('{ArrowRight}')

    expect(screen.getByText('2.5 GB')).toBeInTheDocument()
    // 2.5G → 2560M；初始堆 = 1.25G → 1280M
    expect(screen.getByText(/java -Xms1280M -Xmx2560M/)).toBeInTheDocument()
  })

  it('Aikar 开关关闭移除生成行、再开启重新生成（自定义行保留）', async () => {
    renderDialog()
    const user = userEvent.setup()

    const toggle = screen.getByRole('switch', { name: "JVM 优化 (Aikar's Flags)" })
    await user.click(toggle)
    expect(screen.getByText(/java -Xms1G -Xmx2G/)).not.toHaveTextContent('-XX:SurvivorRatio=32')

    await user.click(toggle)
    expect(screen.getByText(/java -Xms1G -Xmx2G/)).toHaveTextContent('-XX:SurvivorRatio=32')
  })

  it('两处设置行同形：容器逐类等集 + 行外无额外包裹（就绪态）', async () => {
    renderDialog()
    // 锁实际使用形态：等开关就位（占位态另有用例）
    await screen.findByRole('switch', { name: '实时推送' })

    /** 行容器配方（与抽取前逐字相同）；groupClass = 行所属分组容器，用来判「行外无额外包裹」 */
    const cases = [
      { title: "JVM 优化 (Aikar's Flags)", groupClass: 'flex flex-col gap-4' },
      {
        title: '实时推送',
        groupClass: 'flex flex-col gap-2 border-t border-mcs-border-muted pt-4',
      },
    ]
    const recipe =
      'flex items-center gap-3 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default px-3 py-2'
    const classTokens = (el: Element) => el.className.split(/\s+/).filter(Boolean).sort()

    for (const { title, groupClass } of cases) {
      const titleEl = screen.getByText(title)
      // 行容器 = 标题 <p> 的祖父节点（p → 文本块 → 行）
      const row = titleEl.closest('div.rounded-mcs-sm')
      expect(row).not.toBeNull()
      // 逐类「等集」而非「包含」：多压一个类（如再写一个圆角档）同样转红
      expect(classTokens(row!)).toEqual(recipe.split(' ').sort())
      // 分组容器同样是等集：行外多包一层（带不带类）都会在这里转红
      expect(classTokens(row!.parentElement!)).toEqual(groupClass.split(' ').sort())
      // 三列结构：图标 svg / 文本块 / 控件本体。任何一层多余包裹都会改变行高与图标对齐
      expect(row!.children[0]?.tagName.toLowerCase()).toBe('svg')
      expect(row!.children[1]).toBe(titleEl.parentElement)
      expect(row!.children[2]).toBe(screen.getByRole('switch', { name: title }))
    }
  })

  it('保存成功：PUT 载荷（maxMemory/minMemory/jvmArgs，javaPath 默认不携带）+ toast + 关闭 + 详情失效重拉', async () => {
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()

    // 内存 2G → 4G（4 次 0.5G 步进）
    const slider = screen.getByRole('slider', { name: '内存分配' })
    slider.focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}')
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    expect(await screen.findByText('启动配置已保存，重启实例后生效')).toBeInTheDocument()
    expect(putBodies).toHaveLength(1)
    expect(putBodies[0]).toEqual({
      maxMemory: '4G',
      minMemory: '2G',
      jvmArgs: expect.arrayContaining(['-XX:+UseG1GC', '-Daikars.new.flags=true']),
    })
    expect(putBodies[0]).not.toHaveProperty('javaPath')
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    // 保存后详情查询被失效 → 重拉一次（初始渲染 1 次 + 失效 1 次）
    await waitForDetailRefetch()
  })

  it('自定义 javaPath 保存时随载荷提交', async () => {
    renderDialog()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /高级参数/ }))
    await user.clear(screen.getByLabelText('Java 路径（可选）'))
    await user.type(screen.getByLabelText('Java 路径（可选）'), '/usr/lib/jvm/java-21/bin/java')
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    expect(await screen.findByText('启动配置已保存，重启实例后生效')).toBeInTheDocument()
    expect(putBodies[0]?.javaPath).toBe('/usr/lib/jvm/java-21/bin/java')
  })

  it('保存失败：错误 toast + 弹窗不关闭 + 按钮恢复可点', async () => {
    putShouldFail = true
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '保存配置' }))
    expect(await screen.findByText(/保存失败：/)).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(putBodies).toHaveLength(0)
    expect(screen.getByRole('button', { name: '保存配置' })).not.toBeDisabled()
  })

  it('遗留 startCommand 实例：保存载荷含 startCommand:null（清除旧命令）', async () => {
    const user = userEvent.setup()
    renderDialog(detailWith({ startCommand: 'java -Xmx3G -jar server.jar nogui' }))

    await user.click(screen.getByRole('button', { name: '保存配置' }))
    // 本用例未改动任何可见项 ⇒ 走「无需重启」文案，且**不得**置「待重启」：
    // 否则常驻横幅宣称「启动配置已修改」而实际逐字未变，诱导一次无必要重启。
    expect(await screen.findByText('设置已保存（与之前一致，无需重启）')).toBeInTheDocument()
    expect(useRestartPendingStore.getState().pending['alpha']).toBeUndefined()
    // 清除旧命令：否则 jvmArgs 空数组时 start() 回退 startCommand 静默覆盖新配置。
    // 这一项属内部归一（可见配置没变），故不影响上面「无需重启」的判定
    expect(putBodies[0]).toMatchObject({ startCommand: null })
  })

  it('改动了配置才置「待重启」并提示重启后生效（常驻指示器的唯一数据源）', async () => {
    useRestartPendingStore.setState({ pending: {} })
    const user = userEvent.setup()
    renderDialog()

    const slider = screen.getByRole('slider', { name: '内存分配' })
    slider.focus()
    await user.keyboard('{ArrowRight}')
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    expect(await screen.findByText('启动配置已保存，重启实例后生效')).toBeInTheDocument()
    // 漏了置位，实例页横幅就永不出现（它只读这个集合）
    expect(useRestartPendingStore.getState().pending['alpha']).toBeTypeOf('number')
  })

  it('详情未就绪（undefined）：保存按钮禁用，防止默认值覆盖真实配置', () => {
    renderDialog(undefined)
    expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled()
  })

  it('关闭确认框：一份未保存清单（推送开关也在其中，不再需要豁免说明）', async () => {
    // 这句曾写作「……（实时推送开关是即时保存的，不受此影响）」——那句豁免本身就是两套提交语义的
    // 证据：需要一句话去解释的交互，用户无法从界面自身推断行为。现在推送同属这一次事务
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('switch', { name: '实时推送' }))
    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(
      await screen.findByText('上面有未保存的更改，关闭后这些改动将丢失。'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/即时保存/)).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('取消：直接关闭弹窗', async () => {
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('InstanceSettingsDialog 实时推送开关', () => {
  it('按服务端状态渲染开关，说明只讲结果（不出现 host/端口/凭据这类运维字段）', async () => {
    renderDialog()

    const toggle = await screen.findByRole('switch', { name: '实时推送' })
    expect(toggle).not.toBeChecked()
    // 说明是完整句子（含分号）⇒ 最低 xs（12px），不能落到 2xs 的角标档；秒数与真实轮询间隔同源
    const desc = screen.getByText(/开启后面板能实时收到状态变化/)
    expect(desc).toHaveClass('text-mcs-xs')
    expect(desc).toHaveTextContent(
      `开启后面板能实时收到状态变化；关闭则每 ${FALLBACK_POLL_INTERVAL_MS / 1000} 秒刷新一次`,
    )
    // 界面只留开关 + 一句结果说明：监听地址/端口/访问凭据与手改 server.properties 的告警都不在
    expect(screen.queryByText(/监听/)).toBeNull()
    expect(screen.queryByText(/访问凭据/)).toBeNull()
    expect(screen.queryByText(/server\.properties/)).toBeNull()
  })

  it('拨动开关只改本地草稿：不落库、不关弹窗、不触发重取（取消退得回来）', async () => {
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('switch', { name: '实时推送' }))

    expect(screen.getByRole('switch', { name: '实时推送' })).toBeChecked()
    // 未点保存 ⇒ 一条写请求都不该有；「开关一动就落库」正是让用户误判「都保存好了」的根源
    expect(apiSetPushChannel).not.toHaveBeenCalled()
    expect(putBodies).toHaveLength(0)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('保存才落库：走自己的接口提交，并说清生效时机是重启之后', async () => {
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('switch', { name: '实时推送' }))
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() =>
      expect(apiSetPushChannel).toHaveBeenCalledWith(expect.anything(), 'alpha', true),
    )
    // 只改了推送 ⇒ 回执点名推送，不说成「启动配置已保存」（用户据此才知道去哪一项核对）
    expect(await screen.findByText('实时推送已开启，重启实例后生效')).toBeInTheDocument()
    // 推送同属「重启才生效」⇒ 与启动配置共用同一份待重启集合（实例卡片徽章 + 页头横幅的数据源）
    expect(useRestartPendingStore.getState().pending['alpha']).toBeTypeOf('number')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('关闭：同样在保存时提交，且回执说的是关闭', async () => {
    apiGetPushChannel.mockResolvedValue(PUSH_ON)
    renderDialog()
    const user = userEvent.setup()

    const toggle = await screen.findByRole('switch', { name: '实时推送' })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() =>
      expect(apiSetPushChannel).toHaveBeenCalledWith(expect.anything(), 'alpha', false),
    )
    expect(await screen.findByText('实时推送已关闭，重启实例后生效')).toBeInTheDocument()
  })

  it('两根都改时的回执：一句「设置已保存」覆盖两处（不逐条堆砌）', async () => {
    renderDialog()
    const user = userEvent.setup()

    // 改启动配置 + 拨推送：两个分支各自单独覆盖过，这一条锁的是「同时改」那一支
    const slider = screen.getByRole('slider', { name: '内存分配' })
    slider.focus()
    await user.keyboard('{ArrowRight}')
    await user.click(await screen.findByRole('switch', { name: '实时推送' }))
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    expect(await screen.findByText('设置已保存，重启实例后生效')).toBeInTheDocument()
    expect(apiSetPushChannel).toHaveBeenCalledWith(expect.anything(), 'alpha', true)
    expect(useRestartPendingStore.getState().pending['alpha']).toBeTypeOf('number')
  })

  it('读不到推送状态时只改启动配置：不误写推送（那一项根本没读到现值，无从比较）', async () => {
    // 读失败 ⇒ 不渲染开关、pushDraft 恒 null。若判据写成 `pushDraft !== (data?.enabled ?? false)`，
    // `null !== false` 会让它变成「脏」，保存时把推送静默写成 false
    apiGetPushChannel.mockRejectedValue(new Error('boom'))
    renderDialog()
    const user = userEvent.setup()

    const slider = screen.getByRole('slider', { name: '内存分配' })
    slider.focus()
    await user.keyboard('{ArrowRight}')
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    expect(await screen.findByText('启动配置已保存，重启实例后生效')).toBeInTheDocument()
    expect(apiSetPushChannel).not.toHaveBeenCalled()
  })

  it('推送失败时启动配置的「待重启」仍必须置位：已落库的事实不能没有载体', async () => {
    /* 失败早退不能把另一半的置位一起跳过——否则这份真实待办在屏上没有任何载体，
       而关闭确认框还会对用户说「改动将丢失」 */
    useRestartPendingStore.setState({ pending: {} })
    apiSetPushChannel.mockRejectedValueOnce(new Error('serverside-nope'))
    renderDialog()
    const user = userEvent.setup()

    const slider = screen.getByRole('slider', { name: '内存分配' })
    slider.focus()
    await user.keyboard('{ArrowRight}')
    await user.click(await screen.findByRole('switch', { name: '实时推送' }))
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    expect(await screen.findByText(/但实时推送设置失败/)).toBeInTheDocument()
    expect(putBodies).toHaveLength(1)
    expect(useRestartPendingStore.getState().pending['alpha']).toBeTypeOf('number')
  })

  it('保存中不接受关闭：X 不会走到「不保存」（写请求在途，「将丢失」是假陈述）', async () => {
    let release!: () => void
    apiSetPushChannel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('switch', { name: '实时推送' }))
    await user.click(screen.getByRole('button', { name: '保存配置' }))
    // 在途：关闭按钮仍可点，但这一次点击必须被吞掉（否则用户会以为取消成功了）
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))

    expect(screen.queryByText('未保存的更改')).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    await act(async () => {
      release()
    })
  })

  it('推送写入失败：启动配置已落库这件事必须分说，且弹窗不关（可重试）', async () => {
    apiSetPushChannel.mockRejectedValueOnce(new Error('serverside-nope'))
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('switch', { name: '实时推送' }))
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    // 两件事的真实结局不同，混成一句「保存失败」会让人以为启动配置也没落库
    expect(await screen.findByText(/启动配置已保存，但实时推送设置失败/)).toBeInTheDocument()
    expect(putBodies).toHaveLength(1)
    // 弹窗留着：用户再点一次保存即可重试，不必重新填一遍
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByRole('button', { name: '保存配置' })).not.toBeDisabled()
  })

  it('读不到状态：不渲染开关（「不知道」不能显示成「已关闭」），并说明读失败', async () => {
    apiGetPushChannel.mockRejectedValueOnce(new Error('boom'))
    renderDialog()

    expect(await screen.findByText('状态未知')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: '实时推送' })).toBeNull()
    expect(screen.getByText(/读不到实时推送状态/)).toBeInTheDocument()
  })

  it('读失败给出路：横幅内可重试（复用同一查询）并指向可自查的位置', async () => {
    apiGetPushChannel.mockRejectedValueOnce(new Error('boom'))
    renderDialog()
    const user = userEvent.setup()

    expect(await screen.findByText('状态未知')).toBeInTheDocument()
    // 出路一：指向可自查的位置——该项在世界页「服务器属性」里是只读行，用户能自己去核
    expect(
      screen.getByText(/。可在世界页的「服务器属性」里核对这一项的实际值$/),
    ).toBeInTheDocument()
    // 出路二：重试直接复用既有查询的重取，不另开第二条读路径
    const callsBefore = apiGetPushChannel.mock.calls.length
    await user.click(screen.getByRole('button', { name: /重试/ }))
    await waitFor(() => expect(apiGetPushChannel.mock.calls.length).toBeGreaterThan(callsBefore))
    // 重取成功后开关就位、横幅撤下：读失败不是终态
    expect(await screen.findByRole('switch', { name: '实时推送' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/读不到实时推送状态/)).toBeNull())
  })

  it('状态还没读到：给占位、不给开关（在途既不能显示成「已关闭」，也不能留空）', async () => {
    // 恒 pending：读取期本身就是被测状态，不靠「等多久」来验证
    apiGetPushChannel.mockReturnValue(new Promise<PushChannelState>(() => {}))
    renderDialog()

    expect(await screen.findByText('实时推送')).toBeInTheDocument()
    // 占位只表在途、不表态：不是语义提示容器，也不是开关（开关会把在途显示成已关闭）
    expect(screen.getByRole('status', { name: '正在读取实时推送状态' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: '实时推送' })).toBeNull()
  })

  it('连接未就绪：查询被禁用时既不留骨架也不落开关（isPending ≠ 在途）', async () => {
    // enabled=false ⇒ pending 但不在取：拿 isPending 当在途判据会留下一个永不消失的骨架
    useConnectionStore.setState({ status: 'configuring' })
    renderDialog()

    expect(await screen.findByText('实时推送')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '正在读取实时推送状态' })).toBeNull()
    expect(screen.queryByRole('switch', { name: '实时推送' })).toBeNull()
  })

  it('开关参与「未保存的更改」判定：拨完开关点取消会先问一句（不再静默丢弃）', async () => {
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('switch', { name: '实时推送' }))
    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(
      await screen.findByText('上面有未保存的更改，关闭后这些改动将丢失。'),
    ).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    // 确认「不保存」才真的关：草稿随卸载丢弃，服务端那份没被动过
    await user.click(screen.getByRole('button', { name: '不保存' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(apiSetPushChannel).not.toHaveBeenCalled()
  })
})

/** 等待详情重拉（初始 1 次 + 保存失效后重拉） */
async function waitForDetailRefetch() {
  await vi.waitFor(() => {
    expect(detailFetches).toBeGreaterThanOrEqual(2)
  })
}
