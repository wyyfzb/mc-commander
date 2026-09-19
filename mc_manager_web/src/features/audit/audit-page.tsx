/**
 * AuditPage —— 审计日志 & 命令历史
 * 双 Tab：审计日志（操作记录）/ 命令历史（命令执行记录）
 * TanStack Query 数据获取：isLoading/isFetching/isError 内建，
 * keepPreviousData 翻页不闪烁，过滤器变化经 query key 自动重获取
 * 审计状态 URL 持久化（issue 381）：tab/页码/操作类型/时间起止同步到查询参数，
 * 刷新/分享链接后筛选保持（与核心列表页 useSearchParams 模式对齐）
 * 时间排序切换（issue 383）：正序/倒序（默认倒序，URL 不留参数），切换重置页码保留筛选
 * 命令历史 tab 时间筛选（issue 385）：接入服务端既有 startTime/endTime 参数，
 * 筛选栏样式与倒置防护对齐审计日志 tab（cmdStart/cmdEnd/cmdPage 同样 URL 持久化）
 */
import { useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { useConnectionStore } from '@/stores/connection'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/mcs/page-header'
import { DataTableShell } from '@/components/mcs/data-table-shell'
import { useAuditLogs, useCommandHistory } from '@/api/queries'
import {
  QUICK_RANGES,
  isRangeInverted,
  quickRangeDates,
  toServerEnd,
  toServerStart,
  type QuickRange,
} from './time-range'
import { ACTION_LABELS } from './action-labels'
import { exportAuditLogsToExcel, exportCommandHistoryToExcel } from './audit-export'
import {
  AuditHeader,
  AuditBody,
  CmdHeader,
  CmdBody,
  AUDIT_COLUMNS,
  CMD_COLUMNS,
} from './audit-tables'
import { AuditFilterBar } from './audit-filter-bar'
import { CmdFilterBar } from './cmd-filter-bar'

/** URL 日期参数校验：仅接受 yyyy-MM-dd（与 input type=date 值同构，非法值回退默认不过滤） */
const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/

export function AuditPage() {
  // ── 筛选状态 URL 持久化（issue 381）：state 为唯一真源，URL 为镜像 ──
  // 挂载时惰性读取（非法值回退默认，与无参数访问行为一致）；变更经 setter 包装同步写回。
  // paramsRef 累积同批次多次 patch（如清空筛选四连调）：setSearchParams 的函数式更新
  // 捕获的是本次渲染的闭包值，同批多次调用会互相覆盖，因此先在 ref 上合并再一次性写回。
  const [searchParams, setSearchParams] = useSearchParams()
  const paramsRef = useRef(new URLSearchParams(searchParams))
  const syncParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(paramsRef.current)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
    }
    paramsRef.current = next
    setSearchParams(next, { replace: true })
  }

  const [tab, setTabState] = useState(() => {
    const v = searchParams.get('tab')
    return v === 'audit' || v === 'commands' ? v : 'audit'
  })

  const [auditPage, setAuditPageState] = useState(() => {
    const n = Number(searchParams.get('page'))
    return Number.isInteger(n) && n >= 1 ? n : 1
  })
  const [auditAction, setAuditActionState] = useState(() => {
    const v = searchParams.get('action')
    return v && v in ACTION_LABELS ? v : ''
  })
  const [auditStart, setAuditStartState] = useState(() => {
    const v = searchParams.get('start') ?? ''
    return DATE_PARAM_RE.test(v) ? v : ''
  })
  const [auditEnd, setAuditEndState] = useState(() => {
    const v = searchParams.get('end') ?? ''
    return DATE_PARAM_RE.test(v) ? v : ''
  })
  // 时间排序（issue 383）：仅 asc 留参数（desc 为默认，URL 保持最短）；非法值回退默认
  const [auditOrder, setAuditOrderState] = useState<'asc' | 'desc'>(() =>
    searchParams.get('order') === 'asc' ? 'asc' : 'desc',
  )

  // setter 包装：state 与 URL 镜像同步写回（默认值/空值不留参数，URL 保持最短）
  const setTab = (v: string) => {
    setTabState(v)
    syncParams({ tab: v === 'audit' ? null : v })
  }
  const setAuditPage = (n: number) => {
    setAuditPageState(n)
    syncParams({ page: n === 1 ? null : String(n) })
  }
  const setAuditAction = (v: string) => {
    setAuditActionState(v)
    syncParams({ action: v || null })
  }
  const setAuditStart = (v: string) => {
    setAuditStartState(v)
    syncParams({ start: v || null })
  }
  const setAuditEnd = (v: string) => {
    setAuditEndState(v)
    syncParams({ end: v || null })
  }
  // 切换排序：重置到第 1 页、保留现有筛选（issue 383 验收项）
  const setAuditOrder = (v: 'asc' | 'desc') => {
    setAuditOrderState(v)
    syncParams({ order: v === 'asc' ? 'asc' : null })
    setAuditPage(1)
  }

  // 起止倒置：可见提示并暂停时间过滤（不许静默空结果）；仅一端有值时单边过滤
  const rangeInvalid = isRangeInverted(auditStart, auditEnd)
  const hasTimeRange = Boolean(auditStart || auditEnd)

  // 命中某个快捷区间则高亮（自定义值不命中任何快捷键）
  const activeQuick = useMemo(() => {
    if (!hasTimeRange || rangeInvalid) return undefined
    return QUICK_RANGES.find((q) => {
      const r = quickRangeDates(q.daysBack)
      return r.start === auditStart && r.end === auditEnd
    })
  }, [hasTimeRange, rangeInvalid, auditStart, auditEnd])

  const applyQuick = (q: QuickRange) => {
    const r = quickRangeDates(q.daysBack)
    const same = auditStart === r.start && auditEnd === r.end
    setAuditStart(same ? '' : r.start)
    setAuditEnd(same ? '' : r.end)
    setAuditPage(1)
  }

  const changeDate = (which: 'start' | 'end', v: string) => {
    if (which === 'start') setAuditStart(v)
    else setAuditEnd(v)
    setAuditPage(1)
  }

  const clearTimeRange = () => {
    setAuditStart('')
    setAuditEnd('')
    setAuditPage(1)
  }

  /** 空态排查：筛选（操作类型/时间范围）生效时提供一键清空（issue 343 空态 CTA 补齐） */
  const auditFiltered = Boolean(auditAction) || hasTimeRange
  const clearAuditFilters = () => {
    setAuditAction('')
    setAuditStart('')
    setAuditEnd('')
    setAuditPage(1)
  }

  const auditQuery = useAuditLogs({
    page: auditPage,
    pageSize: 20,
    action: auditAction || undefined,
    // 倒置期间两侧均不传（服务端 created_at 为 UTC「YYYY-MM-DD HH:MM:SS」字符串比较，须先换算）
    startTime: auditStart && !rangeInvalid ? toServerStart(auditStart) : undefined,
    endTime: auditEnd && !rangeInvalid ? toServerEnd(auditEnd) : undefined,
    // desc 为服务端默认不传，请求与历史形态一致（issue 383）
    order: auditOrder === 'asc' ? 'asc' : undefined,
  })

  const [cmdPage, setCmdPageState] = useState(() => {
    const n = Number(searchParams.get('cmdPage'))
    return Number.isInteger(n) && n >= 1 ? n : 1
  })
  const [cmdStart, setCmdStartState] = useState(() => {
    const v = searchParams.get('cmdStart') ?? ''
    return DATE_PARAM_RE.test(v) ? v : ''
  })
  const [cmdEnd, setCmdEndState] = useState(() => {
    const v = searchParams.get('cmdEnd') ?? ''
    return DATE_PARAM_RE.test(v) ? v : ''
  })

  // setter 包装（cmd 前缀参数与审计日志 tab 参数互不冲突）
  const setCmdPage = (n: number) => {
    setCmdPageState(n)
    syncParams({ cmdPage: n === 1 ? null : String(n) })
  }
  const setCmdStart = (v: string) => {
    setCmdStartState(v)
    syncParams({ cmdStart: v || null })
  }
  const setCmdEnd = (v: string) => {
    setCmdEndState(v)
    syncParams({ cmdEnd: v || null })
  }

  // ── 命令历史 tab 时间筛选（issue 385：接入服务端既有 startTime/endTime 参数） ──
  // 起止倒置：与审计日志 tab 同款防护——可见提示并暂停时间过滤
  const cmdRangeInvalid = isRangeInverted(cmdStart, cmdEnd)
  const cmdHasTimeRange = Boolean(cmdStart || cmdEnd)

  const activeQuickCmd = useMemo(() => {
    if (!cmdHasTimeRange || cmdRangeInvalid) return undefined
    return QUICK_RANGES.find((q) => {
      const r = quickRangeDates(q.daysBack)
      return r.start === cmdStart && r.end === cmdEnd
    })
  }, [cmdHasTimeRange, cmdRangeInvalid, cmdStart, cmdEnd])

  const applyQuickCmd = (q: QuickRange) => {
    const r = quickRangeDates(q.daysBack)
    const same = cmdStart === r.start && cmdEnd === r.end
    setCmdStart(same ? '' : r.start)
    setCmdEnd(same ? '' : r.end)
    setCmdPage(1)
  }

  const changeCmdDate = (which: 'start' | 'end', v: string) => {
    if (which === 'start') setCmdStart(v)
    else setCmdEnd(v)
    setCmdPage(1)
  }

  const clearCmdTimeRange = () => {
    setCmdStart('')
    setCmdEnd('')
    setCmdPage(1)
  }

  const cmdQuery = useCommandHistory({
    page: cmdPage,
    pageSize: 20,
    startTime: cmdStart && !cmdRangeInvalid ? toServerStart(cmdStart) : undefined,
    endTime: cmdEnd && !cmdRangeInvalid ? toServerEnd(cmdEnd) : undefined,
  })

  const config = useConnectionStore()
  // 导出：按当前筛选 + 排序口径拉取（服务端零改动，上限 1000 条，issue 384）
  const [exporting, setExporting] = useState(false)
  const handleExport = async () => {
    setExporting(true)
    try {
      await exportAuditLogsToExcel(
        config,
        {
          action: auditAction || undefined,
          startTime: auditStart && !rangeInvalid ? toServerStart(auditStart) : undefined,
          endTime: auditEnd && !rangeInvalid ? toServerEnd(auditEnd) : undefined,
        },
        auditOrder,
      )
    } catch {
      toast.error('导出失败，请重试')
    } finally {
      setExporting(false)
    }
  }

  const refreshing = auditQuery.isFetching || cmdQuery.isFetching

  // 命令历史导出（issue 403）：筛选口径与 cmdQuery 一致（时间起止 + 倒置防护），
  // 服务端固定最新优先；失败 toast 与审计日志导出口径一致
  const [cmdExporting, setCmdExporting] = useState(false)
  const handleCmdExport = async () => {
    setCmdExporting(true)
    try {
      await exportCommandHistoryToExcel(config, {
        startTime: cmdStart && !cmdRangeInvalid ? toServerStart(cmdStart) : undefined,
        endTime: cmdEnd && !cmdRangeInvalid ? toServerEnd(cmdEnd) : undefined,
      })
    } catch {
      toast.error('导出失败，请重试')
    } finally {
      setCmdExporting(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title="审计"
        description="操作日志与命令执行记录"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (tab === 'audit') auditQuery.refetch()
              else cmdQuery.refetch()
            }}
            disabled={refreshing}
          >
            <RefreshCw aria-hidden className={refreshing ? 'animate-spin' : undefined} />
            刷新
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 flex flex-col">
        <TabsList className="w-fit">
          <TabsTrigger value="audit">审计日志</TabsTrigger>
          <TabsTrigger value="commands">命令历史</TabsTrigger>
        </TabsList>

        <TabsContent value="audit" className="min-h-0 flex-1 flex flex-col gap-3 mt-3">
          <AuditFilterBar
            auditAction={auditAction}
            setAuditAction={setAuditAction}
            setAuditPage={setAuditPage}
            activeQuick={activeQuick}
            applyQuick={applyQuick}
            auditStart={auditStart}
            auditEnd={auditEnd}
            changeDate={changeDate}
            hasTimeRange={hasTimeRange}
            clearTimeRange={clearTimeRange}
            auditOrder={auditOrder}
            setAuditOrder={setAuditOrder}
            exporting={exporting}
            handleExport={handleExport}
          />

          {rangeInvalid && (
            <p role="alert" className="text-mcs-xs text-mcs-error-fg">
              起止时间倒置：时间过滤已暂停，调整后自动恢复
            </p>
          )}

          <DataTableShell
            columns={AUDIT_COLUMNS}
            isLoading={auditQuery.isLoading}
            error={auditQuery.isError ? auditQuery.error : undefined}
            isEmpty={
              !auditQuery.isLoading && !auditQuery.isError && auditQuery.data?.data.length === 0
            }
            emptyText={auditFiltered ? '当前筛选条件下暂无记录' : '暂无记录'}
            emptyActions={
              auditFiltered ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearAuditFilters}
                  data-testid="audit-clear-filters"
                >
                  <X aria-hidden />
                  清空筛选
                </Button>
              ) : undefined
            }
            skeletonWidths={['w-20', 'w-14', 'w-24', 'w-36']}
            header={<AuditHeader />}
            pagination={
              auditQuery.data?.pagination
                ? {
                    page: auditPage,
                    totalPages: auditQuery.data.pagination.totalPages,
                    totalItems: auditQuery.data.pagination.total,
                    onPageChange: setAuditPage,
                    variant: 'prev-next',
                    disabled: auditQuery.isFetching,
                  }
                : undefined
            }
          >
            <AuditBody logs={auditQuery.data?.data ?? []} />
          </DataTableShell>
        </TabsContent>

        <TabsContent value="commands" className="min-h-0 flex-1 flex flex-col gap-3 mt-3">
          <CmdFilterBar
            activeQuickCmd={activeQuickCmd}
            applyQuickCmd={applyQuickCmd}
            cmdStart={cmdStart}
            cmdEnd={cmdEnd}
            changeCmdDate={changeCmdDate}
            cmdHasTimeRange={cmdHasTimeRange}
            clearCmdTimeRange={clearCmdTimeRange}
            cmdExporting={cmdExporting}
            handleCmdExport={handleCmdExport}
          />

          {cmdRangeInvalid && (
            <p role="alert" className="text-mcs-xs text-mcs-error-fg">
              起止时间倒置：时间过滤已暂停，调整后自动恢复
            </p>
          )}

          <DataTableShell
            columns={CMD_COLUMNS}
            isLoading={cmdQuery.isLoading}
            error={cmdQuery.isError ? cmdQuery.error : undefined}
            isEmpty={!cmdQuery.isLoading && !cmdQuery.isError && cmdQuery.data?.data.length === 0}
            emptyText="暂无记录"
            skeletonWidths={['w-20', 'w-40', 'w-10', 'w-14', 'w-12']}
            header={<CmdHeader />}
            pagination={
              cmdQuery.data?.pagination
                ? {
                    page: cmdPage,
                    totalPages: cmdQuery.data.pagination.totalPages,
                    totalItems: cmdQuery.data.pagination.total,
                    onPageChange: setCmdPage,
                    variant: 'prev-next',
                    disabled: cmdQuery.isFetching,
                  }
                : undefined
            }
          >
            <CmdBody cmds={cmdQuery.data?.data ?? []} />
          </DataTableShell>
        </TabsContent>
      </Tabs>
    </div>
  )
}
