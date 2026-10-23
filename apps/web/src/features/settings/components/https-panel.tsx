/**
 * HttpsPanel —— 设置页「传输加密」引导。
 *
 * 面板在同一端口同时提供 HTTP 与 HTTPS，所以本面板要回答的**不是**「有没有
 * HTTPS」（一定有），而是两件只有用户这一侧才知道的事：
 *  ① 这台设备信不信本地面板的 CA（浏览器状态，服务端看不到）；
 *  ② 用户在哪个平台上装证书（步骤完全不同）。
 *
 * 信任检测的做法：从当前页面用 fetch 打自己的 HTTPS 端点。证书未受信时浏览器
 * 直接判网络错误（Failed to fetch），受信时才返回响应——这正是我们要的那个位。
 * 检测必须由用户点击触发，不能自动跑：未受信时浏览器会在控制台留下证书错误，
 * 用户还没做任何操作就先看到一片红字，会以为面板坏了。
 *
 * 切换用按钮而不是自动跳转：换协议后 localStorage 不共享，会话令牌带不过去，
 * 必然要重登一次。把「会重登」写在按钮上，比让用户莫名被弹回登录页好。
 */
import { useState } from 'react'
import { CheckCircle2, Download, ExternalLink, Lock, RefreshCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { LoadingButton } from '@/components/mcs/loading-button'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Chip } from '@/components/mcs/chip'
import { InfoHint } from '@/components/mcs/info-hint'
import { SettingsSectionCard } from './settings-section-card'
import { useHttpsStatus } from '@/api/queries'
import { copyText } from '@/lib/clipboard'

interface HttpsPanelProps {
  baseUrl: string
  apiKey: string
  /** 是否具备认证通道；false 时只渲染说明，不发请求 */
  authed: boolean
}

/** 信任检测的三种结果：未检测 / 已信任 / 未信任 */
type TrustProbe = 'idle' | 'checking' | 'trusted' | 'untrusted'

/** 当前是否已经在 https 下访问（决定按钮是「切换」还是「已经是了」） */
function currentIsSecure(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'https:'
}

/**
 * 探测本机是否已信任面板 CA：请求自己的 HTTPS 端点。
 *
 * 用 no-cors 是因为只需要「能不能连通」这一位，不需要读响应内容；
 * 该模式下证书不受信同样会抛网络错误，正好把两种状态区分开。
 * 加随机查询串绕开缓存——否则「上次失败」会被缓存成永久的未信任。
 */
async function probeTrust(httpsUrl: string): Promise<boolean> {
  try {
    await fetch(httpsUrl + '/health?probe=' + Date.now(), {
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
    })
    return true
  } catch {
    return false
  }
}

export function HttpsPanel({ baseUrl, apiKey, authed }: HttpsPanelProps) {
  const statusQuery = useHttpsStatus(baseUrl, apiKey, authed)
  const [trust, setTrust] = useState<TrustProbe>('idle')
  const [checking, setChecking] = useState(false)

  const status = statusQuery.data
  // 面板地址：baseUrl 为空时是同源（生产部署的常态）
  const origin = baseUrl || (typeof window !== 'undefined' ? window.location.origin : '')
  const httpsUrl = origin.replace(/^http:\/\//, 'https://')
  const alreadySecure = currentIsSecure()

  const runProbe = async () => {
    setChecking(true)
    setTrust('checking')
    const ok = await probeTrust(httpsUrl)
    setTrust(ok ? 'trusted' : 'untrusted')
    setChecking(false)
  }

  const switchToHttps = () => {
    // 换协议后会话令牌不共享（localStorage 按 origin 隔离），必然要重登。
    // 提前说清，用户才不会以为自己被踢了
    window.location.href = httpsUrl
  }

  if (!authed) {
    return (
      <SettingsSectionCard
        icon={Lock}
        title="传输加密"
        description="登录后可查看本机是否已信任面板证书"
      >
        <p className="text-mcs-sm text-mcs-text-muted">需要先登录才能使用加密访问。</p>
      </SettingsSectionCard>
    )
  }

  return (
    <SettingsSectionCard
      icon={Lock}
      title="传输加密"
      description="面板同一端口已支持 https；这台设备装一次根证书即可长期有效"
    >
      <div className="space-y-4">
        {statusQuery.isLoading ? (
          <p className="text-mcs-sm text-mcs-text-muted">正在读取证书信息…</p>
        ) : !status?.enabled ? (
          <NoticeBanner variant="warning" form="card">
            <p className="font-medium">本机未启用加密访问</p>
            <p className="mt-1 text-mcs-text-muted">
              {status?.disabledReason ?? '证书尚未就绪。'}面板其余功能不受影响，当前为明文访问。
            </p>
          </NoticeBanner>
        ) : (
          <>
            {/* ── 当前状态 ── */}
            <div className="flex flex-wrap items-center gap-2 text-mcs-sm">
              <span className="text-mcs-text-muted">当前连接</span>
              <Chip tone={alreadySecure ? 'success' : 'warning'}>
                {alreadySecure ? 'https（已加密）' : 'http（未加密）'}
              </Chip>
              {!alreadySecure && trust === 'trusted' && (
                <Chip tone="success">
                  <CheckCircle2 className="mr-1 size-3" aria-hidden />
                  本机已信任证书
                </Chip>
              )}
            </div>

            {/* ── 三步引导 ── */}
            <ol className="space-y-3 text-mcs-sm">
              <li>
                <p className="font-medium text-mcs-text-default">1. 下载并安装根证书</p>
                <p className="mt-0.5 text-mcs-text-muted">
                  浏览器不允许网页自行安装证书，这一步只能手动做一次。
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button asChild size="sm" variant="outline">
                    <a href="/ca.crt" download="mc-commander-ca.crt">
                      <Download className="size-3.5" aria-hidden />
                      下载根证书
                    </a>
                  </Button>
                  <InfoHint label="各平台安装步骤">
                    <div className="space-y-2 text-mcs-xs">
                      <p>
                        <span className="font-medium">Windows：</span>
                        双击证书 → 安装证书 → 本地计算机 → 把证书放入「受信任的根证书颁发机构」
                      </p>
                      <p>
                        <span className="font-medium">macOS：</span>
                        双击证书导入「钥匙串访问」→ 双击该证书 → 信任 → 使用此证书时选「始终信任」
                      </p>
                      <p>
                        <span className="font-medium">iPhone / iPad：</span>用 Safari 打开本页下载 →
                        设置 → 通用 → VPN 与设备管理 → 安装描述文件 → 再到「设置 → 通用 → 关于本机 →
                        证书信任设置」打开完全信任（少这一步等于没装）
                      </p>
                      <p>
                        <span className="font-medium">Android：</span>
                        设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书
                      </p>
                      <p>
                        <span className="font-medium">Firefox：</span>
                        设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构 → 导入
                      </p>
                    </div>
                  </InfoHint>
                </div>
              </li>

              <li>
                <p className="font-medium text-mcs-text-default">2. 确认这台设备已信任</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <LoadingButton size="sm" variant="outline" loading={checking} onClick={runProbe}>
                    <RefreshCw className="size-3.5" aria-hidden />
                    检测
                  </LoadingButton>
                  {trust === 'trusted' && (
                    <span className="text-mcs-xs text-mcs-success-fg">已信任，可以切到 https</span>
                  )}
                  {trust === 'untrusted' && (
                    <span className="text-mcs-xs text-mcs-warning-fg">
                      还没生效——装完证书通常需要重启浏览器
                    </span>
                  )}
                </div>
              </li>

              <li>
                <p className="font-medium text-mcs-text-default">3. 切换过去</p>
                <p className="mt-0.5 text-mcs-text-muted">
                  换协议后需要重新登录一次（浏览器按地址隔离登录状态）。
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={alreadySecure} onClick={switchToHttps}>
                    <ShieldCheck className="size-3.5" aria-hidden />
                    {alreadySecure ? '已在 https 下' : '切换到 https'}
                  </Button>
                  {!alreadySecure && (
                    <Button asChild size="sm" variant="ghost">
                      <a href={httpsUrl} target="_blank" rel="noreferrer">
                        先在新标签页试试
                        <ExternalLink className="size-3.5" aria-hidden />
                      </a>
                    </Button>
                  )}
                </div>
              </li>
            </ol>

            {/* ── 指纹：装错 CA 会表现为「装完还是不受信」，必须给对照物 ── */}
            {status.caFingerprint && (
              <div className="rounded-mcs-sm border border-mcs-border-muted p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-mcs-xs font-medium text-mcs-text-default">
                    证书指纹（SHA-256）
                  </p>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={async () => {
                      const ok = await copyText(status.caFingerprint ?? '')
                      if (ok) toast.success('指纹已复制')
                    }}
                  >
                    复制
                  </Button>
                </div>
                <p className="mt-1 break-all font-mono text-mcs-2xs text-mcs-text-muted">
                  {status.caFingerprint}
                </p>
                <p className="mt-2 text-mcs-2xs text-mcs-text-muted">
                  导入后可在系统的证书列表里核对这串字符。根证书首次下载走明文，指纹对不上就不要安装。
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </SettingsSectionCard>
  )
}
