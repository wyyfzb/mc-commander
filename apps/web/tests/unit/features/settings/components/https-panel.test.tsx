/**
 * HttpsPanel：传输加密引导面板。
 *
 * 承重点（每条都对应一个会让用户走错路的失败形态）：
 *  - 服务端未启用时必须说清原因，而不是给一个永远装不成功的引导；
 *  - 未装证书时检测结果必须是「还没生效」——报成「已信任」会让用户切过去撞拦截页；
 *  - 指纹必须可见：装错 CA 的表现就是「装完还是不受信」，没有对照物无从排查；
 *  - 切换按钮必须写明会重登一次，否则用户以为被踢了。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpsPanel } from '@/features/settings/components/https-panel'

const FINGERPRINT =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'

const ENABLED_STATUS = {
  enabled: true,
  disabledReason: null,
  caFingerprint: FINGERPRINT,
  serverNames: ['127.0.0.1', 'localhost'],
  expiresAt: '2126-09-27T20:00:00.000Z',
}

function renderPanel(authed = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HttpsPanel baseUrl="" apiKey="" authed={authed} />
    </QueryClientProvider>,
  )
}

describe('HttpsPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'ok', code: 0, data: ENABLED_STATUS }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('未登录时只给说明，不发请求', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    renderPanel(false)
    expect(screen.getByText('需要先登录才能使用加密访问。')).toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })

  it('服务端已启用时给出三步引导与下载入口', async () => {
    renderPanel()
    expect(await screen.findByText('1. 下载并安装根证书')).toBeInTheDocument()
    expect(screen.getByText('2. 确认这台设备已信任')).toBeInTheDocument()
    expect(screen.getByText('3. 切换过去')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /下载根证书/ })).toHaveAttribute('href', '/ca.crt')
  })

  it('展示 CA 指纹（装错证书时唯一的对照物）', async () => {
    renderPanel()
    expect(await screen.findByText(FINGERPRINT)).toBeInTheDocument()
    expect(screen.getByText(/指纹对不上就不要安装/)).toBeInTheDocument()
  })

  it('切换按钮写明会重新登录一次（否则用户以为自己被踢了）', async () => {
    renderPanel()
    expect(await screen.findByText(/换协议后需要重新登录一次/)).toBeInTheDocument()
  })

  it('检测到证书未受信时提示「还没生效」，不误报为已信任', async () => {
    // 首次请求取状态，之后探测 HTTPS 端点时抛网络错误（模拟证书不受信）
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        if (call === 1) {
          return new Response(JSON.stringify({ status: 'ok', code: 0, data: ENABLED_STATUS }), {
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new TypeError('Failed to fetch')
      }),
    )
    renderPanel()
    const btn = await screen.findByRole('button', { name: /检测/ })
    await userEvent.click(btn)
    await waitFor(() => {
      expect(screen.getByText(/还没生效/)).toBeInTheDocument()
    })
    expect(screen.queryByText(/已信任，可以切到 https/)).not.toBeInTheDocument()
  })

  it('服务端未启用时说明原因，而不是给出装不成功的引导', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'ok',
              code: 0,
              data: { ...ENABLED_STATUS, enabled: false, disabledReason: '系统缺少 openssl 命令' },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    renderPanel()
    expect(await screen.findByText('本机未启用加密访问')).toBeInTheDocument()
    expect(screen.getByText(/系统缺少 openssl 命令/)).toBeInTheDocument()
    expect(screen.queryByText('1. 下载并安装根证书')).not.toBeInTheDocument()
  })
})
