/**
 * 面板去留（设置页「危险区」）
 *
 * 三种用户意图必须分开入口，因为它们对数据的处置相反：暂时不用（全留）、
 * 换机器（全留且要能带走）、彻底不玩（全删）。合成一个「卸载」时，
 * 用户无法从名字判断存档会不会没。
 *
 * 「彻底删除」不在面板里执行：删掉自己正在运行的程序没有安全的收尾点，
 * 且删错无从回滚。面板只负责按真实内容列清「会删什么」，再给出那条命令。
 */
import { useEffect, useState } from 'react'
import {
  Download,
  Eraser,
  ListChecks,
  Loader2,
  Power,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react'
import type { PanelDataItem } from './contracts'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { CommandPreview } from '@/components/mcs/command-preview'
import { InfoHint } from '@/components/mcs/info-hint'
import { formatWorldSize } from '@/lib/format'
import { GAME_PORT_END, GAME_PORT_START, PANEL_PORT, RCON_PORT_START } from '@mc-commander/schemas'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  return formatWorldSize(bytes / (1024 * 1024 * 1024))
}

/**
 * 本项目写在浏览器里的键。
 * 面板删除后地址已经打不开，清这些只能就地做——任何一次 API 请求都必然失败。
 */
const BROWSER_STORAGE_KEYS = [
  'mcs-session',
  'mcs-connection',
  'mcs-ui-preferences',
  'mcs-players-ui',
  'mcs-notifications',
  'mcs-notification-preferences',
  'mcs-restart-pending',
  'mcs-command-history',
  'mcs-command-history-status',
  'mcs-command-presets',
  'mcs-announcement-presets',
  'mcs-server',
  'mcs-ws-last-event',
  'mc_commander_kits',
  'mc_commander_quick_teleports',
  'mcs-theme',
  'mcs-terminal-autoscroll',
  'mcs-confirm-commands',
  'mcs-deploy-mock',
]

/** 断线补齐游标按实例分键（`mcs-ws-last-event-<实例 id>`），裸键本身从不写入 */
const WS_CURSOR_KEY_PREFIX = 'mcs-ws-last-event-'

/** 面板碰不到的三件事：云控制台的端口、设备里的证书、别的浏览器里的登录凭据。删除前后共用一份，否则两处措辞必然分叉 */
const OUT_OF_REACH_ITEMS = [
  <>
    到云服务器控制台关掉端口：这台机器 → 网络与安全 → 防火墙规则（有的厂商叫「安全组」） →
    删掉入方向里 {PANEL_PORT}、{GAME_PORT_START} 到 {GAME_PORT_END}、{RCON_PORT_START}{' '}
    这几段的放行。端口在云厂商那边，删面板不会自动关。
  </>,
  <>
    在每台导入过根证书的设备上删掉那张证书，名字是「MC Commander 面板本地 CA」：Windows 按{' '}
    <code className="font-mono">Win+R</code> 输入 <code className="font-mono">certlm.msc</code> →
    受信任的根证书颁发机构 → 证书；macOS 打开「钥匙串访问」→ 系统 →
    证书。证书删不删都不影响别的网站。
  </>,
  <>
    别的浏览器或手机上登录过这个面板的，那些地方的登录凭据要各自清一次；本浏览器的登录凭据与使用记录还在，删除面板之后可以一键清掉。
  </>,
]

/** 清掉本项目在本浏览器留下的全部键，返回实际清掉的条数 */
function clearBrowserData(): number {
  let removed = 0
  try {
    // 用 length/key(i) 而非 Object.keys：Storage 的具名属性在部分实现里不可枚举，
    // 枚举为空时按钮会「点了没反应」却如实报告「已经没有数据了」
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key === null) continue
      if (BROWSER_STORAGE_KEYS.includes(key) || key.startsWith(WS_CURSOR_KEY_PREFIX)) {
        doomed.push(key)
      }
    }
    for (const key of doomed) {
      localStorage.removeItem(key)
      removed += 1
    }
  } catch {
    // 浏览器禁用存储（隐私模式/企业策略）时没有可清的东西，不因此打断收尾
  }
  return removed
}

export interface DangerZonePanelProps {
  items: PanelDataItem[]
  loading: boolean
  exporting: boolean
  stopping: boolean
  onExport: () => void
  onStop: () => void
  /** 配了 2FA 才要求动态口令 */
  totpEnabled?: boolean
  /** 提交彻底删除（服务端校验密码 + 2FA + 确认文本） */
  onRemove?: (payload: {
    password: string
    code: string
    confirmText: string
    keepData: boolean
  }) => void
  removing?: boolean
  removeError?: string
  /**
   * 上一次提交时勾选的「保留存档」。
   * 重试时若重置为未勾选，用户重新输入密码再点一次就会把本该保留的存档删掉。
   */
  initialKeepData?: boolean
}

export function DangerZonePanel({
  items,
  loading,
  exporting,
  stopping,
  onExport,
  onStop,
  totpEnabled = false,
  onRemove,
  removing = false,
  removeError = '',
  initialKeepData = false,
}: DangerZonePanelProps) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [keepData, setKeepData] = useState(initialKeepData)
  const withData = items.filter((i) => i.entries > 0)
  const hasData = withData.length > 0

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>停用面板</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-mcs-sm text-mcs-text-default">
            停止面板服务。服务器实例、存档、备份、配置
            <strong className="font-semibold">全部保留</strong>，随时可以重新启动。
          </p>
          <div>
            <Button variant="outline" onClick={onStop} disabled={stopping}>
              {stopping ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Power className="size-4" aria-hidden />
              )}
              停用面板
            </Button>
          </div>
          <p className="text-mcs-xs text-mcs-text-muted">
            停用后本页面会断开连接，需要到服务器上执行{' '}
            <code className="font-mono">sudo systemctl start mc-commander</code> 才能重新打开。
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>导出存档</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-mcs-sm text-mcs-text-default">
            把全部服务器实例与备份打包成一个压缩包下载。换机器时把它拷到新机器解压即可，
            原数据不受影响。
          </p>
          <div>
            <Button variant="outline" onClick={onExport} disabled={exporting || !hasData}>
              {exporting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Download className="size-4" aria-hidden />
              )}
              下载完整备份
            </Button>
          </div>
          {!loading && !hasData && (
            <p className="text-mcs-xs text-mcs-text-muted">
              当前没有实例或备份可导出。部署第一个实例后这里会变成可下载。
            </p>
          )}
        </CardBody>
      </Card>

      {/* 数据放在哪、那个盘还剩多少：这是用户判断「要不要清理、要不要换盘」的唯一依据。
          只报占用不报余量，等于让他自己去想办法。 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            数据存放位置
            <InfoHint label="关于数据位置">
              面板把实例、数据库与备份分别放在三个目录里。系统盘快满时可以把它们搬到更大的数据盘。
            </InfoHint>
          </CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {loading ? (
            <p className="text-mcs-xs text-mcs-text-muted">正在读取…</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li key={item.key} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="text-mcs-sm text-mcs-text-default">{item.label}所在目录</span>
                    <span className="font-mono text-mcs-2xs text-mcs-text-muted">
                      {formatBytes(item.bytes)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <code className="break-all font-mono text-mcs-2xs text-mcs-text-muted">
                      {item.path}
                    </code>
                    {item.freeBytes != null && item.freeBytes >= 0 && (
                      <span className="text-mcs-2xs text-mcs-text-muted">
                        所在磁盘剩余 {formatBytes(item.freeBytes)}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-mcs-xs text-mcs-text-muted">
            系统盘空间不足时，可把占空间最多的那一类搬到数据盘。迁移会暂停面板与运行中的服务器，失败会自动退回原目录。
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            彻底删除面板
            <InfoHint label="彻底删除的后果">
              删除面板程序与全部数据，不可恢复。要保留存档请先「导出存档」。
            </InfoHint>
          </CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <NoticeBanner variant="warning" icon={TriangleAlert}>
            <span className="text-mcs-sm">
              这一步会连同存档一起删除，无法恢复。需要保留时请先导出。
            </span>
          </NoticeBanner>

          {/* 面板只能删掉服务器上的东西：云控制台的端口、设备里的证书、别的浏览器里的
              登录凭据都在它够不着的地方。删完才看到这些，等于没有预警 */}
          <div className="flex flex-col gap-2 rounded-mcs-sm border border-mcs-border-muted p-3">
            <p className="flex items-center gap-1.5 text-mcs-sm font-medium text-mcs-text-default">
              <ListChecks className="size-4 shrink-0" aria-hidden />
              删除后你需要自己做
            </p>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-mcs-xs text-mcs-text-muted">
              {OUT_OF_REACH_ITEMS.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>

          {/* 数据清单逐项核实：写死「数据已保留」在空目录上就是假话，
              用户会据此判断「我的存档还在」，实际可能早就没了 */}
          <div className="flex flex-col gap-1.5">
            <p className="text-mcs-xs text-mcs-text-muted">将被删除的数据：</p>
            {loading ? (
              <p className="text-mcs-xs text-mcs-text-muted">正在清点…</p>
            ) : hasData ? (
              <ul className="flex flex-col gap-1">
                {withData.map((item) => (
                  <li key={item.key} className="flex items-baseline gap-2 text-mcs-xs">
                    <span className="text-mcs-text-default">{item.label}</span>
                    <span className="font-mono text-mcs-2xs text-mcs-text-muted">
                      {item.entries} 个文件 · {formatBytes(item.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-mcs-xs text-mcs-text-muted">
                当前没有任何实例或备份数据，删除不会丢失存档。
              </p>
            )}
          </div>

          {/* 确认三件套：密码（防误点）、2FA（配了才要）、逐字输入（防手滑）。
              面板可能在公网，一次误点就删光存档，故不设「一键删除」 */}
          <div className="flex flex-col gap-2 border-t border-mcs-border-muted pt-3">
            <Label htmlFor="removal-password">管理员密码</Label>
            <Input
              id="removal-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />

            {totpEnabled && (
              <>
                <Label htmlFor="removal-code">两步验证码</Label>
                <Input
                  id="removal-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  placeholder="6 位动态口令或恢复码"
                />
              </>
            )}

            <Label htmlFor="removal-confirm">输入「彻底删除」以确认</Label>
            <Input
              id="removal-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="彻底删除"
            />

            <label className="flex cursor-pointer items-center gap-2 text-mcs-xs text-mcs-text-default">
              <Checkbox checked={keepData} onCheckedChange={(v) => setKeepData(v === true)} />
              保留存档与备份（只删面板程序，之后可手动重新部署）
            </label>

            {removeError !== '' && (
              <p role="alert" className="text-mcs-xs text-mcs-error-fg">
                {removeError}
              </p>
            )}

            <div>
              <Button
                variant="destructive"
                disabled={removing || password === '' || confirmText !== '彻底删除'}
                onClick={() => onRemove?.({ password, code, confirmText, keepData })}
              >
                {removing ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <TriangleAlert className="size-4" aria-hidden />
                )}
                彻底删除面板
              </Button>
            </div>
            <p className="text-mcs-xs text-mcs-text-muted">
              删除开始后本页面会断开，届时面板已不存在，可直接关闭此页。
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

/** 探测节奏：3 秒一次，与用户对「马上有反应」的预期匹配 */
const PROBE_INTERVAL_MS = 3000
/**
 * 连续失败几次才认定面板已消失。
 *
 * 单次失败就下结论是假成功：网络抖一下、手机切个网，用户就会看到「面板已删除」，
 * 从而跳过根证书、云控制台端口、别的浏览器凭据这三件只能由他做的事。
 * 多等一个周期（3 秒）换一个不会错的结论。
 */
const GONE_AFTER_FAILURES = 2
/**
 * 面板还活着但已经过去这么久 ⇒ 这次删除没有生效。
 *
 * 清理脚本先停实例（最多等 20 秒落盘）再停面板，正常情况下两分钟内页面必然断开；
 * 超过这个时长还在，就不是「还在跑」而是「没跑起来」。
 */
const STUCK_AFTER_MS = 90_000

/**
 * 删除进行中的收尾页。
 *
 * 用户判断「删干净了吗」的自然方式是「再打开一次面板还能不能进」，
 * 而不是去服务器看日志——目标用户不碰终端。故这里轮询 /health：
 * 连续探测不到即确认删除成功；面板一直在，说明这次删除没有生效，要给出重试的出口。
 */
export function RemovalProgress({
  baseUrl,
  keepData = false,
  onRetry,
}: {
  baseUrl: string
  /** 决定手动命令指向哪个单元：保留存档与连数据一起删是两个不同的 systemd 单元 */
  keepData?: boolean
  /** 面板还在运行时回到确认表单，让用户重新发起一次 */
  onRetry?: () => void
}) {
  const [gone, setGone] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [cleared, setCleared] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    let failures = 0
    const startedAt = Date.now()
    const probe = async () => {
      try {
        await fetch(baseUrl + '/health', { cache: 'no-store' })
        failures = 0
        // 还能连上：清理尚未完成，也可能压根没起来——超过时限就如实说没完成
        if (!cancelled && Date.now() - startedAt >= STUCK_AFTER_MS) setStuck(true)
      } catch {
        failures += 1
        if (!cancelled && failures >= GONE_AFTER_FAILURES) setGone(true)
      }
    }
    const timer = setInterval(probe, PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [baseUrl])

  if (stuck && !gone) {
    const unit = keepData ? 'mc-commander-removal-keep.service' : 'mc-commander-removal.service'
    return (
      <div className="flex flex-col gap-3">
        <NoticeBanner variant="error" form="card" icon={TriangleAlert} role="alert">
          <p className="font-medium">删除没有完成</p>
          <p className="mt-1 text-mcs-sm">
            面板还在运行，说明这次删除没有生效，你的面板与数据都没有被删除。
          </p>
        </NoticeBanner>

        <p className="text-mcs-xs text-mcs-text-muted">
          可以再发起一次。如果反复失败，说明这台机器上的删除执行单元没能启动，
          需要在服务器的终端里手动执行一条命令——面板自己删不掉自己。
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCcw className="size-4" aria-hidden />
              重新发起删除
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-mcs-xs text-mcs-text-muted">
            在服务器终端里执行下面这条命令，效果与面板内点击相同：
          </p>
          <CommandPreview command={`sudo systemctl start ${unit}`} />
        </div>
      </div>
    )
  }

  if (gone) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-mcs-sm text-mcs-text-default">面板已删除。</p>
        <p className="text-mcs-xs text-mcs-text-muted">
          现在再打开面板地址应该已经打不开了。这个页面可以直接关闭。
        </p>

        <div className="flex flex-col gap-3 rounded-mcs-sm border border-mcs-border-muted p-3">
          <p className="flex items-center gap-1.5 text-mcs-sm font-medium text-mcs-text-default">
            <ListChecks className="size-4 shrink-0" aria-hidden />
            还有三件事要你自己做
          </p>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-mcs-xs text-mcs-text-muted">
            {OUT_OF_REACH_ITEMS.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setCleared(clearBrowserData())}>
              <Eraser className="size-4" aria-hidden />
              清除本浏览器数据
            </Button>
            {cleared !== null && (
              <span role="status" className="text-mcs-xs text-mcs-text-muted">
                {cleared > 0
                  ? `已清理 ${cleared} 项浏览器数据`
                  : '这个浏览器里已经没有本面板的数据了'}
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-mcs-sm text-mcs-text-default">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        正在删除面板…
      </p>
      <p className="text-mcs-xs text-mcs-text-muted">
        删除完成后本页面会自动更新。若 90 秒后还停在这里，会给出重新发起的入口。
      </p>
    </div>
  )
}
