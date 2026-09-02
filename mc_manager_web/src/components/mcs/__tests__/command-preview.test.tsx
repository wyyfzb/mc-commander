import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommandPreview } from '../command-preview'

const mockWriteText = vi.fn().mockResolvedValue(undefined)

describe('CommandPreview', () => {
  beforeEach(() => {
    mockWriteText.mockClear()
    Object.assign(navigator, {
      clipboard: { writeText: mockWriteText },
    })
  })

  it('渲染命令文本', () => {
    render(<CommandPreview command="give @p diamond 64" />)
    expect(screen.getByText('give @p diamond 64')).toBeTruthy()
  })

  it('data-testid 标识', () => {
    render(<CommandPreview command="/time set day" />)
    expect(screen.getByTestId('command-preview')).toBeTruthy()
  })

  it('复制按钮可点击', async () => {
    render(<CommandPreview command="weather clear" />)
    const btn = screen.getByLabelText('复制命令')
    fireEvent.click(btn)
    await vi.waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith('weather clear')
    })
  })
})
