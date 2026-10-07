import { useState } from 'react'
import { Package, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/mcs/chip'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Input } from '@/components/ui/input'
import { useDatapackList } from '../queries'
import {
  buildDatapackCreateCommand,
  buildDatapackDisableCommand,
  buildDatapackEnableCommand,
  parseDatapackAction,
  supportsDatapackCreate,
  type DatapackActionOutcome,
} from '@/lib/mc-datapack'

/**
 * 数据包管理面板（世界页签）。
 *
 * 与「插件/Mod」的根本区别：数据包有**官方命令面**，可运行期启停与排序；Mod 只能改文件 +
 * 重启。故这里全部走命令，不碰文件。
 *
 * 命令返回的两类措辞分别解析（`list` 与动作），分类结果决定反馈级别：
 * 「已是启用状态」既不是成功也不是失败，故单独给中性提示而不是红色报错。
 *
 * ⚠️ `create` 是**较新版本才有的子命令**：实测边界为 **1.21.6**（判据取自服务端 jar 的
 * `commands.datapack.create.*` 翻译键，见 lib/mc-datapack.ts 的 supportsDatapackCreate）。
 * 低于该版本时服务端只回 `Unknown or incomplete command`，而现有措辞分类会把它读成
 * 「参数不被接受」——那会让用户以为是自己描述写错了。故按**版本**收起该入口并说明原因，
 * 而不是把它发出去让它失败。
 */

interface DatapackPanelProps {
  instanceId: string | null
  isRconConnected: boolean
  /** 服务器版本（世界页来自 status 查询）：用于判定 `create` 子命令是否可用 */
  mcVersion: string
  /** 版本还没落定（status 查询在途）。与「版本未知」分开：在途时整段不渲染，避免闪一下再收 */
  mcVersionPending: boolean
  onSendCommand: (command: string) => Promise<string | null>
}

/** 动作结果 → 反馈文案与档位。注意「已是启用状态」走中性档，不是失败 */
function outcomeFeedback(o: DatapackActionOutcome): {
  tone: 'success' | 'info' | 'error'
  text: string
} {
  switch (o.outcome) {
    case 'enabled':
      return { tone: 'success', text: `已启用 ${o.entry.name}` }
    case 'disabled':
      return { tone: 'success', text: `已禁用 ${o.entry.name}` }
    case 'already-enabled':
      return { tone: 'info', text: `${o.name} 处于启用状态，加载顺序未改动` }
    case 'unknown-pack':
      return { tone: 'error', text: `服务端找不到数据包 ${o.name}` }
    case 'created':
      return { tone: 'success', text: `已创建 ${o.name}` }
    case 'invalid-name':
      return { tone: 'error', text: `名字不合法：${o.name}` }
    case 'bad-arguments':
      return { tone: 'error', text: '命令参数不被接受（描述不能为空，且不应含引号）' }
    default:
      // 措辞不认识：把服务端原文摆出来，不猜成成功
      return { tone: 'info', text: `服务端返回了未识别的措辞：${o.raw}` }
  }
}

export function DatapackPanel({
  instanceId,
  isRconConnected,
  mcVersion,
  mcVersionPending,
  onSendCommand,
}: DatapackPanelProps) {
  // 列表走 query：loading/error/refetch 都由它管，不必自己写 effect + setState
  // （本仓已把 set-state-in-effect 清零，勿回潮）
  const listQuery = useDatapackList(instanceId, onSendCommand, isRconConnected)
  const enabled = listQuery.data?.enabled ?? null
  const available = listQuery.data?.available ?? null
  const loading = listQuery.isLoading
  const loadError = listQuery.error
    ? listQuery.error instanceof Error
      ? listQuery.error.message
      : String(listQuery.error)
    : null
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'info' | 'error'
    text: string
  } | null>(null)
  const [newId, setNewId] = useState('')
  const [newDesc, setNewDesc] = useState('')

  /** 发一条动作命令并把返回分类成反馈，随后重读列表（排序/启用状态都可能变） */
  const runAction = async (
    key: string,
    build: () => { command: string | null; error: string | null },
  ) => {
    const built = build()
    if (!built.command) {
      setFeedback({ tone: 'error', text: `参数不合法（${built.error}），未发送命令` })
      return
    }
    setBusy(key)
    setFeedback(null)
    try {
      const raw = await onSendCommand(built.command)
      setFeedback(outcomeFeedback(parseDatapackAction(raw ?? '')))
      await listQuery.refetch()
    } catch (e) {
      setFeedback({ tone: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const disabled = !isRconConnected || busy !== null
  const hasOrdering = enabled !== null && enabled.length > 1
  const canCreate = supportsDatapackCreate(mcVersion)

  return (
    <Card className="flex flex-col gap-3" size="default">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Package className="size-4" aria-hidden="true" />
          数据包
        </CardTitle>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void listQuery.refetch()}
          disabled={disabled || loading}
        >
          <RefreshCw className={loading ? 'animate-spin' : undefined} aria-hidden="true" />
          刷新
        </Button>
      </CardHeader>

      <CardBody className="flex flex-col gap-3">
        {!isRconConnected && (
          <NoticeBanner variant="neutral" icon={Package}>
            服务器未运行或命令通道未连接，数据包命令无法下发。
          </NoticeBanner>
        )}

        {loadError && (
          <NoticeBanner variant="warning" icon={Package}>
            {loadError}
          </NoticeBanner>
        )}

        {feedback && (
          <NoticeBanner
            variant={
              feedback.tone === 'error' ? 'error' : feedback.tone === 'info' ? 'neutral' : 'success'
            }
            icon={Package}
          >
            {feedback.text}
          </NoticeBanner>
        )}

        {isRconConnected && loading && enabled === null && !loadError && (
          <p className="text-mcs-xs text-mcs-text-muted">正在读取数据包列表…</p>
        )}

        {enabled && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-mcs-xs font-medium text-mcs-text-muted">
              已启用（{enabled.length}）
            </h3>
            {enabled.length === 0 ? (
              <p className="text-mcs-2xs text-mcs-text-muted">没有已启用的数据包</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {enabled.map((p, i) => (
                  <li key={p.name} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-mcs-xs text-mcs-text-default">{p.name}</span>
                      {p.source && <Chip ariaLabel={`来源 ${p.source}`}>{p.source}</Chip>}
                      {i === 0 && hasOrdering && (
                        <span className="text-mcs-2xs text-mcs-text-muted">最先加载</span>
                      )}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={disabled}
                      onClick={() =>
                        void runAction(p.name, () => buildDatapackDisableCommand(p.name))
                      }
                    >
                      禁用
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {available && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-mcs-xs font-medium text-mcs-text-muted">
              可用未启用（{available.length}）
            </h3>
            {available.length === 0 ? (
              <p className="text-mcs-2xs text-mcs-text-muted">没有其它可用的数据包</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {available.map((p) => (
                  <li key={p.name} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-mcs-xs text-mcs-text-default">{p.name}</span>
                      {p.source && <Chip ariaLabel={`来源 ${p.source}`}>{p.source}</Chip>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {/* 位置形态只在「尚未启用」时有效：实测 26.3 对已启用的包执行
                          enable … first/last 只回 already enabled 且不改顺序，
                          故这些入口只出现在本侧，已启用一侧只给「禁用」 */}
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={disabled}
                        onClick={() =>
                          void runAction(`${p.name}:first`, () =>
                            buildDatapackEnableCommand(p.name, { at: 'first' }),
                          )
                        }
                      >
                        置顶
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={disabled}
                        onClick={() =>
                          void runAction(`${p.name}:last`, () =>
                            buildDatapackEnableCommand(p.name, { at: 'last' }),
                          )
                        }
                      >
                        置底
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        disabled={disabled}
                        onClick={() =>
                          void runAction(p.name, () => buildDatapackEnableCommand(p.name))
                        }
                      >
                        启用
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="flex flex-col gap-1.5">
          <h3 className="text-mcs-xs font-medium text-mcs-text-muted">新建数据包</h3>
          {/* 版本在途时不渲染这一段：`supportsDatapackCreate('')` 按「支持」处置，先画出来再在
              status 落定后收掉，会让用户在首帧开始输入、随后连输入框一起消失 */}
          {mcVersionPending ? null : canCreate ? (
            <>
              <div className="flex items-center gap-1.5">
                <Input
                  className="h-7"
                  value={newId}
                  onChange={(e) => setNewId(e.target.value)}
                  placeholder="名字（字母数字与 _.-）"
                  aria-label="新数据包名字"
                />
                <Input
                  className="h-7"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="描述"
                  aria-label="新数据包描述"
                />
                <Button
                  type="button"
                  size="xs"
                  className="shrink-0"
                  disabled={disabled || !newId || !newDesc}
                  onClick={() => {
                    const id = newId
                    const desc = newDesc
                    void runAction(`create:${id}`, () => buildDatapackCreateCommand(id, desc)).then(
                      () => {
                        setNewId('')
                        setNewDesc('')
                      },
                    )
                  }}
                >
                  创建
                </Button>
              </div>
              <p className="text-mcs-xs text-mcs-text-muted">
                创建出的数据包为空包，随后可在「可用未启用」里启用。
              </p>
            </>
          ) : (
            // 说清「为什么没有这个入口」而不是让它点了才失败：低版本服务端对 create
            // 只回 Unknown or incomplete command，会被措辞分类读成「参数不被接受」
            <p className="text-mcs-xs text-mcs-text-muted">
              当前服务器版本（{mcVersion}）没有 <code>/datapack create</code> 子命令，创建空包需要
              1.21.6 及以上。
            </p>
          )}
        </section>
      </CardBody>
    </Card>
  )
}
