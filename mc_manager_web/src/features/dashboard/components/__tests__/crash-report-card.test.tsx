/**
 * 崩溃诊断产物卡。
 *
 * 承重点：**产物不存在时整卡不渲染**（没崩过的实例不该多一张空卡），
 * 以及**解析失败时必须如实说明**——显示一张没有内容的卡会让用户以为「没有报错」。
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CrashArtifact } from '@/api/types'
import { MemoryRouter } from 'react-router'
import { CrashReportView, CrashPointerNotice } from '../crash-report-card'

const NOW = new Date('2026-10-05T08:00:00.000Z').getTime()

function renderView(data: CrashArtifact, panelVersion?: string) {
  return render(<CrashReportView data={data} nowMs={NOW} panelVersion={panelVersion} />)
}

// 取数层在包装组件里；这里替换掉 hook 只验证「空态不渲染」
const useCrashArtifact = vi.fn()
const copyText = vi.fn(async (_text: string) => true)
vi.mock('@/lib/clipboard', () => ({ copyText: (text: string) => copyText(text) }))
const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (m: string, o?: unknown) => toastSuccess(m, o),
    error: (m: string) => toastError(m),
  },
}))
vi.mock('@/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/queries')>()),
  useCrashArtifact: () => useCrashArtifact(),
}))

describe('CrashReportView（帮助页的完整诊断与仪表盘共用同一份呈现）', () => {
  it('崩溃报告：呈现已核实字段与顶层异常', async () => {
    renderView({
      available: true,
      kind: 'crash-report',
      fileName: 'crash-2026-10-05_01.11.30-server.txt',
      mtimeMs: NOW - 3600_000,
      sizeBytes: 2991,
      summary: [
        { label: '描述', value: 'Exception in server tick loop' },
        { label: 'Minecraft 版本', value: '26.1' },
      ],
      exception: 'java.lang.IllegalStateException: Failed to configure TLS',
      causedBy: [
        'java.lang.IllegalArgumentException: TLS is enabled but keystore is not configured',
      ],
      stack: ['at net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:742)'],
      sections: ['System Details'],
      excerpt: '---- Minecraft Crash Report ----',
      parseError: null,
    })
    expect(screen.getByText('崩溃报告')).toBeInTheDocument()
    expect(screen.getByText('Exception in server tick loop')).toBeInTheDocument()
    expect(screen.getByText('26.1')).toBeInTheDocument()
    expect(
      screen.getByText('java.lang.IllegalStateException: Failed to configure TLS'),
    ).toBeInTheDocument()
    expect(screen.getByText(/TLS is enabled but keystore is not configured/)).toBeInTheDocument()
    expect(screen.getByText(/crash-2026-10-05_01\.11\.30-server\.txt/)).toBeInTheDocument()
  })

  it('JVM 崩溃日志：标题随 kind 切换，故障行与问题帧都要给出', async () => {
    renderView({
      available: true,
      kind: 'jvm-crash',
      fileName: 'hs_err_pid123.log',
      mtimeMs: NOW,
      sizeBytes: 2082,
      summary: [
        { label: '故障', value: 'SIGSEGV (0xb) at pc=0x00007e9be6698e4f, pid=123, tid=123' },
        { label: '问题帧', value: 'C  [libc.so.6+0x98e4f]' },
      ],
      failure: ['SIGSEGV (0xb) at pc=0x00007e9be6698e4f, pid=123, tid=123'],
      problematicFrame: 'C  [libc.so.6+0x98e4f]',
      excerpt: '# A fatal error has been detected by the Java Runtime Environment:',
      parseError: null,
    })
    expect(screen.getByText('JVM 崩溃日志')).toBeInTheDocument()
    expect(screen.getByText(/SIGSEGV/)).toBeInTheDocument()
    expect(screen.getByText(/libc\.so\.6/)).toBeInTheDocument()
  })

  it('可编程滚动区可键盘聚焦（Chromium 127+ 才默认给滚动容器焦点，Firefox/Safari 不能）', async () => {
    const user = userEvent.setup()
    renderView(missReport())
    // 调用栈与产物原文默认折起，展开后各自的滚动区都要能 Tab 进去
    await user.click(screen.getByRole('button', { name: /调用栈/ }))
    expect(screen.getByText(/at net\.minecraft/).closest('pre')).toHaveAttribute('tabindex', '0')
    await user.click(screen.getByRole('button', { name: /完整产物原文/ }))
    expect(screen.getByText(/Minecraft Crash Report/).closest('pre')).toHaveAttribute(
      'tabindex',
      '0',
    )
  })

  it('解析失败：如实说明原因，且不当成空卡', async () => {
    renderView({
      available: true,
      kind: 'crash-report',
      fileName: 'crash-2026-10-05_01.00.00-server.txt',
      mtimeMs: NOW,
      sizeBytes: 30,
      parseError: '未找到崩溃报告头部标识，无法按崩溃报告解析',
      excerpt: '被截断的文件',
    })
    expect(screen.getByText(/未找到崩溃报告头部标识/)).toBeInTheDocument()
  })

  it('OOM 型 hs_err 没有问题帧 → 不渲染空的「问题帧」行', async () => {
    renderView({
      available: true,
      kind: 'jvm-crash',
      fileName: 'hs_err_pid999.log',
      mtimeMs: NOW,
      sizeBytes: 3646,
      summary: [{ label: '故障', value: 'fatal error: OutOfMemory encountered: Java heap space' }],
      problematicFrame: null,
      parseError: null,
    })
    expect(screen.getByText(/OutOfMemory/)).toBeInTheDocument()
    expect(screen.queryByText('问题帧')).not.toBeInTheDocument()
  })
})

// ── 诊断结论区：命中给结论，未命中不猜并给出路 ──
const HIT_ENTRY = {
  id: 'msmp-invalid-secret',
  matchedBy: 'exception' as const,
  title: '管理协议（MSMP）密钥格式不合法',
  detail: '服务端启动时校验 management-server-secret 失败：该值必须是 40 位字母数字。',
  actions: [
    '到实例设置的「管理协议」里重新生成密钥',
    '确认 server.properties 里的值不是手工填写的短串',
  ],
  verifiedVersions: ['26.1'],
  evidence: ['实测' as const],
}

/** 未命中分支的最小产物：崩溃报告带原始字段 + 调用栈 */
function missReport(overrides: Partial<CrashArtifact> = {}): CrashArtifact {
  return {
    available: true,
    kind: 'crash-report',
    fileName: 'crash-2026-10-05_02.00.00-server.txt',
    mtimeMs: NOW,
    sizeBytes: 100,
    description: 'Something We Have Never Seen',
    minecraftVersion: '26.3',
    exception: 'java.lang.IllegalStateException: 未收录的初始化失败',
    summary: [{ label: '描述', value: 'Something We Have Never Seen' }],
    stack: ['at net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:742)'],
    excerpt: '---- Minecraft Crash Report ----',
    diagnosis: { matched: false, entry: null, instanceVersion: '26.3', verifiedForInstance: null },
    ...overrides,
  }
}

describe('CrashReportView 诊断结论', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    copyText.mockResolvedValue(true)
  })

  it('命中：给出结论、处置动作与结论依据（含已验证版本）', () => {
    renderView({
      available: true,
      kind: 'crash-report',
      fileName: 'crash-2026-10-05_01.10.36-server.txt',
      mtimeMs: NOW,
      sizeBytes: 100,
      description: 'Exception in server tick loop',
      minecraftVersion: '26.1',
      exception: 'java.lang.IllegalStateException: Invalid management server secret',
      diagnosis: {
        matched: true,
        entry: HIT_ENTRY,
        instanceVersion: '26.1',
        verifiedForInstance: true,
      },
    })

    expect(screen.getByText('管理协议（MSMP）密钥格式不合法')).toBeInTheDocument()
    expect(screen.getByText(/必须是 40 位字母数字/)).toBeInTheDocument()
    expect(screen.getByText(/重新生成密钥/)).toBeInTheDocument()
    // 依据要让人能判断结论可信度：证据类型 + 已验证版本
    expect(screen.getByText(/实测样本/)).toBeInTheDocument()
    expect(screen.getByText(/已验证 26\.1/)).toBeInTheDocument()
    // 版本相符时不出现「适用范围」提示
    expect(screen.queryByText(/请结合下方原文判断/)).not.toBeInTheDocument()
  })

  it('结论版本与实例版本不符：提示适用范围，但仍给结论', () => {
    renderView({
      available: true,
      kind: 'crash-report',
      fileName: 'crash-x-server.txt',
      mtimeMs: NOW,
      sizeBytes: 100,
      diagnosis: {
        matched: true,
        entry: HIT_ENTRY,
        instanceVersion: '26.3',
        verifiedForInstance: false,
      },
    })

    expect(screen.getByText('管理协议（MSMP）密钥格式不合法')).toBeInTheDocument()
    expect(screen.getByText(/本条结论在 26\.1 上验证过，当前实例是 26\.3/)).toBeInTheDocument()
  })

  it('实例版本未知（null）：不渲染适用范围提示——不为未知版本编一句话', () => {
    renderView({
      available: true,
      kind: 'crash-report',
      fileName: 'crash-x-server.txt',
      mtimeMs: NOW,
      sizeBytes: 100,
      diagnosis: {
        matched: true,
        entry: HIT_ENTRY,
        instanceVersion: null,
        verifiedForInstance: null,
      },
    })

    expect(screen.getByText('管理协议（MSMP）密钥格式不合法')).toBeInTheDocument()
    expect(screen.queryByText(/请结合下方原文判断/)).not.toBeInTheDocument()
  })

  it.each([[[]], [['']]])(
    '词条版本字段畸形（%j）：不渲染出「已验证 」与「当前实例是 ；」这种破句',
    (verifiedVersions) => {
      renderView({
        available: true,
        kind: 'crash-report',
        fileName: 'crash-x-server.txt',
        mtimeMs: NOW,
        sizeBytes: 100,
        diagnosis: {
          matched: true,
          entry: { ...HIT_ENTRY, verifiedVersions },
          instanceVersion: null,
          verifiedForInstance: false,
        },
      })

      expect(screen.getByText('管理协议（MSMP）密钥格式不合法')).toBeInTheDocument()
      expect(screen.queryByText(/已验证/)).not.toBeInTheDocument()
      expect(screen.queryByText(/当前实例是/)).not.toBeInTheDocument()
    },
  )

  it('未命中（崩溃报告）：明说不猜、给出路；复制的是原始字段与原文，并给复制反馈', async () => {
    const user = userEvent.setup()
    renderView(missReport(), '0.9.9')

    expect(screen.getByTestId('crash-diagnosis-miss')).toBeInTheDocument()
    expect(screen.getByText('这次崩溃不在已知词条里')).toBeInTheDocument()
    expect(screen.getByText(/面板不猜原因/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /复制崩溃信息/ }))

    expect(copyText).toHaveBeenCalledTimes(1)
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('MC_Commander 崩溃诊断反馈'))
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('Something We Have Never Seen'))
    expect(copyText).toHaveBeenCalledWith(
      expect.stringContaining('java.lang.IllegalStateException: 未收录的初始化失败'),
    )
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('崩溃报告里的 MC 版本：26.3'))
    // 面板版本：接收方（模组作者/维护者）据此定位「这行为属于哪一版」
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('面板版本：0.9.9'))
    // 用户拿去给模组作者的就是调用栈与原文，载荷必须带上
    expect(copyText).toHaveBeenCalledWith(
      expect.stringContaining('at net.minecraft.server.MinecraftServer.runServer'),
    )
    await vi.waitFor(
      () => expect(toastSuccess).toHaveBeenCalledWith('崩溃信息已复制', { duration: 1500 }),
      { timeout: 5000 },
    )
  })

  it('复制失败：给出可操作的手动复制引导，不静默', async () => {
    const user = userEvent.setup()
    copyText.mockResolvedValueOnce(false)
    renderView(missReport())

    await user.click(screen.getByRole('button', { name: /复制崩溃信息/ }))

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('复制失败，请手动复制'), {
      timeout: 5000,
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('未命中（崩溃报告）：反馈链接指向 Issue 新建页并预填描述与异常', () => {
    renderView(missReport({ exception: 'java.lang.RuntimeException: boom' }))

    const link = screen.getByRole('link', { name: /反馈到 GitHub/ })
    const href = link.getAttribute('href') ?? ''
    expect(href.startsWith('https://github.com/wyyfzb/mc-commander/issues/new?')).toBe(true)
    expect(decodeURIComponent(href)).toContain('[崩溃诊断] 未收录：Something We Have Never Seen')
    expect(decodeURIComponent(href)).toContain('java.lang.RuntimeException: boom')
  })

  it('未命中（JVM 崩溃日志）：文案与反馈标题都不说「未收录」——该产物没有可锚的键', () => {
    renderView(
      missReport({
        kind: 'jvm-crash',
        fileName: 'hs_err_pid123.log',
        description: null,
        exception: null,
        summary: [{ label: '故障', value: 'SIGSEGV (0xb) at pc=0x0, pid=1, tid=1' }],
      }),
    )

    expect(screen.getByText('这份 JVM 崩溃日志没有可对照的词条')).toBeInTheDocument()
    expect(screen.queryByText('这次崩溃不在已知词条里')).not.toBeInTheDocument()
    const href = decodeURIComponent(
      screen.getByRole('link', { name: /反馈到 GitHub/ }).getAttribute('href') ?? '',
    )
    expect(href).toContain('[崩溃诊断] JVM 崩溃日志：hs_err_pid123.log')
    expect(href).not.toContain('未收录')
  })

  it('服务端没给诊断字段（契约可选）时：不渲染结论区，也不炸', () => {
    renderView({
      available: true,
      kind: 'crash-report',
      fileName: 'crash-x-server.txt',
      mtimeMs: NOW,
      sizeBytes: 100,
      exception: 'java.lang.RuntimeException: boom',
    })

    expect(screen.queryByTestId('crash-diagnosis')).not.toBeInTheDocument()
    expect(screen.queryByTestId('crash-diagnosis-miss')).not.toBeInTheDocument()
    expect(screen.getByText(/java.lang.RuntimeException: boom/)).toBeInTheDocument()
  })
})

describe('CrashPointerNotice（折进终端工具条的崩溃指引）', () => {
  // 完整诊断已收进帮助页；仪表盘只在崩过时留一句指引，不能什么都不说
  const renderPointer = () =>
    render(
      <MemoryRouter>
        <CrashPointerNotice instanceId="inst-1" />
      </MemoryRouter>,
    )

  it('有产物时给一句「什么时候崩过 + 去哪看」', () => {
    useCrashArtifact.mockReturnValue({
      data: {
        kind: 'crash-report',
        mtimeMs: NOW - 3 * 60 * 60 * 1000,
        diagnosis: { matched: false },
      },
    })
    renderPointer()
    expect(screen.getByText(/崩过一次/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '看诊断' })).toHaveAttribute('href', '/help')
  })

  it('从未崩溃过时不渲染（没崩过的实例不该多一条提示）', () => {
    useCrashArtifact.mockReturnValue({ data: null })
    const { container } = renderPointer()
    expect(container).toBeEmptyDOMElement()
  })
})
