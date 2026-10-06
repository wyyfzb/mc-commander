/**
 * 数据包面板。
 *
 * 夹具是 MC 26.3 实机返回的**逐字原文**。
 * 取数走 react-query，故这里给一个独立的 QueryClient 并把 `onSendCommand` 做成可控替身。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DatapackPanel } from '../datapack-panel'

/** 实机原文：两段拼接、中间无分隔符；两条已启用且都是 `[名 (来源)]` 形态 */
const LIST_TWO_ENABLED =
  'There are 2 data pack(s) enabled: [vanilla (built-in)], [file/uatpack.zip (world)]There are no more data packs available'
/** 实机原文变体：只启用了一条（用于需要唯一「禁用」按钮的用例） */
const LIST_ONE_ENABLED_ONLY =
  'There are 1 data pack(s) enabled: [file/uatpack.zip (world)]There are no more data packs available'
/** 实机原文：一条已启用 + 一条可用未启用（禁用之后就是这一形态） */
const LIST_ONE_AND_ONE =
  'There are 1 data pack(s) enabled: [vanilla (built-in)]There are 1 data pack(s) available: [file/uatpack.zip (world)]'

function renderPanel(opts: {
  send: (cmd: string) => Promise<string | null>
  connected?: boolean
  mcVersion?: string
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <DatapackPanel
        instanceId="inst-1"
        isRconConnected={opts.connected ?? true}
        mcVersion={opts.mcVersion ?? '26.3'}
        onSendCommand={opts.send}
      />
    </QueryClientProvider>,
  )
  return { ...utils, qc }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DatapackPanel', () => {
  it('渲染已启用与可用两段（含来源限定）', async () => {
    const send = vi.fn(async () => LIST_ONE_AND_ONE)
    renderPanel({ send })

    expect(await screen.findByText('file/uatpack.zip')).toBeInTheDocument()
    // 来源限定要展示出来（world / built-in 的来源不同，排障时要看）
    expect(screen.getByText('world')).toBeInTheDocument()
    expect(screen.getByText('built-in')).toBeInTheDocument()
  })

  it('启用：发出带引号的命令并重取列表', async () => {
    const send = vi.fn(async () => LIST_ONE_AND_ONE)
    renderPanel({ send })
    await screen.findByText('file/uatpack.zip')

    send.mockResolvedValueOnce('Enabling data pack [file/uatpack.zip (world)]')
    await userEvent.click(screen.getByRole('button', { name: '启用' }))

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith('datapack enable "file/uatpack.zip"')
    })
    // 动作后重取：命令调用次数 > 1（首次拉列表 + 动作 + 动作后重取）
    await waitFor(() => expect(send.mock.calls.length).toBeGreaterThan(2))
    expect(await screen.findByText('已启用 file/uatpack.zip')).toBeInTheDocument()
  })

  it('置顶/置底走排序位置形态', async () => {
    const send = vi.fn(async () => LIST_ONE_AND_ONE)
    renderPanel({ send })
    await screen.findByText('file/uatpack.zip')

    send.mockResolvedValueOnce('Enabling data pack [file/uatpack.zip (world)]')
    await userEvent.click(screen.getByRole('button', { name: '置顶' }))
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('datapack enable "file/uatpack.zip" first'),
    )

    send.mockResolvedValueOnce('Enabling data pack [file/uatpack.zip (world)]')
    await userEvent.click(screen.getByRole('button', { name: '置底' }))
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('datapack enable "file/uatpack.zip" last'),
    )
  })

  it('「已是启用状态」走中性提示并说明顺序未改动（不是报错）', async () => {
    const send = vi.fn(async () => LIST_ONE_ENABLED_ONLY)
    renderPanel({ send })
    await screen.findByText('file/uatpack.zip')

    send.mockResolvedValueOnce("Pack 'file/uatpack.zip' is already enabled!")
    await userEvent.click(screen.getByRole('button', { name: '禁用' }))

    // 关键：不能只说「已启用」——用户点的是置底/禁用类操作，必须说清顺序没变
    expect(await screen.findByText(/处于启用状态，加载顺序未改动/)).toBeInTheDocument()
  })

  it('服务端找不到该数据包 → 如实报错', async () => {
    const send = vi.fn(async () => LIST_ONE_ENABLED_ONLY)
    renderPanel({ send })
    await screen.findByText('file/uatpack.zip')

    send.mockResolvedValueOnce("Unknown data pack 'file/uatpack.zip'")
    await userEvent.click(screen.getByRole('button', { name: '禁用' }))
    expect(await screen.findByText(/服务端找不到数据包/)).toBeInTheDocument()
  })

  it('命令没回执 → 报错而不是显示空列表（把「读不到」谎报成「没有」）', async () => {
    const send = vi.fn(async () => null)
    renderPanel({ send })

    expect(await screen.findByText(/命令通道没有返回内容/)).toBeInTheDocument()
    expect(screen.queryByText('没有已启用的数据包')).not.toBeInTheDocument()
  })

  it('返回措辞不认识 → 报错而不是显示空列表', async () => {
    const send = vi.fn(async () => '某种谁也没见过的措辞')
    renderPanel({ send })
    expect(await screen.findByText(/无法识别服务端返回/)).toBeInTheDocument()
  })

  it('未连接命令通道：给说明且动作按钮不可点，也不发命令', async () => {
    const send = vi.fn(async () => LIST_TWO_ENABLED)
    renderPanel({ send, connected: false })

    expect(await screen.findByText(/数据包命令无法下发/)).toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
  })

  it('创建：描述含引号时本地拦下，不发命令（而不是发出去被服务端拒）', async () => {
    const send = vi.fn(async () => LIST_TWO_ENABLED)
    renderPanel({ send })
    await screen.findByText('file/uatpack.zip')
    send.mockClear()

    await userEvent.type(screen.getByLabelText('新数据包名字'), 'uatnew')
    await userEvent.type(screen.getByLabelText('新数据包描述'), 'he said "hi"')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))

    expect(await screen.findByText(/参数不合法/)).toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
  })

  it('创建：正常描述发出去并清空表单', async () => {
    const send = vi.fn(async () => LIST_TWO_ENABLED)
    renderPanel({ send })
    await screen.findByText('file/uatpack.zip')

    await userEvent.type(screen.getByLabelText('新数据包名字'), 'uatnew')
    await userEvent.type(screen.getByLabelText('新数据包描述'), 'UAT 新建')
    send.mockResolvedValueOnce("Created new empty pack with name 'uatnew'")
    await userEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(send).toHaveBeenCalledWith('datapack create uatnew "UAT 新建"'))
    expect(await screen.findByText('已创建 uatnew')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('新数据包名字')).toHaveValue(''))
  })

  it('低于 create 边界（1.21.5）收起新建入口并说明原因，而不是让用户点了才失败', async () => {
    const send = vi.fn(async () => LIST_TWO_ENABLED)
    renderPanel({ send, mcVersion: '1.21.5' })
    await screen.findByText('file/uatpack.zip')

    expect(screen.queryByLabelText('新数据包名字')).toBeNull()
    expect(screen.queryByRole('button', { name: '创建' })).toBeNull()
    // 说清为什么：低版本对 create 只回 Unknown or incomplete command，
    // 会被措辞分类读成「参数不被接受」，用户会以为是自己描述写错了
    const note = screen.getByText(/创建空包需要 1\.21\.6 及以上/)
    expect(note).toHaveTextContent('1.21.5')
    expect(note).toHaveTextContent('/datapack create')
  })

  it('恰好到边界（1.21.6）时新建入口在', async () => {
    const send = vi.fn(async () => LIST_TWO_ENABLED)
    renderPanel({ send, mcVersion: '1.21.6' })
    await screen.findByText('file/uatpack.zip')

    expect(screen.getByLabelText('新数据包名字')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建' })).toBeInTheDocument()
  })
})
