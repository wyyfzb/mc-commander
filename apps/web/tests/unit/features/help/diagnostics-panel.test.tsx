/**
 * 排障面板（帮助页「排障」标签页）。
 *
 * 承重点有三条：
 * ① **判据本身**（`buildChecks` 是纯函数）：熔断/未运行/RCON/推送面/磁盘/内存/崩溃/面板错误
 *    每项的结论必须与输入一致——尤其「实例没跑时 RCON 不算问题」「面板日志读不到时不谎称
 *    『面板没有出错』」这两条，写反了会让用户去追一个不存在的问题。
 * ② **真实取数路径**：崩溃历史（`/instances/:id/crash-reports`）是前端须消费的既有契约，
 *    端点漏配只在穿过网络层时才暴露。
 * ③ **空态不撒谎**：崩溃历史为空与面板日志不存在时，说的是「没有读到」而不是「从未发生」。
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import {
  handlers,
  mockCrashHistory,
  mockInstanceStatus,
  mockPanelErrors,
} from '@tests/support/handlers'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { HelpPage } from '@/features/help/help-page'
import { LastOutputDialog } from '@/components/mcs/last-output-dialog'
import {
  DiagnosticsPanel,
  buildChecks,
  panelErrorsCopyText,
  selfCheckCopyText,
} from '@/features/help/diagnostics-panel'
import type { InstanceStatus, PanelErrors, SystemStats } from '@/api/types'

// 判据用例用仓库既有的实例状态夹具（手搓一份会随契约漂移），下面按需覆盖字段
const copyText = vi.fn(async (_text: string) => true)
vi.mock('@/lib/clipboard', () => ({ copyText: (text: string) => copyText(text) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const STATUS: InstanceStatus = mockInstanceStatus

// 崩溃「近期」窗口是时效判据 ⇒ 时点必须显式注入，否则用例随真实时间漂移
const NOW = Date.parse('2026-10-08T10:00:00Z')
const CRASH_24H_LATER = Date.parse('2026-10-08T09:14:02Z')
const CRASH_51D_LATER = Date.parse('2026-11-27T09:14:02Z')

const STATS: SystemStats = {
  cpuUsage: 12.5,
  memoryUsage: 4403,
  totalMemory: 16384,
  memoryPercent: 26.9,
  cpuCores: 4,
  loadAvg: [0.2, 0.3, 0.4],
  uptime: 86_400,
  diskUsage: { primary: { mountpoint: '/', totalGB: 40, usedGB: 5.7, percent: 14.2 }, all: [] },
  diskAlert: { warningPercent: 80, errorPercent: 90 },
  memoryAlert: { warningPercent: 90 },
} as SystemStats

const NO_INSTANCE_ARGS = { instanceId: null }

function checkOf(checks: ReturnType<typeof buildChecks>, key: string) {
  const found = checks.find((c) => c.key === key)
  if (!found) throw new Error(`没有这一项：${key}`)
  return found
}

describe('buildChecks：判据', () => {
  it('未选择实例时，三项实例相关的都判为「未知」而不是正常', () => {
    const checks = buildChecks(NO_INSTANCE_ARGS)
    for (const key of ['instance', 'rcon', 'msmp', 'crash']) {
      expect(checkOf(checks, key).tone).toBe('unknown')
      expect(checkOf(checks, key).verdict).toBe('未选择实例')
    }
  })

  it.each([
    {
      state: '停机',
      isRunning: false,
      startupState: 'stopped' as const,
      checkingStartupStability: false,
      tone: 'bad',
      verdict: '服务器反复退出，已暂停自动启动。',
      next: '先到下方崩溃历史查看末尾日志，再去实例页手动启动。',
    },
    {
      state: '试启未就绪',
      isRunning: true,
      startupState: 'starting' as const,
      checkingStartupStability: false,
      tone: 'warn',
      verdict: '试启动中，尚未确认就绪',
      next: '若迟迟未就绪，可到下方崩溃历史查看末尾日志。',
    },
    {
      state: '接管后就绪未知',
      isRunning: true,
      startupState: 'unknown' as const,
      checkingStartupStability: false,
      tone: 'warn',
      verdict: '服务器就绪状态未知',
      next: '可到下方查看末尾日志。',
    },
    {
      state: '稳定性观察',
      isRunning: true,
      startupState: 'ready' as const,
      checkingStartupStability: true,
      tone: 'warn',
      verdict: '正在确认服务器能否稳定运行',
      next: '请等待稳定性检查完成。',
    },
  ])(
    '保护期间区分$state，只承诺解除暂时限制',
    ({ state: _state, tone, verdict, next, ...phase }) => {
      const checks = buildChecks({
        instanceId: 'inst-1',
        status: {
          ...STATUS,
          ...phase,
          id: 'inst-1',
          autoStart: false,
          autoRestart: false,
          circuitBreakerTripped: true,
          consecutiveCrashes: 4,
        },
      })
      expect(checkOf(checks, 'instance')).toMatchObject({
        tone,
        verdict,
        basis: `连续意外退出 4 次。${next}确认稳定后，面板会解除对自动启动的暂时限制，不会更改启动设置。`,
        action: { label: '去实例页', to: '/instances?focus=inst-1' },
      })
    },
  )

  it.each([
    ['starting', false, '服务器启动中', '等待服务器就绪'],
    ['starting', true, '服务器启动中', '等待服务器就绪'],
    ['unknown', false, '服务器就绪状态未知', '未确认 RCON 可用'],
    ['unknown', true, '服务器就绪状态未知', '已配置，连通性未验证'],
  ] as const)(
    '状态 %s、RCON 配置 %s：不推断运行正常或通道连通',
    (startupState, rcon, instanceVerdict, rconVerdict) => {
      const checks = buildChecks({
        instanceId: 'inst-1',
        status: {
          ...STATUS,
          startupState,
          mcVersion: '26.3',
          capabilities: { rcon, msmp: false, msmpPush: false },
        },
      })
      expect(checkOf(checks, 'instance')).toMatchObject({
        tone: 'unknown',
        verdict: instanceVerdict,
      })
      expect(checkOf(checks, 'rcon')).toMatchObject({ tone: 'unknown', verdict: rconVerdict })
      expect(checkOf(checks, 'msmp')).toMatchObject({
        tone: 'unknown',
        verdict: startupState === 'starting' ? '等待服务器就绪' : '未确认推送可用',
      })
    },
  )

  it('已就绪只证明启动完成，RCON 配置存在不等于连接成功', () => {
    const rcon = checkOf(buildChecks({ instanceId: 'inst-1', status: STATUS }), 'rcon')
    expect(rcon).toMatchObject({ tone: 'unknown', verdict: '已配置，连通性未验证' })
  })

  it('实例未运行时，RCON 判为「无需连通」而不是问题（否则每台停着的实例都挂一条警告）', () => {
    const checks = buildChecks({
      instanceId: 'inst-1',
      status: {
        ...STATUS,
        isRunning: false,
        startupState: 'stopped',
        capabilities: { rcon: false, msmp: false, msmpPush: false },
      },
    })
    expect(checkOf(checks, 'rcon').tone).toBe('unknown')
    expect(checkOf(checks, 'rcon').verdict).toContain('无需连通')
    // 而「实例未运行」本身仍要提醒
    expect(checkOf(checks, 'instance').tone).toBe('warn')
  })

  it('已就绪但 RCON 配置不可用：提醒检查配置，不诊断连接失败', () => {
    const checks = buildChecks({
      instanceId: 'inst-1',
      status: { ...STATUS, capabilities: { rcon: false, msmp: false, msmpPush: false } },
    })
    const rcon = checkOf(checks, 'rcon')
    expect(rcon).toMatchObject({ tone: 'warn', verdict: 'RCON 配置不可用' })
    expect(rcon.basis).toContain('端口与密码')
  })

  it('推送面：低于 MSMP 最低版本判「不适用」并归入正常，不报成用户处理不了的警告', () => {
    // 夹具的 mcVersion 是 1.21.4（早于 MSMP）⇒ 这一项对它不该是「未开启」
    const checks = buildChecks({
      instanceId: 'inst-1',
      status: { ...STATUS, capabilities: { rcon: true, msmp: false, msmpPush: false } },
    })
    const msmp = checkOf(checks, 'msmp')
    // 确定结论（不是「判不出来」）：标 unknown 会占住「要看」的位置，引用户去做没事可做的事
    expect(msmp.tone).toBe('ok')
    expect(msmp.verdict).toContain('不适用')
    expect(msmp.basis).toContain('1.21.9')
    expect(msmp.action).toBeUndefined()
  })

  it('推送面：无法判断的版本不等于已知不支持', () => {
    const checks = buildChecks({
      instanceId: 'inst-1',
      status: { ...STATUS, mcVersion: '25w35a' },
    })
    expect(checkOf(checks, 'msmp')).toMatchObject({
      tone: 'unknown',
      verdict: '未确认此版本支持推送',
    })
  })

  it('推送面：实例停止时不判断新版本的推送状态', () => {
    const checks = buildChecks({
      instanceId: 'inst-1',
      status: { ...STATUS, mcVersion: '26.3', startupState: 'stopped', isRunning: false },
    })
    expect(checkOf(checks, 'msmp')).toMatchObject({
      tone: 'unknown',
      verdict: '实例未运行，无需连通',
    })
  })

  it('推送面：就绪未知不抹掉实际连通的推送能力', () => {
    const checks = buildChecks({
      instanceId: 'inst-1',
      status: {
        ...STATUS,
        mcVersion: '26.3',
        startupState: 'unknown',
        capabilities: { rcon: false, msmp: false, msmpPush: true },
      },
    })
    expect(checkOf(checks, 'instance').tone).toBe('unknown')
    expect(checkOf(checks, 'msmp')).toMatchObject({ tone: 'ok', verdict: '已连通' })
  })

  it('推送面：版本支持时，区分查询可用和两个通道均未探明', () => {
    const modern = { ...STATUS, mcVersion: '26.3' }
    const pushdown = buildChecks({
      instanceId: 'inst-1',
      status: { ...modern, capabilities: { rcon: true, msmp: true, msmpPush: false } },
    })
    const off = buildChecks({
      instanceId: 'inst-1',
      status: { ...modern, capabilities: { rcon: true, msmp: false, msmpPush: false } },
    })
    expect(checkOf(pushdown, 'msmp').tone).toBe('warn')
    expect(checkOf(pushdown, 'msmp').verdict).toContain('推送面未连通')
    expect(checkOf(off, 'msmp').verdict).toBe('未确认推送可用')
  })

  it('磁盘：按服务端下发的两档阈值分别判警告与告警', () => {
    const at = (percent: number) =>
      checkOf(
        buildChecks({
          instanceId: 'inst-1',
          status: STATUS,
          stats: {
            ...STATS,
            diskUsage: { primary: { mountpoint: '/', totalGB: 40, usedGB: 1, percent }, all: [] },
          },
        }),
        'disk',
      )
    expect(at(14.2).tone).toBe('ok')
    expect(at(80).tone).toBe('warn')
    expect(at(92).tone).toBe('bad')
    // 依据里要有阈值与用量：只说「已用 92%」用户不知道判据是什么
    expect(at(92).basis).toContain('90%')
  })

  it('整机内存未采到时，即使百分比为 0 也不判正常', () => {
    const checks = buildChecks({
      instanceId: 'inst-1',
      stats: { ...STATS, totalMemory: 0, memoryUsage: 0, memoryPercent: 0 },
    })
    expect(checkOf(checks, 'memory')).toMatchObject({ tone: 'unknown', verdict: '读不到内存占用' })
  })

  it('读不到资源统计时判为「未知」，不判正常', () => {
    const checks = buildChecks({ instanceId: 'inst-1', status: STATUS })
    expect(checkOf(checks, 'disk').tone).toBe('unknown')
    expect(checkOf(checks, 'memory').tone).toBe('unknown')
  })

  it.each([
    {
      state: '尚未满 24 小时',
      nowMs: CRASH_24H_LATER - 1,
      consecutiveCrashes: 0,
      tone: 'warn',
      verdict: '最近 24 小时内有崩溃报告（共 2 份）',
      basis: '最新一份：23小时前',
    },
    {
      state: '刚好满 24 小时',
      nowMs: CRASH_24H_LATER,
      consecutiveCrashes: 0,
      tone: 'ok',
      verdict: '有历史崩溃报告（共 2 份）',
      basis: '最新一份：1天前',
    },
    {
      state: '保护计数非零但报告已过去 51 天',
      nowMs: CRASH_51D_LATER,
      consecutiveCrashes: 4,
      tone: 'ok',
      verdict: '有历史崩溃报告（共 2 份）',
      basis: '最新一份：51天前',
    },
  ])(
    '崩溃记录按报告时间和份数判断：$state',
    ({ nowMs, consecutiveCrashes, tone, verdict, basis }) => {
      const crash = checkOf(
        buildChecks({
          instanceId: 'inst-1',
          status: { ...STATUS, consecutiveCrashes, circuitBreakerTripped: consecutiveCrashes > 0 },
          history: { items: mockCrashHistory, total: 2, hasMore: false },
          nowMs,
        }),
        'crash',
      )
      expect(crash).toMatchObject({ tone, verdict, basis })
    },
  )

  it('历史请求还没回来时判为「未知」，不说成「从未崩溃过」', () => {
    const checks = buildChecks({ instanceId: 'inst-1', status: STATUS })
    expect(checkOf(checks, 'crash').tone).toBe('unknown')
    expect(checkOf(checks, 'crash').verdict).toBe('读不到崩溃历史')
  })

  it('日志文件还不存在（no-file）⇒ 判正常，理由说成「全新安装的常态」而不是撞事实', () => {
    const missing: PanelErrors = {
      readState: 'no-file',
      available: false,
      entries: [],
      hasMore: false,
      logFile: '/x/error.log',
    }
    const check = checkOf(buildChecks({ instanceId: 'inst-1', errors: missing }), 'panel')
    expect(check.tone).toBe('ok')
    expect(check.verdict).toBe('没有读到错误')
    expect(check.basis).toContain('还不存在')
  })

  it('文件存在但读不到（unreadable）⇒ 报出来，不并进「没有读到错误」', () => {
    const broken: PanelErrors = {
      readState: 'unreadable',
      available: false,
      entries: [],
      hasMore: false,
      logFile: '/x/error.log',
    }
    const check = checkOf(buildChecks({ instanceId: 'inst-1', errors: broken }), 'panel')
    // 不说出来，用户会把「看不到错误史」读成「面板没出错」
    expect(check.tone).toBe('warn')
    expect(check.verdict).toBe('读不到错误日志')
    expect(check.basis).toContain('看不到错误史')
  })

  it('面板错误日志取不到（请求失败）⇒ 判「读不到」而不是「没有读到错误」', () => {
    const check = checkOf(buildChecks({ instanceId: 'inst-1', errors: undefined }), 'panel')
    // 这一条是「我操作失败了来求助」的人最依赖的那一项：绿灯替他背书等于骗他
    expect(check.tone).toBe('unknown')
    expect(check.verdict).toBe('读不到面板错误日志')
    expect(check.basis).toContain('不代表面板没出错')
  })

  it('面板有错误时给出条数与最近一条的首行（多行消息只取首行，结论行必须单行）', () => {
    const check = checkOf(buildChecks({ instanceId: 'inst-1', errors: mockPanelErrors }), 'panel')
    expect(check.tone).toBe('warn')
    expect(check.verdict).toBe('记录 2 条')
    expect(check.basis).toContain('升级实例失败')
    expect(check.basis).not.toContain('\n')
  })
})

describe('自检卡：摘要聚合与层级', () => {
  const server = setupServer(...handlers)
  const renderPanel = () => {
    // 每个用例一份新 client：共享实例会把上一个用例的失败态与缓存带进下一个（实测踩过）
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <DiagnosticsPanel />
        </QueryClientProvider>
      </MemoryRouter>,
    )
  }

  beforeEach(() => {
    server.resetHandlers()
    server.listen()
    useConnectionStore.setState({ status: 'ready', baseUrl: 'http://mock.local', apiKey: 'k' })
    useServerStore.setState({ instanceId: 'inst-1' })
  })
  afterEach(() => server.close())

  it('有「读不到」的项时不得说「全部正常」（摘要按最差项聚合）', async () => {
    // 三条数据源全失败：面板错误日志、资源统计、实例状态都判不出来
    server.use(
      http.get('*/api/v1/system-errors*', () => HttpResponse.error()),
      http.get('*/api/v1/system-stats*', () => HttpResponse.error()),
    )
    renderPanel()

    expect(await screen.findByText('读不到面板错误日志')).toBeInTheDocument()
    expect(screen.queryByText('全部正常')).toBeNull()
    expect(screen.getByText(/项未能判定/)).toBeInTheDocument()
  })

  it('有事的项排在最前，正常项默认折叠（第一眼就是「哪一项要处理」）', async () => {
    renderPanel()
    // 夹具里崩溃记录 1 天前（正常）、面板错误 2 条（注意）⇒ 折叠后只剩需要看的
    expect(await screen.findByText('记录 2 条')).toBeInTheDocument()
    expect(screen.queryByText('已就绪')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /其余 \d+ 项正常/ }))
    expect(screen.getByText('已就绪')).toBeInTheDocument()
  })

  it('自检的「出路」是可用的页内锚点（路由 pushState 不会滚动，只改地址栏 = 点了没反应）', async () => {
    renderPanel()
    const link = await screen.findByRole('link', { name: '看错误列表' })
    expect(link).toHaveAttribute('href', '#panel-errors')
    expect(link.tagName).toBe('A')
  })
})

describe('panelErrorsCopyText：复制载荷', () => {
  it('含面板版本、日志路径与每条的时刻+级别，便于直接贴给维护者', () => {
    const text = panelErrorsCopyText(mockPanelErrors, '0.9.9')
    expect(text).toContain('面板版本：0.9.9')
    expect(text).toContain('/srv/panel/data/logs/error.log')
    expect(text).toContain('[2026-10-05T07:20:11.000Z] [ERROR] 升级实例失败')
  })

  it('超长正文留截断痕，且尾部说明不被长正文挤掉', () => {
    const text = panelErrorsCopyText({
      readState: 'ok',
      available: true,
      hasMore: true,
      logFile: '/srv/panel/data/logs/error.log',
      entries: [{ time: '2026-10-05T07:20:11.000Z', level: 'ERROR', message: 'x'.repeat(9000) }],
    })
    expect(text).toContain('…（正文已截断）')
    expect(text).toContain('更早的见日志文件')
  })
})

describe('selfCheckCopyText：自检结果复制载荷', () => {
  it('逐条带结论与依据，并写明实例与时间（接收方要能自己判断）', () => {
    const checks = buildChecks({
      instanceId: 'inst-1',
      status: STATUS,
      stats: STATS,
      nowMs: NOW,
    })
    const text = selfCheckCopyText(checks, {
      instanceName: '生存服',
      mcVersion: '1.21.4',
      nowMs: NOW,
      panelVersion: '0.9.9',
    })
    expect(text).toContain('实例：生存服（MC 1.21.4）')
    // 面板版本要带上：接收方据此定位「这行为属于哪一版」
    expect(text).toContain('面板版本：0.9.9')
    expect(text).toContain('2026-10-08T10:00:00.000Z')
    expect(text).toContain('- 实例运行：已就绪｜已运行 2h 0m')
    // 依据必须一起带上：只给结论，维护者无从判断
    // 每项一行、结论与依据用「｜」分隔（依据的具体文案由 buildChecks 的用例各自锁）
    expect(text).toMatch(/- 磁盘余量：已用 14\.2%｜.+/)
    expect(text).toMatch(/- 面板自身错误：.+/)
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(checks.length)
  })
})

describe('DiagnosticsPanel：走真实 mock 端点', () => {
  const server = setupServer(...handlers)

  function renderPanel() {
    // 每个用例一份新 client：共享实例会把上一个用例的失败态与缓存带进下一个（实测踩过）
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <DiagnosticsPanel />
        </QueryClientProvider>
      </MemoryRouter>,
    )
  }

  beforeEach(() => {
    copyText.mockClear()
    server.resetHandlers()
    server.resetHandlers()
    server.listen()
    useConnectionStore.setState({ status: 'ready', baseUrl: 'http://mock.local', apiKey: 'k' })
    useServerStore.setState({ instanceId: 'inst-1' })
  })
  afterEach(() => server.close())

  /** 自检的依据行里也会出现同样的原因文本 ⇒ 断言收敛到卡片内（顺带验证锚点容器存在） */
  function card(id: string): HTMLElement {
    const el = document.getElementById(id)
    if (!el) throw new Error(`没有锚点容器：${id}`)
    return el
  }

  it('崩溃历史端点被真实消费：两条记录、类型词与原因都在', async () => {
    renderPanel()
    const history = card('crash-history')
    expect(await within(history).findByText(/Ticking entity/)).toBeInTheDocument()
    expect(within(history).getByText(/崩溃报告/)).toBeInTheDocument()
    expect(within(history).getByText(/JVM 崩溃日志/)).toBeInTheDocument()
  })

  it('从非当前实例的链接进入时，自检、历史、报告和末尾日志均读取目标实例', async () => {
    const user = userEvent.setup()
    const requests: string[] = []
    const envelope = (data: unknown) =>
      HttpResponse.json({
        status: 'ok',
        code: 0,
        message: 'ok',
        timestamp: new Date().toISOString(),
        data,
      })
    const file = { ...mockCrashHistory[0]!, reason: '乙服历史报告中的错误' }
    server.use(
      http.get('*/api/v1/instances/:id', ({ params }) => {
        requests.push(`状态 ${params.id}`)
        return envelope(
          params.id === 'beta'
            ? {
                ...STATUS,
                id: 'beta',
                name: '虚构乙服',
                isRunning: false,
                startupState: 'stopped',
                circuitBreakerTripped: true,
                consecutiveCrashes: 7,
                lastOutput: '乙服的末尾日志',
              }
            : STATUS,
        )
      }),
      http.get('*/api/v1/instances/:id/crash-reports', ({ params }) => {
        requests.push(`历史 ${params.id}`)
        return envelope(
          params.id === 'beta'
            ? { items: [file], total: 3, hasMore: true }
            : { items: [], total: 0, hasMore: false },
        )
      }),
      http.get('*/api/v1/instances/:id/crash-report', ({ params }) => {
        requests.push(`报告 ${params.id}`)
        return envelope(null)
      }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MemoryRouter initialEntries={['/help?instance=beta']}>
        <QueryClientProvider client={qc}>
          <HelpPage />
          <LastOutputDialog />
        </QueryClientProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: '自检 · 虚构乙服' })).toBeVisible()
    expect(screen.getByText(/连续意外退出 7 次/)).toBeVisible()
    expect(screen.getByRole('link', { name: '去实例页' })).toHaveAttribute(
      'href',
      '/instances?focus=beta',
    )
    const history = within(card('crash-history'))
    expect(await history.findByText('乙服历史报告中的错误')).toBeVisible()
    expect(history.getByTitle('3 份')).toBeVisible()
    expect(history.getByText('只显示最近 1 份（共 3 份）')).toBeVisible()
    expect(history.getByText('历史报告不一定对应触发保护的退出。')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '查看末尾日志' }))
    const dialog = await screen.findByRole('dialog', { name: '实例末尾日志' })
    expect(await within(dialog).findByText('乙服的末尾日志')).toBeVisible()
    expect(requests.sort()).toEqual(['历史 beta', '报告 beta', '状态 beta', '状态 beta'].sort())
    expect(useServerStore.getState().instanceId).toBe('inst-1')
    await user.keyboard('{Escape}')
  })

  it('面板错误列表渲染条目与级别，并给出日志路径', async () => {
    renderPanel()
    const errors = card('panel-errors')
    expect(await within(errors).findByText(/升级实例失败/)).toBeInTheDocument()
    // 两条夹具都是 ERROR 级别 ⇒ 用 getAllByText（断言「每条都有自己的级别药丸」）
    expect(within(errors).getAllByText('ERROR')).toHaveLength(2)
    expect(within(errors).getByText(/日志文件：/)).toBeInTheDocument()
  })

  it('自检项随时间取到数据后给出结论（不是停在「未知」）', async () => {
    renderPanel()
    // 四条查询都返回后，正常项折在「其余 N 项正常」里——先确认有正常项，再展开看结论
    await userEvent.click(await screen.findByRole('button', { name: /其余 \d+ 项正常/ }))
    expect(screen.getByText('已就绪')).toBeInTheDocument()
  })

  it('默认展示最新一份的完整诊断（崩溃报告解析），不只给摘要', async () => {
    renderPanel()
    const section = document.getElementById('crash-history')!
    // 选中态与完整诊断两条一起锁：只有选中没有解析 = 用户点了没反应
    const newest = await within(section).findByRole('button', { current: true })
    expect(newest).toHaveTextContent('crash-2026-10-07_09-14-02-server.txt')
    // 完整解析的标志是诊断块（夹具是未命中 ⇒ miss 块）；列表里只有 reason/detail 两行摘要
    expect(await within(section).findByTestId('crash-diagnosis-miss')).toBeInTheDocument()
    expect(within(section).getByText('崩溃报告')).toBeInTheDocument()
  })

  it('点开已被清理的那条：说明「这份产物已不在」，不悄悄换成最新那份', async () => {
    const user = userEvent.setup()
    renderPanel()
    const history = document.getElementById('crash-history')!
    const older = await within(history).findByText(/hs_err_pid2601333\.log/)
    await user.click(older)

    expect(await screen.findByText(/已不在（日志轮转/)).toBeInTheDocument()
  })

  it('「复制自检结果」把结论与依据一起带走', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(await screen.findByRole('button', { name: /复制自检结果/ }))

    expect(copyText).toHaveBeenCalledTimes(1)
    const text = copyText.mock.calls[0]![0]
    expect(text).toContain('MC_Commander 自检结果')
    expect(text).toContain('- 实例运行：')
    // 版本取构建期常量（与「关于」页同一来源），不再依赖更新检查是否成功
    expect(text).toContain(`面板版本：${__APP_VERSION__}`)
  })

  it('面板错误日志读不到（文件在但读不到）⇒ 卡内警示，不退化成「没有读到错误」空态', async () => {
    server.use(
      http.get('*/api/v1/system-errors*', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'ok',
          timestamp: new Date().toISOString(),
          data: {
            readState: 'unreadable',
            available: false,
            entries: [],
            hasMore: false,
            logFile: '/srv/panel/data/logs/error.log',
          },
        }),
      ),
    )
    renderPanel()
    const card = await screen.findByText(/面板读不到自己的错误日志/)
    expect(card).toBeInTheDocument()
    // 「看不到错误史」不能说成「没有错误」
    expect(within(document.getElementById('panel-errors')!).queryByText('没有读到错误')).toBeNull()
  })

  it('崩溃历史为空时给空态，而不是空白一块', async () => {
    server.use(
      http.get('*/api/v1/instances/:id/crash-reports', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'ok',
          timestamp: new Date().toISOString(),
          data: { items: [], total: 0, hasMore: false },
        }),
      ),
    )
    renderPanel()
    const history = document.getElementById('crash-history')!
    expect(await within(history).findByText('没有读到崩溃记录')).toBeInTheDocument()
    // 自检那一项同一口径（空≠从未发生）：它属「正常」项，默认折在「其余 N 项正常」里
    await userEvent.click(screen.getByRole('button', { name: /其余 \d+ 项正常/ }))
    expect(screen.getAllByText('没有读到崩溃记录').length).toBe(2)
    // 枚举失败与「从未崩溃过」在接口上同形 ⇒ 不能断言「实例目录里没有产物」
    expect(screen.queryByText(/实例目录里没有/)).toBeNull()
  })
})
