/**
 * 封禁记录弹窗的状态文案。
 *
 * 承重点：**过期与解封不是一回事**——一条记录是「被时间结束」还是「有人解封」，用户据此判断
 * 「要不要再处理」。官方封禁条目带上 `expires` 后，历史里会真出现「自己到期」的记录
 * （此前读侧一律当永久，该分支到不了）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BanRecordsDialog } from '../ban-records-dialog'
import type { BanRecord } from '@/api/types'

const usePlayerBans = vi.fn()
vi.mock('../../queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../queries')>()),
  usePlayerBans: () => usePlayerBans(),
}))

function ban(overrides: Partial<BanRecord> = {}): BanRecord {
  return {
    targetType: 'player',
    target: 'Steve',
    reason: '测试',
    isActive: true,
    isPermanent: false,
    expiresAt: null,
    expired: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderDialog(bans: BanRecord[]) {
  usePlayerBans.mockReturnValue({ data: bans, isLoading: false, isError: false })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BanRecordsDialog
        instanceId="inst-1"
        open
        onOpenChange={() => {}}
        onAction={async () => {}}
      />
    </QueryClientProvider>,
  )
}

const DAY = 86_400_000
const HOUR = 3_600_000

describe('BanRecordsDialog 状态文案', () => {
  it('生效中的临时封禁：显示剩余时间', () => {
    renderDialog([ban({ expiresAt: Date.now() + 2 * DAY + 3 * HOUR })])

    expect(screen.getByText(/剩2天/)).toBeInTheDocument()
  })

  it('永久封禁：显示永久封禁', () => {
    renderDialog([ban({ isPermanent: true, expiresAt: null })])

    expect(screen.getByText('永久封禁')).toBeInTheDocument()
  })

  it('服务端判定为到期结束：说「已到期」，不说「已解封」', () => {
    renderDialog([ban({ isActive: false, expiresAt: Date.now() - DAY, expired: true })])

    expect(screen.getByText('已到期')).toBeInTheDocument()
    expect(screen.queryByText('已解封')).not.toBeInTheDocument()
  })

  it('提前解封的临时封禁：说「已解封」，不说「已到期」', () => {
    renderDialog([ban({ isActive: false, expiresAt: Date.now() + DAY })])

    expect(screen.getByText('已解封')).toBeInTheDocument()
    expect(screen.queryByText('已到期')).not.toBeInTheDocument()
  })

  it('提前解封、且原到期时间后来也过了：仍说「已解封」——结束原因不由时间猜', () => {
    renderDialog([ban({ isActive: false, expiresAt: Date.now() - DAY })])

    expect(screen.getByText('已解封')).toBeInTheDocument()
    expect(screen.queryByText('已到期')).not.toBeInTheDocument()
  })

  it('永久封禁被解封：说「已解封」（它没有到期时间）', () => {
    renderDialog([ban({ isActive: false, isPermanent: true, expiresAt: null })])

    expect(screen.getByText('已解封')).toBeInTheDocument()
    expect(screen.queryByText('已到期')).not.toBeInTheDocument()
  })

  it('一条记录都没有：给空态而不是空白列表', () => {
    renderDialog([])

    expect(screen.getByText(/暂无封禁记录/)).toBeInTheDocument()
  })
})
