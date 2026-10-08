import { useState } from 'react'
import { Radio } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { useServerStore } from '@/stores/server'
import { usePushChannel, useSetPushChannel } from '../queries'

/**
 * 推送通道（MSMP）开关。
 *
 * **为什么这个开关本身就是一条护栏**：`management-server-*` 不在属性白名单里，
 * 属性面板把这几项渲染成只读行（`buildUnknownPropertyDef` 的 `isWritable: false`），
 * 于是用户唯一能做的就是**去手改 server.properties**——而按直觉只改
 * `management-server-enabled=true`（TLS 默认 true、keystore 默认空）会让服务器
 * **再也起不来**。面板替他一次写对三项，正是这个卡片存在的理由。
 *
 * 界面要交代三件事，缺一件用户就会踩坑：
 * ① 当前是开是关；② 绑定在哪个主机（非本机＝暴露面变大，必须提示）；
 * ③ 服务器运行中时改动**要重启**才生效（MSMP 只在启动时读）。
 */
interface PushChannelCardProps {
  instanceId: string | null
  isRunning: boolean
}

export function PushChannelCard({ instanceId, isRunning }: PushChannelCardProps) {
  // 连通性来自实例状态（服务端按「常驻连接是否已建立」上报），与这里的配置项是两件事：
  // 配置为「已开启」不代表连上了——端口可随机、密钥由服务端生成写回文件
  const pushConnected = useServerStore((s) => s.status?.capabilities.msmpPush ?? false)
  const stateQuery = usePushChannel(instanceId)
  const toggle = useSetPushChannel(instanceId)
  const [justToggled, setJustToggled] = useState<boolean | null>(null)

  const state = stateQuery.data
  const error = stateQuery.error

  async function handleToggle(next: boolean) {
    setJustToggled(null)
    try {
      await toggle.mutateAsync(next)
      setJustToggled(next)
    } catch {
      /* 失败由下面的 error 提示承担（mutation 的 error 在渲染里读） */
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Radio className="size-4" aria-hidden="true" />
          实时推送
        </CardTitle>
        {state && (
          <Switch
            checked={state.enabled}
            disabled={toggle.isPending}
            onCheckedChange={(v) => void handleToggle(v)}
            aria-label="开启实时推送"
          />
        )}
      </CardHeader>

      <CardBody className="flex flex-col gap-3">
        <p className="text-mcs-xs text-mcs-text-muted">
          开启后，面板能直接收到服务器推送的状态变化（如世界升级进度），不再只靠定时轮询。
          这项配置需要服务器配合开启管理协议，<strong>不要手改 server.properties</strong>
          ——单独改「启用」那一项（TLS 仍为默认开启、又没配证书）会让服务器起不来。
        </p>

        {stateQuery.isLoading && <p className="text-mcs-xs text-mcs-text-muted">正在读取…</p>}

        {error && (
          <NoticeBanner variant="warning">
            读不到推送通道状态：
            {error instanceof Error ? error.message : String(error)}
          </NoticeBanner>
        )}

        {toggle.error && (
          <NoticeBanner variant="error">
            设置失败：
            {toggle.error instanceof Error ? toggle.error.message : String(toggle.error)}
          </NoticeBanner>
        )}

        {state && (
          <>
            {/* ① 状态可见性：把「开没开」与「绑在哪」摆在明处 */}
            <dl className="flex flex-col gap-1 text-mcs-xs">
              <div className="flex items-center gap-2">
                <dt className="text-mcs-text-muted">状态</dt>
                <dd className="text-mcs-text-default">{state.enabled ? '已开启' : '未开启'}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-mcs-text-muted">监听</dt>
                <dd className="text-mcs-text-default">
                  {state.host}:{state.port === 0 ? '随机端口' : state.port}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-mcs-text-muted">访问凭据</dt>
                <dd className="text-mcs-text-default">
                  {state.secretConfigured ? '已配置（面板管理）' : '未配置'}
                </dd>
              </div>
              {state.enabled && (
                <div className="flex items-center gap-2">
                  <dt className="text-mcs-text-muted">推送连接</dt>
                  <dd className="text-mcs-text-default">{pushConnected ? '已连通' : '未连通'}</dd>
                </div>
              )}
            </dl>

            {state.enabled && isRunning && !pushConnected && (
              <p className="text-mcs-xs text-mcs-text-muted">
                服务端可能还没就绪（管理协议端口在启动时才确定）。若一直未连通，请重启服务器后再看。
              </p>
            )}

            {/* ② 暴露面：只在真的不是本机绑定时提示，避免常年挂一条不生效的告警 */}
            {state.enabled && !isLoopbackHost(state.host) && (
              <NoticeBanner variant="warning">
                当前绑定在 <code>{state.host}</code>（非本机）：管理协议已对网络开放。
                如非有意，请把它改回 localhost。
              </NoticeBanner>
            )}

            {/* ③ 重启语义：MSMP 只在服务端启动时读取，运行中改动不会立刻生效 */}
            {justToggled !== null && isRunning && (
              <NoticeBanner variant="info">
                已{justToggled ? '开启' : '关闭'}，但服务器正在运行—— 需要
                <strong>重启服务器</strong>才会生效。
              </NoticeBanner>
            )}
            {justToggled !== null && !isRunning && (
              <NoticeBanner variant="success">
                已{justToggled ? '开启' : '关闭'}，下次启动服务器时生效。
              </NoticeBanner>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}

/** MC 把「本机」写成多种形态，判断要一并收掉，否则会漏报或误报暴露面 */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
}
