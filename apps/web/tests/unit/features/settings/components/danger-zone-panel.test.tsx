/**
 * 危险区面板：三种意图各自说清后果。
 * 重点锁两条——数据清单必须按真实内容呈现（空目录不能说成「已保留」），
 * 以及彻底删除必须交代存档会没。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DangerZonePanel, RemovalProgress } from '@/features/settings/components/danger-zone-panel'
import type { PanelDataItem } from '@/features/settings/components/contracts'
import { GAME_PORT_END, GAME_PORT_START, PANEL_PORT, RCON_PORT_START } from '@mc-commander/schemas'

/**
 * 端口段由契约包给，不在测试里抄一遍数字——抄了就变成第二份事实，
 * 分配器一改，断言仍会「通过」而界面已经在说假话。
 */
function portsSentence(): RegExp {
  return new RegExp(
    `删掉入方向里 ${PANEL_PORT}、${GAME_PORT_START} 到 ${GAME_PORT_END}、${RCON_PORT_START}`,
  )
}

function item(over: Partial<PanelDataItem> = {}): PanelDataItem {
  return {
    key: 'servers',
    label: '服务器实例与存档',
    path: '/opt/mc-commander/var/servers',
    entries: 0,
    bytes: 0,
    ...over,
  }
}

/** 本项目写在浏览器里的键：删完面板后它们仍留在设备上 */
const BROWSER_KEYS = [
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

function baseProps(over: Partial<React.ComponentProps<typeof DangerZonePanel>> = {}) {
  return {
    items: [] as PanelDataItem[],
    loading: false,
    exporting: false,
    stopping: false,
    onExport: vi.fn(),
    onStop: vi.fn(),
    ...over,
  }
}

describe('危险区面板', () => {
  it('三个意图各自独立成块，不合并成一个「卸载」', () => {
    render(<DangerZonePanel {...baseProps()} />)
    expect(screen.getByRole('heading', { name: '停用面板' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '导出存档' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /彻底删除面板/ })).toBeInTheDocument()
  })

  it('停用只说保留，不暗示会删数据', () => {
    render(<DangerZonePanel {...baseProps()} />)
    const body = screen.getByText(/停止面板服务并取消开机自启/)
    expect(body).toHaveTextContent('全部保留')
  })

  it('没有任何数据时如实说「不会丢失存档」，不虚报', () => {
    render(<DangerZonePanel {...baseProps({ items: [item(), item({ key: 'backups' })] })} />)
    expect(screen.getByText(/当前没有任何实例或备份数据/)).toBeInTheDocument()
    // 空目录不能列进「将被删除的数据」
    expect(screen.queryByText('服务器实例与存档')).not.toBeInTheDocument()
  })

  it('有数据时逐项列出文件数与体积（用户据此判断存档在不在）', () => {
    render(
      <DangerZonePanel
        {...baseProps({
          items: [
            item({ entries: 42, bytes: 1024 * 1024 * 1024 }),
            item({ key: 'backups', label: '备份快照', entries: 3, bytes: 1024 }),
          ],
        })}
      />,
    )
    expect(screen.getByText('服务器实例与存档')).toBeInTheDocument()
    expect(screen.getByText(/42 个文件/)).toBeInTheDocument()
    expect(screen.getByText(/3 个文件/)).toBeInTheDocument()
  })

  it('没有可导出数据时下载按钮禁用', () => {
    render(<DangerZonePanel {...baseProps()} />)
    expect(screen.getByRole('button', { name: /下载完整备份/ })).toBeDisabled()
  })

  it('有数据时下载按钮可用并回调', async () => {
    const user = userEvent.setup()
    const props = baseProps({ items: [item({ entries: 1, bytes: 10 })] })
    render(<DangerZonePanel {...props} />)
    await user.click(screen.getByRole('button', { name: /下载完整备份/ }))
    expect(props.onExport).toHaveBeenCalled()
  })

  it('停用中按钮禁用且显示进行态', () => {
    render(<DangerZonePanel {...baseProps({ stopping: true })} />)
    expect(screen.getByRole('button', { name: /停用面板/ })).toBeDisabled()
  })

  it('彻底删除在面板内完成，不要求用户去终端', () => {
    render(<DangerZonePanel {...baseProps()} />)
    expect(screen.getByLabelText('管理员密码')).toBeInTheDocument()
    expect(screen.queryByText(/--uninstall --purge/)).not.toBeInTheDocument()
  })
  /* 云控制台的端口、设备上的证书、别的浏览器里的登录凭据，面板删完也碰不到：
     必须删之前就交代，否则用户删完才发现还有活要干 */
  describe('删除前的「你要自己做」预警', () => {
    it('确认表单之前就列出端口、设备证书、其他浏览器三件事', () => {
      render(<DangerZonePanel {...baseProps()} />)
      const warning = screen.getByText('删除后你需要自己做')
      expect(warning).toBeInTheDocument()
      // 预警必须排在确认输入框之前：删完才看到等于没预警
      const password = screen.getByLabelText('管理员密码')
      expect(warning.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
      expect(screen.getByText(portsSentence())).toBeInTheDocument()
      expect(screen.getByText(/MC Commander 面板本地 CA/)).toBeInTheDocument()
      expect(screen.getByText(/别的浏览器或手机上登录过这个面板的/)).toBeInTheDocument()
    })

    it('给出可以照着做的具体路径，不停在「控制台里关掉」这种空话', () => {
      render(<DangerZonePanel {...baseProps()} />)
      // 只说「去控制台关端口」等于把「在哪」这个真问题丢回给用户
      expect(screen.getByText(/网络与安全 → 防火墙规则/)).toBeInTheDocument()
      expect(screen.getByText(/受信任的根证书颁发机构/)).toBeInTheDocument()
    })

    it('端口写全三段，不把实例端口与 RCON 段合成一句数字范围', () => {
      render(<DangerZonePanel {...baseProps()} />)
      // RCON 段与实例段不连续，写成「25567 到 35575」会把中间的空段误说成实例端口
      expect(screen.getByText(new RegExp(String(RCON_PORT_START)))).toBeInTheDocument()
      expect(screen.queryByText(new RegExp(`${GAME_PORT_START} 到 ${RCON_PORT_START}`))).toBeNull()
    })
  })

  /* 面板可能在公网，一次误点就删光存档：确认三件套缺一不可 */
  describe('彻底删除的确认机制', () => {
    it('未填密码时删除按钮禁用', () => {
      render(<DangerZonePanel {...baseProps()} />)
      expect(screen.getByRole('button', { name: /彻底删除面板/ })).toBeDisabled()
    })

    it('确认文本不是「彻底删除」时按钮仍禁用（防手滑）', async () => {
      const user = userEvent.setup()
      render(<DangerZonePanel {...baseProps()} />)
      await user.type(screen.getByLabelText('管理员密码'), 'pw')
      await user.type(screen.getByLabelText(/输入「彻底删除」以确认/), '彻底删')
      expect(screen.getByRole('button', { name: /彻底删除面板/ })).toBeDisabled()
    })

    it('密码 + 确认文本齐备后才可提交，并把 keepData 一起带上', async () => {
      const user = userEvent.setup()
      const onRemove = vi.fn()
      render(<DangerZonePanel {...baseProps({ onRemove })} />)
      await user.type(screen.getByLabelText('管理员密码'), 'pw')
      await user.type(screen.getByLabelText(/输入「彻底删除」以确认/), '彻底删除')
      await user.click(screen.getByRole('button', { name: /彻底删除面板/ }))
      expect(onRemove).toHaveBeenCalledWith(
        expect.objectContaining({ password: 'pw', confirmText: '彻底删除', keepData: false }),
      )
    })

    it('配了 2FA 才出现验证码输入框', () => {
      const { rerender } = render(<DangerZonePanel {...baseProps()} />)
      expect(screen.queryByLabelText('两步验证码')).not.toBeInTheDocument()
      rerender(<DangerZonePanel {...baseProps({ totpEnabled: true })} />)
      expect(screen.getByLabelText('两步验证码')).toBeInTheDocument()
    })

    it('勾选保留存档时提交 keepData=true', async () => {
      const user = userEvent.setup()
      const onRemove = vi.fn()
      render(<DangerZonePanel {...baseProps({ onRemove })} />)
      await user.type(screen.getByLabelText('管理员密码'), 'pw')
      await user.type(screen.getByLabelText(/输入「彻底删除」以确认/), '彻底删除')
      await user.click(screen.getByLabelText(/保留存档与备份/))
      await user.click(screen.getByRole('button', { name: /彻底删除面板/ }))
      expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ keepData: true }))
    })

    it('重试回到表单时保留上次勾选：否则用户再点一次会删掉本该保留的存档', async () => {
      const user = userEvent.setup()
      const onRemove = vi.fn()
      render(<DangerZonePanel {...baseProps({ onRemove, initialKeepData: true })} />)
      expect(screen.getByLabelText(/保留存档与备份/)).toBeChecked()
      await user.type(screen.getByLabelText('管理员密码'), 'pw')
      await user.type(screen.getByLabelText(/输入「彻底删除」以确认/), '彻底删除')
      await user.click(screen.getByRole('button', { name: /彻底删除面板/ }))
      expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ keepData: true }))
    })

    it('服务端拒绝时显示错误，不假装成功', () => {
      render(<DangerZonePanel {...baseProps({ removeError: '密码错误' })} />)
      expect(screen.getByRole('alert')).toHaveTextContent('密码错误')
    })
  })
})

/* 用户判断「删干净了吗」的方式是「再打开一次面板还能不能进」，
     而不是去服务器看日志——目标用户不碰终端 */
describe('删除进行中的收尾页', () => {
  it('服务仍在时显示进行中，不谎报完成', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('ok'))),
    )
    render(<RemovalProgress baseUrl="http://1.2.3.4:25566" />)
    expect(screen.getByText(/正在删除面板/)).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('服务消失后显示已删除', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('refused'))),
    )
    render(<RemovalProgress baseUrl="http://1.2.3.4:25566" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(screen.getByText(/面板已删除/)).toBeInTheDocument()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('单次探测失败不算已删除：网络抖一下不能骗用户跳过收尾事项', async () => {
    vi.useFakeTimers()
    // 第一次失败，第二次连上——真实网络抖动就是这个形态
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1
        return call === 1 ? Promise.reject(new Error('blip')) : Promise.resolve(new Response('ok'))
      }),
    )
    render(<RemovalProgress baseUrl="http://1.2.3.4:25566" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.queryByText(/面板已删除/)).not.toBeInTheDocument()
    expect(screen.getByText(/正在删除面板/)).toBeInTheDocument()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('面板一直在：超过时限后给结论与重新发起的出口，不无限转圈', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('ok'))),
    )
    const onRetry = vi.fn()
    render(<RemovalProgress baseUrl="http://1.2.3.4:25566" onRetry={onRetry} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(93_000)
    })
    expect(screen.getByText('删除没有完成')).toBeInTheDocument()
    // 必须说清「什么都没删」，否则用户会以为数据已经没了
    expect(screen.getByText(/你的面板与数据都没有被删除/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重新发起删除/ }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('手动兜底命令按保留存档与否指向不同单元', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('ok'))),
    )
    const { unmount } = render(<RemovalProgress baseUrl="http://1.2.3.4:25566" keepData={true} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(93_000)
    })
    expect(
      screen.getByText('sudo systemctl start mc-commander-removal-keep.service'),
    ).toBeInTheDocument()
    unmount()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})

/* 删完之后面板地址已经打不开：收尾页的一切动作都必须是本地的，
   且能清的浏览器数据要能一次清干净 */
describe('删除完成后的收尾', () => {
  beforeEach(() => {
    // 探测节奏是 3 秒一次：用假时钟推进，不靠真等（等多久不算验证时机语义）
    vi.useFakeTimers()
  })

  afterEach(() => {
    localStorage.clear()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** 挂一个立刻判「服务已消失」的 fetch，推进到探测点，返回收尾页 */
  async function renderGone() {
    const fetchMock = vi.fn(() => Promise.reject(new Error('refused')))
    vi.stubGlobal('fetch', fetchMock)
    render(<RemovalProgress baseUrl="http://1.2.3.4:25566" />)
    // 连续两次探测失败才认定消失
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    screen.getByText(/面板已删除/)
    return fetchMock
  }

  it('给出三件事的执行指引，不只有一句「已删除」', async () => {
    await renderGone()
    expect(screen.getByText('还有三件事要你自己做')).toBeInTheDocument()
    expect(screen.getByText(portsSentence())).toBeInTheDocument()
    expect(screen.getByText(/MC Commander 面板本地 CA/)).toBeInTheDocument()
    expect(screen.getByText(/别的浏览器或手机上登录过这个面板的/)).toBeInTheDocument()
  })

  it('删完之后给的还是具体路径，不是「去控制台看看」', async () => {
    await renderGone()
    expect(screen.getByText(/网络与安全 → 防火墙规则/)).toBeInTheDocument()
    expect(screen.getByText(/受信任的根证书颁发机构/)).toBeInTheDocument()
  })

  /* 删除前后的两份清单说的是同一件事：各写一份就必然漂移，
     而漂移的表现是「删之前看到一种说法、删之后看到另一种」，两边都不可信 */
  it('删除前后列出的三件事逐字相同', async () => {
    const before = render(<DangerZonePanel {...baseProps()} />)
    const preText = before
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '')
      .filter((t) => t.includes('云服务器控制台') || t.includes('根证书') || t.includes('登录凭据'))
    before.unmount()

    await renderGone()
    const postText = screen
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '')
      .filter((t) => t.includes('云服务器控制台') || t.includes('根证书') || t.includes('登录凭据'))

    expect(preText).toHaveLength(3)
    expect(postText).toEqual(preText)
  })

  it('不向用户展示任何日志内容（目标用户不读日志，删完更读不到）', async () => {
    await renderGone()
    expect(screen.queryByText(/journalctl/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\/var\/log/)).not.toBeInTheDocument()
  })

  it('清理按钮一次清掉本项目写入的全部浏览器键', async () => {
    await renderGone()
    for (const key of BROWSER_KEYS) localStorage.setItem(key, 'x')
    // 断线游标按实例分键，裸键本身不写
    localStorage.setItem('mcs-ws-last-event-i-1', '42')

    fireEvent.click(screen.getByRole('button', { name: /清除本浏览器数据/ }))

    for (const key of BROWSER_KEYS) expect(localStorage.getItem(key), key).toBeNull()
    expect(localStorage.getItem('mcs-ws-last-event-i-1')).toBeNull()
  })

  it('不碰别的站点/别的应用的同域数据', async () => {
    await renderGone()
    localStorage.setItem('mcs-session', 'x')
    localStorage.setItem('someone-else-key', 'keep')
    fireEvent.click(screen.getByRole('button', { name: /清除本浏览器数据/ }))
    expect(localStorage.getItem('mcs-session')).toBeNull()
    expect(localStorage.getItem('someone-else-key')).toBe('keep')
  })

  it('清完就地给出反馈，不静默', async () => {
    await renderGone()
    localStorage.setItem('mcs-session', 'x')
    fireEvent.click(screen.getByRole('button', { name: /清除本浏览器数据/ }))
    expect(screen.getByRole('status')).toHaveTextContent(/已清理 1 项/)
  })

  it('没有可清的数据时如实说「已经没有了」，不谎报清了几项', async () => {
    await renderGone()
    fireEvent.click(screen.getByRole('button', { name: /清除本浏览器数据/ }))
    expect(screen.getByRole('status')).toHaveTextContent(/已经没有本面板的数据/)
  })

  it('清理全程不发任何请求（面板已不存在，发出去必然失败）', async () => {
    const fetchMock = await renderGone()
    const before = fetchMock.mock.calls.length
    localStorage.setItem('mcs-session', 'x')
    fireEvent.click(screen.getByRole('button', { name: /清除本浏览器数据/ }))
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('根证书只给文字指引，不给按钮（碰不到用户设备）', async () => {
    await renderGone()
    expect(screen.queryByRole('button', { name: /证书/ })).not.toBeInTheDocument()
    expect(screen.getByText(/MC Commander 面板本地 CA/)).toBeInTheDocument()
  })
})
