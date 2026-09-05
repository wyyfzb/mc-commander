/**
 * OverviewCells 展示原子件行为级测试（issue 489 拆分交付）
 * - Section：标题 + 子内容渲染
 * - InfoCell：label/value 渲染与 mono 等宽态
 * - StatCell：label/value 渲染
 * 数据全部为虚构占位
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InfoCell, Section, StatCell } from '../overview-cells'

describe('Section 分区容器', () => {
  it('渲染标题并透传子内容', () => {
    render(
      <Section title="基本信息">
        <p>虚构内容行</p>
      </Section>,
    )
    expect(screen.getByText('基本信息')).toBeInTheDocument()
    expect(screen.getByText('虚构内容行')).toBeInTheDocument()
  })
})

describe('InfoCell 信息单元', () => {
  it('渲染 label 与 value', () => {
    render(<InfoCell label="坐标" value="100, 64, -200" mono />)
    expect(screen.getByText('坐标')).toBeInTheDocument()
    expect(screen.getByText('100, 64, -200')).toBeInTheDocument()
  })

  it('默认非等宽（mono 缺省 false）仍正常渲染', () => {
    render(<InfoCell label="游戏模式" value="生存" />)
    expect(screen.getByText('游戏模式')).toBeInTheDocument()
    expect(screen.getByText('生存')).toBeInTheDocument()
  })
})

describe('StatCell 统计单元', () => {
  it('渲染 label 与 value', () => {
    render(<StatCell label="生命" value="20/20" />)
    expect(screen.getByText('生命')).toBeInTheDocument()
    expect(screen.getByText('20/20')).toBeInTheDocument()
  })
})
