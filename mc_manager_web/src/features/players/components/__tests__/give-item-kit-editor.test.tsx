/**
 * KitEditorDialog 脏状态关闭拦截测试（issue #347）：
 * 干净状态（无改动）关闭路径直接关闭；dirty（name/icon/desc/items 相对初始值有改动）
 * 时 ESC/遮罩/取消先弹确认（继续编辑保留 / 放弃修改关闭）；改动还原后回到干净语义。
 * mock 数据为结构占位（虚构礼包名），严禁真实玩家/服务器信息
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KitEditorDialog } from '../give-item-kit-editor'
import type { KitPreset } from '@/lib/mc-kits'

const INITIAL_KIT: KitPreset = {
  name: '新手起步包',
  icon: '📦',
  desc: '初始描述',
  items: [{ id: 'diamond', count: 1 }],
}

function renderEditor(initial: KitPreset = INITIAL_KIT, isNew = false) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(<KitEditorDialog initial={initial} isNew={isNew} onSave={onSave} onClose={onClose} />)
  return { onSave, onClose }
}

/** dirty 确认弹窗定位（嵌套 Dialog 时外层内容可能 aria-hidden，逐层找标题） */
async function findConfirmDialog() {
  const dialogs = await screen.findAllByRole('dialog')
  const confirm = dialogs.find((d) => within(d).queryByText('放弃未保存的修改？'))
  expect(confirm).toBeDefined()
  return confirm!
}

describe('KitEditorDialog 干净状态关闭（无改动）', { timeout: 15000 }, () => {
  it('取消按钮直接关闭，不弹确认', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('放弃未保存的修改？')).not.toBeInTheDocument()
  })

  it('ESC 直接关闭，不弹确认', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('放弃未保存的修改？')).not.toBeInTheDocument()
  })
})

describe('KitEditorDialog dirty 关闭拦截', { timeout: 15000 }, () => {
  it('改名后取消需确认：继续编辑保留，放弃修改才关闭', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    const nameInput = screen.getByLabelText('礼包名称')
    await user.clear(nameInput)
    await user.type(nameInput, '改过的礼包')
    await user.click(screen.getByRole('button', { name: '取消' }))
    const confirm = await findConfirmDialog()
    expect(onClose).not.toHaveBeenCalled()
    // 继续编辑 → 确认关闭，编辑器与输入保留
    await user.click(within(confirm).getByRole('button', { name: '继续编辑' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByLabelText('礼包名称')).toHaveValue('改过的礼包')
    // 再次取消 → 放弃修改 → onClose
    await user.click(screen.getByRole('button', { name: '取消' }))
    const confirm2 = await findConfirmDialog()
    await user.click(within(confirm2).getByRole('button', { name: '放弃修改' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('描述改动后 ESC 需确认；继续编辑不关闭', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await user.type(screen.getByLabelText('礼包描述'), '补充描述')
    await user.keyboard('{Escape}')
    const confirm = await findConfirmDialog()
    await user.click(within(confirm).getByRole('button', { name: '继续编辑' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('图标改动后点遮罩需确认；放弃修改后关闭', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await user.click(screen.getByRole('radio', { name: '选择图标 ⭐' }))
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay).not.toBeNull()
    await user.click(overlay!)
    const confirm = await findConfirmDialog()
    expect(onClose).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole('button', { name: '放弃修改' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('物品列表改动触发拦截：加物品 dirty，还原后干净直关', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await user.type(screen.getByLabelText('搜索礼包物品'), '钻石')
    await user.click(screen.getAllByRole('button', { name: /^钻石/ })[0]!)
    expect(screen.getByText('当前物品（2）')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    const confirm = await findConfirmDialog()
    await user.click(within(confirm).getByRole('button', { name: '继续编辑' }))
    expect(onClose).not.toHaveBeenCalled()
    // 移除新加物品（还原到初始 items）→ 深比较回到干净语义：直接关闭
    const removeButtons = screen.getAllByRole('button', { name: /^移除 / })
    await user.click(removeButtons[removeButtons.length - 1]!)
    expect(screen.getByText('当前物品（1）')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('放弃未保存的修改？')).not.toBeInTheDocument()
  })

  it('数量改动触发拦截；放弃修改后关闭', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await user.click(screen.getByRole('button', { name: '增加 钻石 数量' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    const confirm = await findConfirmDialog()
    await user.click(within(confirm).getByRole('button', { name: '放弃修改' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  describe('KitEditorDialog 图标单选组键盘模型', { timeout: 15000 }, () => {
    it('图标预设是单选组：方向键移动即选中且焦点跟随', () => {
      renderEditor()
      const group = screen.getByRole('radiogroup', { name: '礼包图标' })
      const icons = within(group).getAllByRole('radio')
      // 初始礼包图标为 📦 → 选中项即停靠点
      const selected = icons.findIndex((el) => el.getAttribute('aria-checked') === 'true')
      expect(selected).toBeGreaterThanOrEqual(0)
      expect(icons[selected]).toHaveAttribute('tabindex', '0')

      fireEvent.keyDown(group, { key: 'ArrowRight' })
      const next = icons[(selected + 1) % icons.length]
      expect(next).toHaveAttribute('aria-checked', 'true')
      expect(document.activeElement).toBe(next)
    })
  })
})
