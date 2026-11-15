/**
 * ItemIcon —— 物品贴图（随包资源，缺图回退占位块）
 *
 * 为什么不是直接写 `<img src={itemImageUrl(id)}>`：目录里有 20 件 26.x 新物品没有随包贴图
 * （贴图包发布早于这些版本），调用点各自写 onError 会把"缺图"变成一个只有浏览器才知道的
 * 运行时状态——每个调用点都要重复一份 state，且首帧仍会闪一次空图。
 * 这里在渲染期就按 `itemImageUrl` 返回 null 判掉，占位块是首帧即正确的。
 *
 * 占位块取中性面 + 首字（不借语义色）：缺图不是一种"状态"，用 success/error 着色会把
 * 资源缺失读成"这件物品有问题"。
 */
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { itemImageUrl } from '@/lib/mc-items'

interface ItemIconProps {
  /** 物品 id（无命名空间前缀） */
  id: string
  /** 无障碍名（通常是物品中文名）；空串表示纯装饰（相邻文本已给出名称） */
  alt?: string
  /** 像素尺寸 */
  size: number
  className?: string
}

export function ItemIcon({ id, alt = '', size, className }: ItemIconProps) {
  const src = itemImageUrl(id)
  // 文件在、但字节坏了（构建产物损坏/磁盘错误）：位图解码失败只有 onError 能知道
  const [failed, setFailed] = useState(false)

  if (src === null || failed) {
    return (
      <span
        aria-hidden={alt === '' ? true : undefined}
        role={alt === '' ? undefined : 'img'}
        aria-label={alt === '' ? undefined : `${alt}（无贴图）`}
        className={cn(
          'flex shrink-0 select-none items-center justify-center rounded-mcs-xs bg-mcs-bg-secondary font-medium text-mcs-text-muted',
          className,
        )}
        style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.42)) }}
      >
        {id.slice(0, 1).toUpperCase()}
      </span>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('shrink-0 select-none', className)}
    />
  )
}
