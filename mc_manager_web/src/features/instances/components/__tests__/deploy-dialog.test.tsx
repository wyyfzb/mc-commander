/**
 * DeployDialog 测试（部署向导）：
 * - 三步流程：类型选择 → 版本自动出现 → 下一步 → 名称校验 → 确认摘要 → 部署成功 onDeployed → 完成关闭
 * - fabric 加载器下拉（自动回填首个 loader）
 * - 部署中：进度条（useDeployStore.setState 注入 progress）+ stage 中文标签 + 传输字节 MB + 禁用关闭
 * - 部署失败：error 块 + 重试回到步骤①
 * - 取消部署：确认后按实例 id 调服务端取消端点；cancelled 终态走「已取消」视图（非失败）
 * - dirty 关闭拦截（继续编辑 / 放弃配置）；未修改直接关闭
 * mock 数据为结构占位（虚构版本/实例），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { Toaster, toast } from 'sonner'
import {
  handlers,
  deployMock,
  deployCancelMock,
  deployStatusMock,
  startMock,
  eulaMock,
} from '@/test/mocks/handlers'
import { DeployDialog } from '../deploy-dialog'
import { useDeployStore } from '@/stores/deploy'
import { useConnectionStore } from '@/stores/connection'
import type { DeployResult } from '@/api/types'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

// radix Select/下拉依赖 Pointer Capture API（jsdom 未实现，缺失会崩溃）
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

function renderDialog() {
  const qc = new QueryClient()
  const onDeployed = vi.fn<(result: DeployResult) => void>()
  const onOpenChange = vi.fn<(open: boolean) => void>()
  render(
    <QueryClientProvider client={qc}>
      <DeployDialog open onOpenChange={onOpenChange} onDeployed={onDeployed} />
    </QueryClientProvider>,
  )
  return { onDeployed, onOpenChange }
}

/** 带 Toaster 的渲染（仅断言 toast 文案的用例需要；其余用例不挂以避免 toast 文本混入查询面） */
function renderDialogWithToaster() {
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <Toaster />
      <DeployDialog open onOpenChange={vi.fn()} onDeployed={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** 等待版本列表就绪并自动回填（fabric 默认 mock 首个版本 1.21.4） */
async function waitVersion() {
  await screen.findByText('1.21.4')
}

/** 走到步骤③并勾选 EULA（弹既有用例公共前置） */
async function gotoStep3AndAgreeEula(user: ReturnType<typeof userEvent.setup>) {
  await waitVersion()
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await user.type(screen.getByLabelText('实例名称'), '我的生存服')
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await user.click(screen.getByRole('checkbox', { name: /Minecraft EULA/ }))
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  // sonner toast store 是模块级：清残留防跨用例泄漏（反向断言「无失败提示」会被上一条污染）
  toast.dismiss()
  useDeployStore.setState({ progress: null, deploying: false, lastResult: null, cancelling: false })
  deployMock.shouldFail = false
  deployMock.cancelEcho = false
  deployMock.cancelEchoDetails = null
  deployMock.lastBody = null
  deployCancelMock.notInFlight = false
  deployCancelMock.lastBody = null
  deployStatusMock.active = false
  startMock.eulaRequired = false
  startMock.shouldFail = false
  startMock.calls = 0
  eulaMock.shouldFail = false
  eulaMock.calls = 0
})

describe('DeployDialog', () => {
  it('三步流程：类型选择 → 版本出现 → 下一步 → 名称校验 → 确认摘要 → 部署成功 onDeployed → 完成关闭', async () => {
    const { onDeployed, onOpenChange } = renderDialog()
    const user = userEvent.setup()

    // 步骤①：5 张类型卡（默认 paper 选中）+ 版本列表自动回填
    // （注意 purpur 说明「Paper 分支」含 Paper，需 ^ 锚定精确匹配）
    expect(screen.getAllByRole('radio')).toHaveLength(5)
    expect(screen.getByRole('radio', { name: /^Paper/ })).toBeChecked()
    await waitVersion()
    expect(screen.getByRole('combobox', { name: '选择 Minecraft 版本' })).toHaveTextContent(
      '1.21.4',
    )
    // Java 推荐提示
    expect(screen.getByText(/推荐 Java 版本：21/)).toBeInTheDocument()

    // 切换类型 → 版本随类型重新拉取（仍自动回填）
    await user.click(screen.getByRole('radio', { name: /fabric/i }))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '选择 Minecraft 版本' })).toHaveTextContent(
        '1.21.4',
      ),
    )

    // 下一步 → 步骤②
    await user.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByRole('button', { name: '上一步' })).toBeInTheDocument()

    // 名称校验：空名点下一步 → 错误文案且不前进
    await user.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('请填写实例名称')).toBeInTheDocument()
    expect(screen.getByLabelText('实例名称')).toBeInTheDocument()

    // 填写名称后错误消失，可前进
    await user.type(screen.getByLabelText('实例名称'), '我的生存服')
    expect(screen.queryByText('请填写实例名称')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '下一步' }))

    // 步骤③：确认摘要（类型/版本/名称/内存/Java 推荐）+ EULA 同意勾选
    // mock overview totalMemory=16 → 推荐档位 8G（50% 推荐覆盖逻辑）
    expect(screen.getByText('确认部署')).toBeInTheDocument()
    expect(screen.getByText('Fabric')).toBeInTheDocument()
    expect(screen.getByText('我的生存服')).toBeInTheDocument()
    expect(screen.getByText('8G')).toBeInTheDocument()
    expect(screen.getByText('推荐 Java')).toBeInTheDocument()
    expect(screen.getByText('21')).toBeInTheDocument()

    // EULA 不再阻断部署：未勾选时主操作为「仅部署」（可点），勾选后变「部署并启动」
    expect(screen.getByRole('button', { name: '仅部署' })).toBeEnabled()
    expect(
      screen.getByText(
        '未勾选也可部署：eula.txt 记为 eula=false，部署后不自动启动；需在实例详情同意 EULA 后才能启动服务器。',
      ),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /Minecraft EULA/ }))
    expect(screen.getByRole('button', { name: '部署并启动' })).toBeEnabled()

    // 部署并启动 → 成功结果块（含服务端/推荐 Java 信息行 + 自动启动状态）
    await user.click(screen.getByRole('button', { name: '部署并启动' }))
    expect(await screen.findByText('部署成功')).toBeInTheDocument()
    expect(screen.getByText('实例 ID：inst-deploy-001')).toBeInTheDocument()
    expect(screen.getByText('名称：我的生存服')).toBeInTheDocument()
    expect(screen.getByText('服务端：Fabric 1.21.4')).toBeInTheDocument()
    expect(screen.getByText('推荐 Java 版本：21')).toBeInTheDocument()
    // 首启闭环：EULA 同意随部署请求下发（服务端据此写 eula.txt），随后只发启动指令
    expect(
      await screen.findByText('已发送启动指令，服务器正在启动（状态可在仪表盘查看）'),
    ).toBeInTheDocument()
    // 自动启动状态块的档位：成功走 success 档，且不得混入 info 前景——它是「已受理」
    // 而非「有消息要看」。断言色类而非仅存在性：走查发现该处曾被染色错档，
    // 而存在性断言抓不到（文案对、颜色错）
    const autoStartBanner = screen
      .getByText('已发送启动指令，服务器正在启动（状态可在仪表盘查看）')
      .closest('[role="status"]') as HTMLElement
    expect(autoStartBanner.className).toContain('border-mcs-success-border')
    expect(autoStartBanner.className).not.toContain('text-mcs-info-fg')
    expect(deployMock.lastBody?.eula).toBe(true)
    expect(eulaMock.calls).toBe(0)
    expect(startMock.calls).toBe(1)

    // 完成 → onDeployed(result) + 关闭
    await user.click(screen.getByRole('button', { name: '完成' }))
    expect(onDeployed).toHaveBeenCalledTimes(1)
    const result = onDeployed.mock.calls[0]?.[0]
    expect(result?.id).toBe('inst-deploy-001')
    expect(result?.name).toBe('我的生存服')
    expect(result?.mcVersion).toBe('1.21.4')
    expect(result?.maxMemory).toBe('8G')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('fabric 类型显示加载器下拉（loaders 自动回填首个）', async () => {
    renderDialog()
    const user = userEvent.setup()
    await waitVersion()
    expect(screen.queryByRole('combobox', { name: '选择加载器版本' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /fabric/i }))
    expect(await screen.findByRole('combobox', { name: '选择加载器版本' })).toHaveTextContent(
      '0.16.9',
    )
  })

  it('部署中：进度条 + stage 中文标签 + 传输字节 MB 格式化 + 禁用关闭', () => {
    renderDialog()
    // 注入部署进度（挂载后注入：打开时组件会 resetDeploy 清态）
    act(() => {
      useDeployStore.setState({
        deploying: true,
        progress: { stage: 'download', percent: 0.45, transferred: 52_428_800, total: 104_857_600 },
      })
    })

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '45')
    expect(screen.getByText('正在下载服务端核心…')).toBeInTheDocument()
    expect(screen.getByText('45%')).toBeInTheDocument()
    // 52428800B = 50.0 MB；104857600B = 100 MB
    expect(screen.getByText('已下载 50.0 / 100 MB')).toBeInTheDocument()
    // 禁用关闭：无 X 按钮
    expect(screen.queryByRole('button', { name: '关闭弹窗' })).not.toBeInTheDocument()
    // 无步骤导航
    expect(screen.queryByRole('button', { name: '上一步' })).not.toBeInTheDocument()
  })

  it('部署中（progress 为 null）：不确定进度占位文案', () => {
    renderDialog()
    act(() => {
      useDeployStore.setState({ deploying: true, progress: null })
    })
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(screen.getByText('正在部署…')).toBeInTheDocument()
  })

  it('恢复场景：打开时保留进行中的部署进度（页面刷新后 WS 补发恢复态不被 reset，issue 352）', () => {
    // 预置恢复态（模拟刷新后 WS 连接补发已写入 store）
    act(() => {
      useDeployStore.setState({
        deploying: true,
        progress: {
          stage: 'forge_install',
          percent: 0,
          transferred: 0,
          total: 0,
          instanceId: 'forge-abc1',
          instanceName: 'Forge 服',
        },
        lastResult: null,
      })
    })
    renderDialog()

    // 直接显示部署视图且进度保留（Forge 安装中）
    expect(screen.getByText('正在安装 Forge…')).toBeInTheDocument()
    expect(useDeployStore.getState().progress?.stage).toBe('forge_install')
    expect(useDeployStore.getState().deploying).toBe(true)
  })

  it('无进行中部署时打开照常重置（终态残留不进入部署视图）', () => {
    act(() => {
      useDeployStore.setState({
        deploying: false,
        progress: { stage: 'complete', percent: 1, transferred: 0, total: 0 },
        lastResult: { ok: true, instanceId: 'vanilla-x' },
      })
    })
    renderDialog()

    // 表单视图（步骤①）而非部署进度视图，store 已重置
    expect(screen.getAllByRole('radio')).toHaveLength(5)
    expect(useDeployStore.getState().progress).toBeNull()
    expect(useDeployStore.getState().deploying).toBe(false)
  })

  it('部署失败：error 块 + 重试回到步骤①', async () => {
    deployMock.shouldFail = true
    const { onDeployed } = renderDialog()
    const user = userEvent.setup()

    await gotoStep3AndAgreeEula(user)
    await user.click(screen.getByRole('button', { name: '部署并启动' }))

    // 失败 error 块（错误码 50000 → 友好文案）
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('服务器内部错误，请稍后重试')).toBeInTheDocument()
    expect(onDeployed).not.toHaveBeenCalled()

    // 重试 → 回到步骤①（类型卡可见）
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(screen.getAllByRole('radio')).toHaveLength(5)
    expect(screen.getByRole('button', { name: '下一步' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('dirty 关闭拦截：修改后关闭弹确认；继续编辑保留；放弃配置后关闭并 resetDeploy', async () => {
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()

    await waitVersion()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await user.type(screen.getByLabelText('实例名称'), 'x')

    // 点关闭 → 确认框
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))
    expect(screen.getByText('放弃部署配置？')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()

    // 继续编辑 → 留在对话框
    await user.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.queryByText('放弃部署配置？')).not.toBeInTheDocument()

    // 再关 → 放弃配置 → 关闭 + 部署状态重置
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))
    await user.click(screen.getByRole('button', { name: '放弃配置' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(useDeployStore.getState().lastResult).toBeNull()
  })

  it('未修改配置时取消直接关闭（无确认）', async () => {
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()
    await waitVersion()

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(useDeployStore.getState().lastResult).toBeNull()
  })

  it('上一步返回步骤①再前进：表单值保留（拆分后主流程回归，组件层状态提升验证）', async () => {
    renderDialog()
    const user = userEvent.setup()
    await waitVersion()

    // 步骤②填写名称 → 上一步回步骤① → 再前进
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await user.type(screen.getByLabelText('实例名称'), '我的生存服')
    await user.click(screen.getByRole('button', { name: '上一步' }))
    expect(screen.getAllByRole('radio')).toHaveLength(5)

    await user.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByLabelText('实例名称')).toHaveValue('我的生存服')
    // 步骤②无名称错误残留（前进时校验已清空）
    expect(screen.queryByText('请填写实例名称')).not.toBeInTheDocument()
  })

  it('EULA 同意随请求下发；自动启动失败展示降级提示', async () => {
    startMock.shouldFail = true // 同意已随部署下发，但启动指令失败
    renderDialog()
    const user = userEvent.setup()

    await gotoStep3AndAgreeEula(user)
    await user.click(screen.getByRole('button', { name: '部署并启动' }))
    expect(await screen.findByText('部署成功')).toBeInTheDocument()
    // 自动启动失败：结果块降级提示（部署本身仍成功）
    expect(await screen.findByText('自动启动失败，可稍后在实例页手动启动')).toBeInTheDocument()
    expect(deployMock.lastBody?.eula).toBe(true)
    expect(eulaMock.calls).toBe(0)
    expect(startMock.calls).toBe(1)
  })

  it('未勾选 EULA 仍可部署：eula=false 下发且不自动启动', async () => {
    renderDialog()
    const user = userEvent.setup()

    await waitVersion()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await user.type(screen.getByLabelText('实例名称'), '我的生存服')
    await user.click(screen.getByRole('button', { name: '下一步' }))
    // 不勾选 EULA：主操作退化为「仅部署」，不再被禁用（不同意的用户也能完成部署）
    await user.click(screen.getByRole('button', { name: '仅部署' }))
    expect(await screen.findByText('部署成功')).toBeInTheDocument()
    expect(deployMock.lastBody?.eula).toBe(false)
    expect(startMock.calls).toBe(0)
    expect(eulaMock.calls).toBe(0)
  })
})

describe('DeployDialog 取消部署', () => {
  /**
   * 在途快照与注入的进度必须同源：兜底查询（挂载即问服务端真值）会覆盖 store，
   * 若两边 instanceId 不同，取消请求带的是快照那个 id，断言就不再承重。
   * 故这里直接吃 mock 快照的 id（真实场景下刷新恢复的 id 也来自该快照）。
   */
  const IN_FLIGHT = {
    stage: 'forge_install',
    percent: 0,
    transferred: 0,
    total: 0,
    instanceId: 'paper-a1b2c3d4',
    instanceName: '演示实例',
  }

  it('部署中：进度视图提供「取消部署」入口（点开前不显示确认框）', () => {
    renderDialog()
    act(() => {
      useDeployStore.setState({ deploying: true, progress: { ...IN_FLIGHT } })
    })
    expect(screen.getByRole('button', { name: '取消部署' })).toBeEnabled()
    expect(screen.queryByText('取消部署？')).not.toBeInTheDocument()
  })

  it('确认取消：按实例 id 调服务端取消端点，按钮转「正在取消…」并禁用', async () => {
    deployStatusMock.active = true
    const user = userEvent.setup()
    renderDialog()
    act(() => {
      useDeployStore.setState({ deploying: true, progress: { ...IN_FLIGHT } })
    })

    await user.click(screen.getByRole('button', { name: '取消部署' }))
    // 二次确认：中断会清理已下载内容，误触代价高
    expect(await screen.findByText('取消部署？')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '中断并清理' }))

    await waitFor(() => expect(deployCancelMock.lastBody).toEqual({ instanceId: 'paper-a1b2c3d4' }))
    expect(useDeployStore.getState().cancelling).toBe(true)
    expect(screen.getByRole('button', { name: '正在取消部署' })).toBeDisabled()
  })

  it('服务端回「无可取消对象」（40906）：失败可见且解除取消中状态，可重试', async () => {
    deployStatusMock.active = true
    deployCancelMock.notInFlight = true
    renderDialogWithToaster()
    const user = userEvent.setup()
    act(() => {
      useDeployStore.setState({ deploying: true, progress: { ...IN_FLIGHT } })
    })

    await user.click(screen.getByRole('button', { name: '取消部署' }))
    await user.click(await screen.findByRole('button', { name: '中断并清理' }))

    expect(await screen.findByText(/取消部署失败：该部署已结束或不在进行中/)).toBeInTheDocument()
    await waitFor(() => expect(useDeployStore.getState().cancelling).toBe(false))
    expect(screen.getByRole('button', { name: '取消部署' })).toBeEnabled()
  })

  it('取消终态：显示已取消视图（不是失败视图），「重新部署」回到步骤①', async () => {
    const user = userEvent.setup()
    renderDialog()
    act(() => {
      useDeployStore.setState({ deploying: true, progress: { ...IN_FLIGHT } })
      // 服务端终态事件（WS deployProgress stage=cancelled）
      useDeployStore.getState().applyDeployProgress({
        stage: 'cancelled',
        percent: 0,
        transferred: 0,
        total: 0,
        instanceId: 'paper-cancel01',
      })
    })

    expect(screen.getByText('部署已取消，未完成的实例目录已清理。')).toBeInTheDocument()
    expect(screen.queryByText(/部署失败/)).not.toBeInTheDocument()
    // 取消后实例未创建：主操作是重新部署，而不是「完成」
    expect(screen.queryByRole('button', { name: '完成' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重新部署' }))
    expect(screen.getByRole('button', { name: '下一步' })).toBeInTheDocument()
  })

  it('部署请求以 409 TASK_CANCELLED 结束：走已取消视图而不是「部署失败」', async () => {
    deployMock.cancelEcho = true
    renderDialog()
    const user = userEvent.setup()

    await gotoStep3AndAgreeEula(user)
    await user.click(screen.getByRole('button', { name: '部署并启动' }))

    expect(await screen.findByText('部署已取消，未完成的实例目录已清理。')).toBeInTheDocument()
    expect(screen.queryByText(/部署失败/)).not.toBeInTheDocument()
    // 自动启动只跟成功路径走：取消后不得再发启动指令
    expect(startMock.calls).toBe(0)
  })

  it('仅靠 POST 回声（WS 未送达）时据实显示收尾明细：不回落到「已清理」', async () => {
    deployMock.cancelEcho = true
    deployMock.cancelEchoDetails = { cleanup: '实例目录未能删除（EBUSY: resource busy）' }
    renderDialog()
    const user = userEvent.setup()

    await gotoStep3AndAgreeEula(user)
    await user.click(screen.getByRole('button', { name: '部署并启动' }))

    expect(await screen.findByText(/收尾未完成：实例目录未能删除（EBUSY/)).toBeInTheDocument()
    expect(screen.queryByText(/实例目录已清理/)).not.toBeInTheDocument()
  })

  it('收尾未完成（服务端带清理明细）：取消视图如实说明，不谎报已清理', () => {
    renderDialog()
    act(() => {
      useDeployStore.setState({ deploying: true, progress: { ...IN_FLIGHT } })
      useDeployStore.getState().applyDeployProgress({
        stage: 'cancelled',
        percent: 0,
        transferred: 0,
        total: 0,
        instanceId: 'paper-a1b2c3d4',
        error: '实例目录未能删除（EBUSY: resource busy）',
      })
    })

    expect(screen.getByText('部署已取消。')).toBeInTheDocument()
    expect(screen.getByText(/收尾未完成：实例目录未能删除（EBUSY/)).toBeInTheDocument()
    // 反向断言：不得同时出现「已清理」的说法（两种口径同屏即自相矛盾）
    expect(screen.queryByText(/实例目录已清理/)).not.toBeInTheDocument()
  })
})
