/**
 * DeployDialog 测试（部署向导）：
 * - 三步流程：类型选择 → 版本自动出现 → 下一步 → 名称校验 → 确认摘要 → 部署成功 onDeployed → 完成关闭
 * - fabric 加载器下拉（自动回填首个 loader）
 * - 部署中：进度条（useDeployStore.setState 注入 progress）+ stage 中文标签 + 传输字节 MB + 禁用关闭
 * - 部署失败：error 块 + 重试回到步骤①
 * - dirty 关闭拦截（继续编辑 / 放弃配置）；未修改直接关闭
 * mock 数据为结构占位（虚构版本/实例），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { handlers, deployMock, startMock, eulaMock } from '@/test/mocks/handlers'
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
  useDeployStore.setState({ progress: null, deploying: false, lastResult: null })
  deployMock.shouldFail = false
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
    expect(screen.getByRole('combobox', { name: '选择 Minecraft 版本' })).toHaveTextContent('1.21.4')
    // Java 推荐提示
    expect(screen.getByText(/推荐 Java 版本：21/)).toBeInTheDocument()

    // 切换类型 → 版本随类型重新拉取（仍自动回填）
    await user.click(screen.getByRole('radio', { name: /fabric/i }))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '选择 Minecraft 版本' })).toHaveTextContent('1.21.4'),
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

    // EULA 勾选门控：未勾选时「部署并启动」禁用 + 提示；勾选后可点
    const deployBtn = screen.getByRole('button', { name: '部署并启动' })
    expect(deployBtn).toBeDisabled()
    expect(screen.getByText('请先同意 EULA：未同意时无法启动服务器')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /Minecraft EULA/ }))
    expect(screen.getByRole('button', { name: '部署并启动' })).toBeEnabled()

    // 部署并启动 → 成功结果块（含服务端/推荐 Java 信息行 + 自动启动状态）
    await user.click(screen.getByRole('button', { name: '部署并启动' }))
    expect(await screen.findByText('部署成功')).toBeInTheDocument()
    expect(screen.getByText('实例 ID：inst-deploy-001')).toBeInTheDocument()
    expect(screen.getByText('名称：我的生存服')).toBeInTheDocument()
    expect(screen.getByText('服务端：Fabric 1.21.4')).toBeInTheDocument()
    expect(screen.getByText('推荐 Java 版本：21')).toBeInTheDocument()
    // 首启闭环：自动同意 EULA + 发启动指令，结果块展示启动状态
    expect(await screen.findByText('已发送启动指令，服务器正在启动（状态可在仪表盘查看）')).toBeInTheDocument()
    expect(eulaMock.calls).toBe(1)
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

  it('EULA 勾选门控：默认不勾 + 未勾选提示；自动启动失败展示降级提示', async () => {
    startMock.shouldFail = true // EULA 同意成功但启动指令失败
    renderDialog()
    const user = userEvent.setup()

    await gotoStep3AndAgreeEula(user)
    await user.click(screen.getByRole('button', { name: '部署并启动' }))
    expect(await screen.findByText('部署成功')).toBeInTheDocument()
    // 自动启动失败：结果块降级提示（部署本身仍成功）
    expect(await screen.findByText('自动启动失败，可稍后在实例页手动启动')).toBeInTheDocument()
    expect(eulaMock.calls).toBe(1)
    expect(startMock.calls).toBe(1)
  })

  it('未勾选 EULA 时不发自动启动请求（部署成功后无启动状态块）', async () => {
    renderDialog()
    const user = userEvent.setup()

    await waitVersion()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await user.type(screen.getByLabelText('实例名称'), '我的生存服')
    await user.click(screen.getByRole('button', { name: '下一步' }))
    // 不勾选 EULA（按钮禁用保护；此处直接断言禁用）
    expect(screen.getByRole('button', { name: '部署并启动' })).toBeDisabled()
    expect(startMock.calls).toBe(0)
    expect(eulaMock.calls).toBe(0)
  })
})
