/**
 * 排障面板（帮助页「排障」标签页）。
 *
 * 承重点有三条：
 * ① **判据本身**（`buildChecks` 是纯函数）：熔断/未运行/RCON/推送面/磁盘/内存/崩溃/面板错误
 *    每项的结论必须与输入一致——尤其「实例没跑时 RCON 不算问题」「面板日志读不到时不谎称
 *    『面板没有出错』」这两条，写反了会让用户去追一个不存在的问题。
 * ② **真实取数路径**：崩溃历史（`/instances/:id/crash-reports`）是此前前端零消费的既有契约，
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
} from '@/test/mocks/handlers'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import {
  DiagnosticsPanel,
  buildChecks,
  panelErrorsCopyText,
  selfCheckCopyText,
} from '../diagnostics-panel'
import type { InstanceStatus, PanelErrors, SystemStats } from '@/api/types'

// 判据用例用仓库既有的实例状态夹具（手搓一份会随契约漂移），下面按需覆盖字段
const copyText = vi.fn(async (_text: string) => true)
vi.mock('@/lib/clipboard', () => ({ copyText: (text: string) => copyText(text) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const STATUS: InstanceStatus = mockInstanceStatus

// 崩溃「近期」窗口是时效判据 ⇒ 时点必须显式注入，否则用例随真实时间漂移
const NOW = Date.parse('2026-10-08T10:00:00Z')
// 夹具里最近一次崩溃是 2026-10-07T09:14Z ⇒ 距 NOW 约 24.8 小时，刚过窗口
const NOW_1H_AFTER_CRASH = Date.parse('2026-10-07T10:14:02Z')

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

  it('熔断优先于「未运行」：报出连续崩溃次数', () => {
    const checks = buildChecks({
      instanceId: 'inst-1',
      status: { ...STATUS, isRunning: false, circuitBreakerTripped: true, consecutiveCrashes: 4 },
    })
    const instance = checkOf(checks, 'instance')
    expect(instance.tone).toBe('bad')
    expect(instance.verdict).toContain('4 次')
  })

  it('实例未运行时，RCON 判为「无需连通」而不是问题（否则每台停着的实例都挂一条警告）', () => {
    const checks = buildChecks({
      instanceId: 'inst-1',
      status: {
        ...STATUS,
        isRunning: false,
        capabilities: { rcon: false, msmp: false, msmpPush: false },
      },
    })
    expect(checkOf(checks, 'rcon').tone).toBe('unknown')
    expect(checkOf(checks, 'rcon').verdict).toContain('无需连通')
    // 而「实例未运行」本身仍要提醒
    expect(checkOf(checks, 'instance').tone).toBe('warn')
  })

  it('实例在运行但 RCON 没连上：警告 + 给出依据', () => {
    const checks = buildChecks({
      instanceId: 'inst-1',
      status: { ...STATUS, capabilities: { rcon: false, msmp: false, msmpPush: false } },
    })
    const rcon = checkOf(checks, 'rcon')
    expect(rcon.tone).toBe('warn')
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

  it('推送面：版本支持时，查询面可用与全未开启给不同结论（指向不同处置）', () => {
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
    expect(checkOf(off, 'msmp').verdict).toBe('未开启')
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

  it('读不到资源统计时判为「未知」，不判正常', () => {
    const checks = buildChecks({ instanceId: 'inst-1', status: STATUS })
    expect(checkOf(checks, 'disk').tone).toBe('unknown')
    expect(checkOf(checks, 'memory').tone).toBe('unknown')
  })

  it('崩溃历史为空说「没有读到」，不为空时说清次数与最近一次原因', () => {
    const empty = checkOf(
      buildChecks({
        instanceId: 'inst-1',
        status: STATUS,
        history: { items: [], total: 0, hasMore: false },
      }),
      'crash',
    )
    expect(empty.tone).toBe('ok')
    expect(empty.verdict).toBe('没有读到崩溃记录')

    const history = { items: mockCrashHistory, total: 2, hasMore: false }
    const recent = checkOf(
      buildChecks({ instanceId: 'inst-1', status: STATUS, history, nowMs: NOW_1H_AFTER_CRASH }),
      'crash',
    )
    expect(recent.tone).toBe('warn')
    expect(recent.verdict).toContain('24 小时')
    expect(recent.basis).toContain('最近一次')
    // 原因紧接着就在崩溃历史里逐条列出，自检行不再重复同一句话
    expect(recent.basis).not.toContain('Ticking entity')

    // 几天前崩过 ≠ 现在有问题：只陈述事实，不长期挂一条警告（挂了就会把真要看的淹掉）
    const old = checkOf(
      buildChecks({ instanceId: 'inst-1', status: STATUS, history, nowMs: NOW }),
      'crash',
    )
    expect(old.tone).toBe('ok')
    expect(old.verdict).toContain('2 次')
  })

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
    expect(screen.queryByText('运行中')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /其余 \d+ 项正常/ }))
    expect(screen.getByText('运行中')).toBeInTheDocument()
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
    expect(text).toContain('- 实例运行：运行中｜已运行 2h 0m')
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
    expect(screen.getByText('运行中')).toBeInTheDocument()
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
    // 版本取自既有 check-update 契约（夹具 current: '0.1.0'），不为它新增接口
    expect(text).toContain('面板版本：0.1.0')
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
