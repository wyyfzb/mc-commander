import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PerfSnapshotResponse } from '@mc-commander/schemas'
import { PerfVerdictCard, PerfIdleHint } from '@/features/diagnostics/components/verdict-card'
import {
  HotspotList,
  JfrDetailSection,
  PerfDetailSection,
  formatWindow,
} from '@/features/diagnostics/components/detail-sections'
import {
  SnapshotView,
  isPerfUnsupported,
  SnapshotErrorBanner,
} from '@/features/diagnostics/perf-page'
import { ApiError } from '@/api/client'
import { ErrorCode, getFriendlyErrorText } from '@/api/errors'
import { useServerStore } from '@/stores/server'
import { mockInstanceStatus } from '@tests/support/handlers'

/**
 * 性能诊断呈现层测试。
 *
 * 三条承重口径（都是「显示了错的东西」的风险点，不是装饰）：
 * ① 首屏是**一句人话结论**，不是数据表——结论卡必须先于任何数字表出现且自带依据；
 * ② 面板必须承认这是**一次取样**：写明窗口长度、不出现「实时」；
 * ③ JFR 的 fps 段恒 0，界面不得出现任何帧率字段。
 */

function makeSnapshot(over: Partial<PerfSnapshotResponse> = {}): PerfSnapshotResponse {
  return {
    kind: 'perf',
    collectedAt: '2026-11-01T06:43:50.000Z',
    windowMs: 10013,
    verdict: {
      level: 'healthy',
      headline: '没发现瓶颈：耗时与内存都还有余量',
      detail: '单刻平均耗时 0.1 ms（预算 50 ms）；堆峰值 197 MiB，占上限 19.2%。',
      findings: [
        { label: '单刻平均耗时', value: '0.1 ms', hint: '20 TPS 的单刻预算是 50 ms' },
        { label: '堆峰值占用', value: '197 / 1024 MiB（19.2%）', hint: '口径是已用堆' },
      ],
    },
    perf: {
      mcVersion: '26.3',
      javaVersion: '25.0.5',
      cpus: 4,
      processCpuPercent: 17.55,
      tick: {
        averageMs: 0.129312,
        p99Ms: 0.2,
        maxMs: 0.25,
        samples: 100,
        tickSpan: 201,
        timeSpanMs: 10013,
        ticksPerSecond: 20.07,
      },
      heap: {
        usedPeakMiB: 197.01,
        usedStartMiB: 194.91,
        usedEndMiB: 197.01,
        maxMiB: 1024,
        usedPeakPercent: 19.24,
        samples: 201,
      },
      hotspots: [
        { name: 'scheduledPacketProcessing', sharePercent: 6.34 },
        { name: 'unspecified', sharePercent: 93.66 },
      ],
      dimensions: [
        { name: 'overworld', chunks: 12, entities: 140 },
        { name: 'the_nether', chunks: 0, entities: 0 },
      ],
    },
    jfr: null,
    archivePath: 'debug/profiling/2026-11-01_14_43_13-world-26_3.zip',
    parseWarnings: [],
    ...over,
  }
}

beforeEach(() => {
  useServerStore.setState({
    status: mockInstanceStatus,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    lastStatusEvent: null,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PerfVerdictCard：首屏结论', () => {
  it('结论一句话与依据同时呈现', () => {
    render(<PerfVerdictCard verdict={makeSnapshot().verdict} />)
    expect(
      screen.getByRole('heading', { name: '没发现瓶颈：耗时与内存都还有余量' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/单刻平均耗时 0.1 ms/)).toBeInTheDocument()
    expect(screen.getByText('0.1 ms')).toBeInTheDocument()
  })

  it('三档各自的档位标签', () => {
    const { rerender } = render(<PerfVerdictCard verdict={makeSnapshot().verdict} />)
    expect(screen.getByText('余量充足')).toBeInTheDocument()

    rerender(
      <PerfVerdictCard
        verdict={{ ...makeSnapshot().verdict, level: 'warning', headline: '开始吃力了' }}
      />,
    )
    expect(screen.getByRole('heading', { name: '开始吃力了' })).toBeInTheDocument()
    // 档位标签与结论句是两件事：一句说现状，一个说严重度
    expect(screen.getByText('需要留意')).toBeInTheDocument()

    rerender(
      <PerfVerdictCard
        verdict={{ ...makeSnapshot().verdict, level: 'critical', headline: '单刻耗时超出预算' }}
      />,
    )
    expect(screen.getByRole('heading', { name: '单刻耗时超出预算' })).toBeInTheDocument()
    expect(screen.getByText('已经出问题')).toBeInTheDocument()
  })

  it('findings 的 hint 走正文档 xs，不用 2xs（服务端下发的都是含「，」的完整句子）', () => {
    render(<PerfVerdictCard verdict={makeSnapshot().verdict} />)
    const hint = screen.getByText('口径是已用堆')
    // 2xs（10px）只留给角标/单位/mono 元数据；完整句子最低 xs
    expect(hint).toHaveClass('text-mcs-xs')
    expect(hint).not.toHaveClass('text-mcs-2xs')
  })

  it('findings 的 hint 作为解释呈现，不当成主数值', () => {
    render(<PerfVerdictCard verdict={makeSnapshot().verdict} />)
    expect(screen.getByText('口径是已用堆')).toBeInTheDocument()
  })
})

describe('PerfIdleHint：没取过快照', () => {
  it('说清「还没有」且点明这是一次取样', () => {
    render(<PerfIdleHint />)
    expect(screen.getByText('还没有取过快照')).toBeInTheDocument()
    expect(screen.getByText(/不是持续监控/)).toBeInTheDocument()
  })
})

describe('formatWindow', () => {
  it('毫秒与秒两种说法', () => {
    expect(formatWindow(452)).toBe('452 毫秒')
    expect(formatWindow(10013)).toBe('10.0 秒')
    expect(formatWindow(15000)).toBe('15.0 秒')
  })

  it('非法值说未知，不显示 0', () => {
    expect(formatWindow(0)).toBe('窗口未知')
    expect(formatWindow(Number.NaN)).toBe('窗口未知')
  })
})

describe('HotspotList', () => {
  it('按占比渲染条与百分比', () => {
    render(<HotspotList hotspots={makeSnapshot().perf!.hotspots} />)
    expect(screen.getByText('unspecified')).toBeInTheDocument()
    expect(screen.getByText('93.7%')).toBeInTheDocument()
    expect(screen.getByText('6.3%')).toBeInTheDocument()
  })

  it('空列表给解释而不是空白', () => {
    render(<HotspotList hotspots={[]} />)
    expect(screen.getByText(/没有逐段耗时数据/)).toBeInTheDocument()
  })
})

describe('PerfDetailSection', () => {
  it('耗时分布、各维度加载量、运行时环境三块都在', () => {
    render(<PerfDetailSection detail={makeSnapshot().perf!} windowMs={10013} hotspots={[]} />)
    expect(screen.getByTestId('perf-hotspots')).toBeInTheDocument()
    expect(screen.getByTestId('perf-dimensions')).toBeInTheDocument()
    expect(screen.getByTestId('perf-runtime')).toBeInTheDocument()
    expect(screen.getByText('overworld')).toBeInTheDocument()
    expect(screen.getByText('140')).toBeInTheDocument()
    expect(screen.getByText('26.3')).toBeInTheDocument()
  })

  it('进程 CPU 标明是「自启动以来」的平均值，不是窗口瞬时值', () => {
    render(<PerfDetailSection detail={makeSnapshot().perf!} windowMs={10013} hotspots={[]} />)
    expect(screen.getByText('17.55%')).toBeInTheDocument()
    expect(screen.getByText(/自启动以来/)).toBeInTheDocument()
  })

  it('区块/实体表用行列语义（th scope=col）', () => {
    render(<PerfDetailSection detail={makeSnapshot().perf!} windowMs={10013} hotspots={[]} />)
    const table = within(screen.getByTestId('perf-dimensions')).getByRole('table')
    expect(within(table).getByRole('columnheader', { name: '区块' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: '实体' })).toBeInTheDocument()
  })
})

describe('isPerfUnsupported：按错误码判，不按文案判', () => {
  /**
   * 这组用例锁的是一个真实缺陷的复现路径：判据曾写成
   * `getFriendlyErrorText(err).includes('不支持')`，而 40000 的 message 在展示层被覆盖成
   * 「请求参数校验失败」⇒ 判据恒 false ⇒ 重试按钮常驻，而重试一条不存在的命令永远不会成功。
   * 故第一条断言刻意走**完整展示链**：即使 message 被覆盖得面目全非，判据仍必须成立。
   */
  it('服务端 message 被本地化层覆盖后，判据仍然成立（原缺陷的复现路径）', () => {
    const err = new ApiError(
      ErrorCode.PERF_UNSUPPORTED,
      400,
      '该服务端版本不支持性能快照（/perf），请升级到带 /perf 的版本',
      null,
    )
    // 展示文案不含「不支持」也不影响判定
    expect(getFriendlyErrorText(err)).toBe(
      '该服务端版本不支持性能快照（/perf），请升级到带 /perf 的版本',
    )
    expect(isPerfUnsupported(err)).toBe(true)
  })

  it('40000 通用入参错误不算「不支持」（那个该保留重试）', () => {
    const err = new ApiError(ErrorCode.VALIDATION_ERROR, 400, 'kind must be one of perf, jfr', null)
    expect(isPerfUnsupported(err)).toBe(false)
  })

  it('非 ApiError（网络错误等）不算「不支持」', () => {
    expect(isPerfUnsupported(new Error('网络错误'))).toBe(false)
    expect(isPerfUnsupported(null)).toBe(false)
    expect(isPerfUnsupported(undefined)).toBe(false)
  })

  /**
   * 反向用例：码不是 `PERF_UNSUPPORTED`、而 message 字面含「不支持」。
   * 这样「按码判」与「按文案判」才会给出不同结果——反向用例缺了它，两种实现不可区分。
   * 用不在本地化表里的码只是为了让 message 原样透传（表内的码会被覆盖成别的文案，
   * 文案判据碰巧为假，同样抓不住缺陷）；换成任何未登记的码效果相同。
   */
  it('文案里带「不支持」但码不是它时不算（文案不能当判据）', () => {
    const err = new ApiError(49999, 400, '该服务端版本不支持这条命令', null)
    expect(getFriendlyErrorText(err)).toContain('不支持')
    expect(isPerfUnsupported(err)).toBe(false)
  })
})

/**
 * 「码 → 是否显示重试」的**接线**测试。
 *
 * 只测 `isPerfUnsupported` 不够：把页面接成 `false`（或忘了用）时纯函数照样正确，
 * 而 S2-1 的原始症状（重试按钮该消失时不消失）恰好长在接线上。
 * 双向断言缺一不可——只断言「不支持时不显示」，一个恒不渲染按钮的实现也能通过。
 */
describe('SnapshotErrorBanner：重试入口的显隐', () => {
  const noop = () => {}

  it('码是 PERF_UNSUPPORTED → 不给重试入口（重试一条不存在的命令不会成功）', () => {
    render(
      <SnapshotErrorBanner
        error={new ApiError(ErrorCode.PERF_UNSUPPORTED, 400, '该服务端版本不支持性能快照', null)}
        onRetry={noop}
        retrying={false}
      />,
    )
    expect(screen.queryByRole('button', { name: /重试/ })).not.toBeInTheDocument()
    // 但失败原因仍要说清楚
    expect(screen.getByText(/没取到快照/)).toBeInTheDocument()
    expect(screen.getByText(/不支持性能快照/)).toBeInTheDocument()
  })

  it('普通失败 → 给重试入口，点了会回调', async () => {
    const onRetry = vi.fn()
    render(
      <SnapshotErrorBanner
        error={new ApiError(ErrorCode.SERVER_ERROR, 500, '等待性能快照包超时', null)}
        onRetry={onRetry}
        retrying={false}
      />,
    )
    const button = screen.getByRole('button', { name: /重试/ })
    await userEvent.click(button)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('通用入参错误 40000 仍给重试（分不出能力缺失与入参错时不擅自隐藏出口）', () => {
    render(
      <SnapshotErrorBanner
        error={new ApiError(ErrorCode.VALIDATION_ERROR, 400, 'kind 不合法', null)}
        onRetry={noop}
        retrying={false}
      />,
    )
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
  })

  it('重试在途时按钮禁用（防连点重复采集）', () => {
    render(
      <SnapshotErrorBanner
        error={new ApiError(ErrorCode.SERVER_ERROR, 500, '超时', null)}
        onRetry={noop}
        retrying
      />,
    )
    expect(screen.getByRole('button', { name: /重试/ })).toBeDisabled()
  })
})

describe('维度名的使用边界', () => {
  /**
   * 模组维度的展示名是 `ns:dim` 形态（冒号）。它只能作为**文本**出现：
   * 一旦进 id / class / data-*，冒号在 CSS 选择器里要转义，而 selector 一处漏转义就是
   * 静默查不到元素（比报错更难发现）。这条断言锁住「只当文本用」这个边界。
   */
  it('带冒号的维度名只出现在文本里，不进 id / class / data-*', () => {
    const detail = {
      mcVersion: '26.3',
      javaVersion: '25.0.5',
      cpus: 4,
      processCpuPercent: 1,
      tick: null,
      heap: null,
      hotspots: [],
      dimensions: [{ name: 'mymod:lobby', chunks: 3, entities: 7 }],
    }
    const { container } = render(
      <PerfDetailSection detail={detail} windowMs={10000} hotspots={[]} />,
    )
    const offenders: string[] = []
    for (const el of Array.from(container.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        // title 是悬停提示，承载完整名正是它的用途
        if (attr.name !== 'title' && attr.value.includes('mymod:lobby')) {
          offenders.push(`${el.tagName}.${attr.name}`)
        }
      }
    }
    expect(offenders).toEqual([])
    expect(container.textContent).toContain('mymod:lobby')
  })
})

describe('JfrDetailSection', () => {
  const jfr = {
    durationMs: 15000,
    gcCount: 3,
    gcOverheadPercent: 1.2,
    gcTotalDurationMs: 180,
    allocationRateMiBPerSecond: 42.5,
    cpuJvmAveragePercent: 12.3,
    tickAverageMs: 8,
    tickMaxMs: 20,
  }

  it('GC 与分配数据呈现', () => {
    render(<JfrDetailSection detail={jfr} />)
    expect(screen.getByText(/3 次/)).toBeInTheDocument()
    expect(screen.getByText('42.5 MiB/秒')).toBeInTheDocument()
  })

  it('不出现任何帧率字段（服务端恒 0，展示就是错）', () => {
    const { container } = render(<JfrDetailSection detail={jfr} />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/fps/i)
    expect(text).not.toMatch(/帧/i)
  })

  it('字段缺失时如实说未取到，不显示 0', () => {
    render(
      <JfrDetailSection
        detail={{ ...jfr, allocationRateMiBPerSecond: null, cpuJvmAveragePercent: null }}
      />,
    )
    expect(screen.getAllByText('未取到').length).toBeGreaterThanOrEqual(2)
  })
})

describe('SnapshotView：取样口径声明', () => {
  it('写明窗口长度并且声明「不会自动更新」', () => {
    render(<SnapshotView snapshot={makeSnapshot()} />)
    const line = screen.getByTestId('perf-window')
    expect(line).toHaveTextContent('取样窗口')
    expect(line).toHaveTextContent('10.0 秒')
    expect(line).toHaveTextContent('不会自动更新')
  })

  it('不出现「实时」这类会让人以为在持续监控的措辞', () => {
    const { container } = render(<SnapshotView snapshot={makeSnapshot()} />)
    expect(container.textContent ?? '').not.toMatch(/实时/)
  })

  it('结论卡排在佐证卡之前（用户先看答案）', () => {
    render(<SnapshotView snapshot={makeSnapshot()} />)
    const verdict = screen.getByTestId('perf-verdict')
    const hotspots = screen.getByTestId('perf-hotspots')
    // compareDocumentPosition 的 FOLLOWING 位表示 verdict 在 hotspots 之前
    expect(
      verdict.compareDocumentPosition(hotspots) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('解析降级逐条列出', () => {
    render(
      <SnapshotView
        snapshot={makeSnapshot({
          parseWarnings: ['产物内缺少 server/stats.txt，单刻耗时无从得知'],
        })}
      />,
    )
    expect(screen.getByText('产物里有读不出来的部分')).toBeInTheDocument()
    expect(screen.getByText(/缺少 server\/stats.txt/)).toBeInTheDocument()
  })

  it('产物路径可见（用户能照着找文件）', () => {
    render(<SnapshotView snapshot={makeSnapshot()} />)
    expect(screen.getByText(/debug\/profiling\//)).toBeInTheDocument()
  })

  it('没有产物时不给下载按钮', () => {
    render(<SnapshotView snapshot={makeSnapshot({ archivePath: null })} />)
    expect(screen.queryByRole('button', { name: /下载产物/ })).not.toBeInTheDocument()
    expect(screen.getByText(/没有取到可下载的产物/)).toBeInTheDocument()
  })

  it('jfr 快照渲染 GC 卡而不是 perf 的耗时分布', () => {
    render(
      <SnapshotView
        snapshot={makeSnapshot({
          kind: 'jfr',
          perf: null,
          windowMs: 15000,
          jfr: {
            durationMs: 15000,
            gcCount: 3,
            gcOverheadPercent: 1.2,
            gcTotalDurationMs: 180,
            allocationRateMiBPerSecond: 42.5,
            cpuJvmAveragePercent: 12.3,
            tickAverageMs: 8,
            tickMaxMs: 20,
          },
          archivePath: 'debug/jfr-report-server-2026-11-01-144350.json',
        })}
      />,
    )
    expect(screen.getByTestId('jfr-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('perf-hotspots')).not.toBeInTheDocument()
    expect(screen.getByTestId('perf-window')).toHaveTextContent('15.0 秒')
  })
})

describe('下载产物', () => {
  it('点下载按钮走到文件下载端点', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Blob(['zip']), {
        status: 200,
        headers: { 'content-type': 'application/zip', 'content-length': '3' },
      }),
    )
    // jsdom 不实现 ObjectURL 的创建与回收
    const createSpy = vi.fn(() => 'blob:mock')
    const revokeSpy = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createSpy, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeSpy, configurable: true })

    render(<SnapshotView snapshot={makeSnapshot()} />)
    await userEvent.click(screen.getByRole('button', { name: /下载产物/ }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const url = String(fetchSpy.mock.calls[0]?.[0])
    expect(url).toContain('/files/download')
    expect(decodeURIComponent(url)).toContain('debug/profiling/2026-11-01_14_43_13-world-26_3.zip')
    await waitFor(() => expect(createSpy).toHaveBeenCalled())
  })
})
