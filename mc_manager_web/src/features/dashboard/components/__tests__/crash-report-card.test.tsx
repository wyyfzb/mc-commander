/**
 * 崩溃诊断产物卡。
 *
 * 承重点：**产物不存在时整卡不渲染**（没崩过的实例不该多一张空卡），
 * 以及**解析失败时必须如实说明**——显示一张没有内容的卡会让用户以为「没有报错」。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { CrashArtifact } from '@/api/types'
import { CrashReportView, CrashReportCard } from '../crash-report-card'

const NOW = new Date('2026-10-05T08:00:00.000Z').getTime()

function renderView(data: CrashArtifact) {
  return render(<CrashReportView data={data} nowMs={NOW} />)
}

// 取数层在包装组件里；这里替换掉 hook 只验证「空态不渲染」
const useCrashArtifact = vi.fn()
vi.mock('@/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/queries')>()),
  useCrashArtifact: () => useCrashArtifact(),
}))

describe('CrashReportCard', () => {
  it('从未崩溃过（服务端返回 null）→ 取数包装整卡不渲染', () => {
    useCrashArtifact.mockReturnValue({ data: null })
    const { container } = render(<CrashReportCard instanceId="inst-1" />)
    expect(container).toBeEmptyDOMElement()
  })

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
