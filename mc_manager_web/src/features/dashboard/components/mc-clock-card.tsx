import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { worldTimePhase } from '@/lib/format'
import { Chip } from '@/components/mcs/chip'
import { useServerStore } from '@/stores/server'
import { useSendCommand } from '@/hooks/use-send-command'

/**
 * MC 时钟 · 世界控制卡
 * - 半圆弧昼夜进度（SVG 手绘，无第三方图表）：白天橙弧 / 夜晚靛弧 + 日月 orb
 * - 天气/时间 chips 点击即发命令（POST /command），RCON 文本回显终端
 * - 运行中本地秒级插值（tick +20/秒）：WS 等距推送间隙仍平滑推进
 */

const ARC_PATH = 'M 30 128 A 110 110 0 0 1 250 128'
const ARC_LEN = Math.PI * 110

/** tick 0-24000 → 昼夜分档（边界 13000 与 worldTimePhase「黄昏」对齐）+ 当前半段进度 */
export function dayCycle(tick: number): { day: boolean; progress: number } {
  const t = ((tick % 24000) + 24000) % 24000
  const day = t < 13000
  return { day, progress: day ? t / 13000 : (t - 13000) / 11000 }
}

/** 本地插值：距上次锚点 elapsed 秒，tick 以 20/秒 推进（MC 昼夜周期 = 20 分钟） */
export function interpolateTick(base: number, at: number, now: number, isRunning: boolean): number {
  if (!isRunning) return ((base % 24000) + 24000) % 24000
  const elapsedSec = Math.max((now - at) / 1000, 0)
  return (base + Math.floor(elapsedSec * 20)) % 24000
}

const WEATHER_PRESETS = [
  { key: 'clear', label: '☀ 晴天', cmd: 'weather clear' },
  { key: 'rain', label: '🌧 雨天', cmd: 'weather rain' },
  { key: 'thunder', label: '⛈ 雷暴', cmd: 'weather thunder' },
] as const

const TIME_PRESETS = [
  { key: 'day', label: '白天', cmd: 'time set day', tick: 1000 },
  { key: 'noon', label: '正午', cmd: 'time set noon', tick: 6000 },
  { key: 'evening', label: '黄昏', cmd: 'time set sunset', tick: 12000 },
  { key: 'night', label: '夜晚', cmd: 'time set night', tick: 13000 },
  { key: 'midnight', label: '午夜', cmd: 'time set midnight', tick: 18000 },
] as const

const WEATHER_LABEL: Record<'clear' | 'rain' | 'thunder', { label: string; icon: string }> = {
  clear: { label: '晴朗', icon: '☀️' },
  rain: { label: '雨天', icon: '🌧️' },
  thunder: { label: '雷暴', icon: '⛈️' },
}

export function McClockCard() {
  const status = useServerStore((s) => s.status)
  const { send, isRunning } = useSendCommand()
  const [now, setNow] = useState(Date.now())
  const anchorRef = useRef<{ tick: number; at: number } | null>(null)

  // 秒级重渲染驱动本地插值
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const rawTick = status?.worldTime ?? null
  if (rawTick != null) {
    const base = anchorRef.current
    if (!base || base.tick !== rawTick) anchorRef.current = { tick: rawTick, at: Date.now() }
  }
  const anchored = anchorRef.current && rawTick != null ? anchorRef.current.tick : null
  const tick = anchored != null ? interpolateTick(anchored, anchorRef.current!.at, now, isRunning) : null
  const cycle = tick != null ? dayCycle(tick) : null
  const phase = worldTimePhase(tick)
  const weather = status?.weather ?? null
  const worldDay = status?.worldDay ?? null
  const rcon = status?.isRconConnected ?? false
  const canControl = isRunning && rcon && tick != null

  return (
    <section className="flex shrink-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-4">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-mcs-sm font-medium text-mcs-text-muted">MC 时钟 · 世界控制</h3>
        <span className="flex size-6 items-center justify-center rounded-full border border-mcs-border-muted text-mcs-text-muted">
          <Clock className="size-3.5" aria-hidden />
        </span>
      </header>

      {/* 半圆弧昼夜进度（白天橙 / 夜晚靛；0-24000 全周期标尺） */}
      <svg
        viewBox="0 0 280 148"
        className="mt-1 w-full"
        role="img"
        aria-label={`世界时间：${phase}${tick != null ? `，${Math.round(tick)} tick` : ''}，天气：${weather ? WEATHER_LABEL[weather].label : '未知'}，第 ${worldDay ?? '--'} 天`}
      >
        <path d={ARC_PATH} fill="none" stroke="var(--mcs-border-muted)" strokeWidth={5} strokeLinecap="round" />
        {cycle && (
          <path
            d={ARC_PATH}
            fill="none"
            stroke={cycle.day ? 'var(--mcs-warning-fg)' : 'var(--mcs-info-fg)'}
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={`${cycle.progress * ARC_LEN} ${ARC_LEN}`}
            style={{ transition: 'stroke-dasharray 0.3s linear, stroke 0.3s ease' }}
          />
        )}
        <circle cx={140} cy={20} r={13} fill="var(--mcs-bg-default)" stroke="var(--mcs-border-default)" strokeWidth={1.5} />
        <text x={140} y={25} textAnchor="middle" fontSize={13}>
          {cycle?.day ? '☀' : '🌙'}
        </text>
        <text
          x={140}
          y={4}
          textAnchor="middle"
          fontSize={10}
          fontWeight={600}
          fill={cycle?.day ? 'var(--mcs-warning-fg)' : 'var(--mcs-info-fg)'}
        >
          {phase}
        </text>
        <text x={140} y={92} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--mcs-text-default)">
          {weather ? WEATHER_LABEL[weather].label : '--'}
        </text>
        <text x={140} y={114} textAnchor="middle" fontSize={24}>
          {weather ? WEATHER_LABEL[weather].icon : '⛅'}
        </text>
        <text x={140} y={141} textAnchor="middle" fontSize={14} fontWeight={650} fill="var(--mcs-text-muted)">
          第 {worldDay ?? '--'} 天
        </text>
      </svg>

      {/* tick 标尺 0 —— 当前 —— 24000（px-[10.7%] 使 0/24000 与上方弧端点对齐：弧 viewBox 两端各留 30/280） */}
      <div className="mt-1 flex items-center gap-2 px-[10.7%] font-mono text-mcs-2xs text-mcs-text-subtle">
        <span>0</span>
        <span className="h-px flex-1 border-t border-dashed border-mcs-border-muted" />
        <span className="tnum font-medium" style={{ color: 'var(--mcs-warning-fg)' }}>
          {tick != null ? `${Math.round(tick)} tick` : '-- tick'}
        </span>
        <span className="h-px flex-1 border-t border-dashed border-mcs-border-muted" />
        <span>24000</span>
      </div>

      {/* 天气 */}
      <div className="mt-2 flex items-center gap-2">
        <span className="flex w-8 shrink-0 items-center text-mcs-2xs text-mcs-text-subtle">天气</span>
        <div className="flex flex-1 gap-1.5">
          {WEATHER_PRESETS.map((w) => (
            <Chip
              key={w.key}
              tone="default"
              selected={weather === w.key}
              disabled={!canControl}
              onClick={() => send(w.cmd)}
              className="flex-1"
            >
              {w.label}
            </Chip>
          ))}
        </div>
      </div>

      {/* 时间 */}
      <div className="mt-1.5 flex items-center gap-2">
        <span className="flex w-8 shrink-0 items-center text-mcs-2xs text-mcs-text-subtle">时间</span>
        <div className="flex flex-1 gap-1.5">
          {TIME_PRESETS.map((p) => (
            <Chip
              key={p.key}
              tone="default"
              selected={worldTimePhase(p.tick) === phase && tick != null}
              disabled={!canControl}
              onClick={() => send(p.cmd)}
              className="flex-1"
            >
              {p.label}
            </Chip>
          ))}
        </div>
      </div>

      <p className="mt-2 text-mcs-2xs text-mcs-text-subtle">
        {rcon ? '点击即发送命令并联动时钟（运行中本地秒级插值推进）' : '需启用 RCON 才能控制世界时间与天气'}
      </p>
    </section>
  )
}
