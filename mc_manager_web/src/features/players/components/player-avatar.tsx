/**
 * PlayerAvatar —— 玩家头像
 * - 在线：mc-heads.net 3D 头像
 * - 离线：灰度滤镜（饱和度归零）
 * - 假人：Bot 图标
 * - 加载失败回退首字母
 */
import { useState } from 'react'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'

const AVATAR_BASE = 'https://mc-heads.net/avatar'

interface PlayerAvatarProps {
  name: string
  isOnline: boolean
  isFakePlayer?: boolean
  /** 像素尺寸（默认 32） */
  size?: number
  className?: string
}

export function PlayerAvatar({ name, isOnline, isFakePlayer = false, size = 32, className }: PlayerAvatarProps) {
  const [failed, setFailed] = useState(false)

  if (isFakePlayer) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-purple-bg-subtle text-mcs-purple-fg',
          className,
        )}
        style={{ width: size, height: size }}
        aria-label={`${name}（假人）`}
      >
        <Bot className="size-3/5" aria-hidden />
      </span>
    )
  }

  if (!failed) {
    return (
      <img
        src={`${AVATAR_BASE}/${encodeURIComponent(name)}/${size}`}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className={cn(
          'shrink-0 select-none rounded-mcs-sm',
          !isOnline && 'opacity-60 grayscale',
          className,
        )}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-mcs-sm bg-mcs-bg-secondary font-medium text-mcs-text-muted',
        !isOnline && 'opacity-60 grayscale',
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}
