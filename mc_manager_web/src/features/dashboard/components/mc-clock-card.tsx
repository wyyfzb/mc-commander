import { useEffect, useRef, useState } from 'react'
import {
  Clock,
  CloudLightning,
  CloudRain,
  Cloudy,
  Moon,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { worldTimePhase } from '@/lib/format'
import { Chip } from '@/components/mcs/chip'
import { useServerStore } from '@/stores/server'
import { useSendCommand } from '@/hooks/use-send-command'
import { useRadioGroup } from '@/hooks/use-radio-group'

/**
 * MC 时钟 · 世界控制卡
 * - 半圆弧昼夜进度（SVG 手绘，无第三方图表）：白天橙弧 / 夜晚靛弧 + 日月 orb
 * - 天气/时间 chips 点击即发命令（POST /command），RCON 文本回显终端
 * - 运行中本地秒级插值（tick +20/秒）：WS 等距推送间隙仍平滑推进
 *
 * 弧线色亮暗观感记录（2026-09-01）：
 *   弧线使用 --mcs-warning-fg（白天橙）和 --mcs-info-fg（夜晚蓝），非 accent 色。
 *   暗色：高饱和亮橙/亮蓝弧线在深底上醒目，昼夜区分明显。
 *   亮色：暗琥珀/暗蓝弧线在浅底上色调沉稳，昼夜对比仍可辨识
 *   （色相环角度差约 148 度，远超 40 度最小辨识阈值），观感可接受，无需额外调档。
 */

const ARC_PATH = 'M 30 152 A 110 110 0 0 1 250 152'
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
  { key: 'clear', label: '晴天', cmd: 'weather clear' },
  { key: 'rain', label: '雨天', cmd: 'weather rain' },
  { key: 'thunder', label: '雷暴', cmd: 'weather thunder' },
] as const

type WeatherKey = (typeof WEATHER_PRESETS)[number]['key']

// cmd 全部走 vanilla 合法值：/time set 只认 day/noon/night/midnight 关键字，
// 黄昏（sunset）非原生 → 用数值 tick 直设（12000 与 worldTimePhase 黄昏档对齐）
const TIME_PRESETS = [
  { key: 'day', label: '白天', cmd: 'time set day', tick: 1000 },
  { key: 'noon', label: '正午', cmd: 'time set noon', tick: 6000 },
  { key: 'evening', label: '黄昏', cmd: 'time set 12000', tick: 12000 },
  { key: 'night', label: '夜晚', cmd: 'time set night', tick: 13000 },
  { key: 'midnight', label: '午夜', cmd: 'time set midnight', tick: 18000 },
] as const

const WEATHER_LABEL: Record<'clear' | 'rain' | 'thunder', { label: string; Icon: LucideIcon }> = {
  clear: { label: '晴朗', Icon: Sun },
  rain: { label: '雨天', Icon: CloudRain },
  thunder: { label: '雷暴', Icon: CloudLightning },
}

export function McClockCard() {
  const status = useServerStore((s) => s.status)
  const { send, isRunning } = useSendCommand()
  // eslint-disable-next-line react/purity -- 幂等初值，StrictMode 双初始化仅差数毫秒，无可观察影响
  const [now, setNow] = useState(Date.now())
  const anchorRef = useRef<{ tick: number; at: number } | null>(null)

  // 秒级重渲染驱动本地插值
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const rawTick = status?.worldTime ?? null
  /* 渲染期锚点更新是有意设计：worldTime 由 store 推送驱动渲染，此时记录锚点供秒级插值；
     挪入 effect 会引入 setState-in-effect 级联与首帧无锚点闪烁，代价仅该组件不被 Compiler memo */
  /* eslint-disable react/refs, react/purity */
  if (rawTick != null) {
    const base = anchorRef.current
    if (!base || base.tick !== rawTick) anchorRef.current = { tick: rawTick, at: Date.now() }
  }
  const anchored = anchorRef.current && rawTick != null ? anchorRef.current.tick : null
  const tick = anchored != null ? interpolateTick(anchored, anchorRef.current!.at, now, isRunning) : null
  /* eslint-enable react/refs, react/purity */
  const weather = status?.weather ?? null
  const worldDay = status?.worldDay ?? null
  const rcon = status?.isRconConnected ?? false
  const canControl = isRunning && rcon && tick != null

  // 乐观更新窗口（对齐 Flutter 版 _weatherOptimisticUntil/_timeOptimisticUntil）：
  // 点击天气/时间 chip 后本地立即生效（图示/按钮即时联动），窗口内忽略服务器覆盖防抖，
  // 窗口外回落到服务器真实状态（WS 推送）——图示区/按钮区/服务器三联同步
  const [optimistic, setOptimistic] = useState<{ weather?: WeatherKey; timeTick?: number; until: number }>({ until: 0 })
  const optimisticActive = now < optimistic.until
  const displayWeather = optimisticActive && optimistic.weather ? optimistic.weather : weather
  const displayTick = optimisticActive && optimistic.timeTick != null ? optimistic.timeTick : tick
  const cycle = displayTick != null ? dayCycle(displayTick) : null
  const phase = worldTimePhase(displayTick)

  // 天气/时间两组 chip 是互斥单选：当前世界状态即「选中」，点击发命令（不可控时 on* 直接返回）
  /* eslint-disable react/purity -- 两处置 Date.now() 都只在用户事件（点击/方向键）里取当下时刻，
     乐观窗口以此为基准是本意；经 useRadioGroup 的 onChange 形参传递后，编译器无法判定它不在渲染期执行 */
  const applyWeather = (key: WeatherKey) => {
    if (!canControl) return
    const preset = WEATHER_PRESETS.find((w) => w.key === key)
    if (!preset) return
    setOptimistic({ weather: preset.key, timeTick: optimistic.timeTick, until: Date.now() + 3000 })
    send(preset.cmd)
  }
  const applyTime = (key: string) => {
    if (!canControl) return
    const preset = TIME_PRESETS.find((p) => p.key === key)
    if (!preset) return
    setOptimistic({ weather: optimistic.weather, timeTick: preset.tick, until: Date.now() + 3000 })
    send(preset.cmd)
  }
  /* eslint-enable react/purity */
  const weatherGroup = useRadioGroup<WeatherKey>({
    label: '天气',
    value: displayWeather ?? null,
    values: WEATHER_PRESETS.map((w) => w.key),
    onChange: applyWeather,
  })
  const activeTimeKey =
    displayTick != null ? (TIME_PRESETS.find((p) => worldTimePhase(p.tick) === phase)?.key ?? null) : null
  const timeGroup = useRadioGroup<string>({
    label: '时间',
    value: activeTimeKey,
    values: TIME_PRESETS.map((p) => p.key),
    onChange: applyTime,
  })

  return (
    <section className="animate-mcs-fade-up mcs-delay-5 mcs-edge-top relative flex shrink-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-4 shadow-mcs-card">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-mcs-sm font-medium text-mcs-text-muted">MC 时钟 · 世界控制</h3>
        <span className="flex size-6 items-center justify-center rounded-full border border-mcs-border-muted text-mcs-text-muted">
          <Clock className="size-3.5" aria-hidden />
        </span>
      </header>

      {/* 半圆弧昼夜进度（白天橙 / 夜晚靛；0-24000 全周期标尺） */}
      <svg
        viewBox="0 0 280 160"
        className="mt-1 w-full"
        role="img"
        aria-label={`世界时间：${phase}${displayTick != null ? `，${Math.round(displayTick)} tick` : ''}，天气：${displayWeather ? WEATHER_LABEL[displayWeather].label : '未知'}，第 ${worldDay ?? '--'} 天`}
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
        {/* 日月 orb 沿弧线跟随进度条头部移动（模拟日出→正午→日落轨迹）：圆心 (140,152) 半径 110，progress 0→1 对应角度 π→0 */}
        {(() => {
          const p = cycle?.progress ?? 0.5
          const theta = Math.PI * (1 - p)
          const orbX = 140 + 110 * Math.cos(theta)
          const orbY = 152 - 110 * Math.sin(theta)
          const OrbIcon = cycle?.day ? Sun : Moon
          const orbColor = cycle?.day ? 'var(--mcs-warning-fg)' : 'var(--mcs-info-fg)'
          return (
            <>
              {/* 光晕：弧线色半透明大圆，将 orb 从弧线/背景中托出 */}
              <circle cx={orbX} cy={orbY} r={18} fill={orbColor} opacity={0.16} />
              <circle cx={orbX} cy={orbY} r={13} fill="var(--mcs-bg-default)" stroke={orbColor} strokeWidth={2} />
              <OrbIcon
                x={orbX - 9}
                y={orbY - 9}
                width={18}
                height={18}
                stroke={orbColor}
                aria-hidden
              />
              {/* 阶段文字 pill 底衬：弧线上悬浮小字识别度低，加圆角底衬托底 */}
              <rect
                x={orbX - 15}
                y={orbY - 27}
                width={30}
                height={15}
                rx={7.5}
                fill="var(--mcs-bg-muted)"
                stroke="var(--mcs-border-muted)"
              />
              <text
                x={orbX}
                y={orbY - 16}
                textAnchor="middle"
                fontSize={10}
                fontWeight={600}
                fill={orbColor}
              >
                {phase}
              </text>
            </>
          )
        })()}
        <text x={140} y={88} textAnchor="middle" fontSize={16} fontWeight={600} fill="var(--mcs-text-default)">
          {displayWeather ? WEATHER_LABEL[displayWeather].label : '--'}
        </text>
        {/* 天气图标：未知天气用 Cloudy 占位（aria 由外层 svg label 承载） */}
        {(() => {
          const WeatherIcon = displayWeather ? WEATHER_LABEL[displayWeather].Icon : Cloudy
          return <WeatherIcon x={124} y={92} width={32} height={32} stroke="var(--mcs-text-muted)" aria-hidden />
        })()}
        <text x={140} y={140} textAnchor="middle" fontSize={14} fontWeight={650} fill="var(--mcs-text-muted)">
          第 {worldDay ?? '--'} 天
        </text>
      </svg>

      {/* tick 标尺 0 —— 当前 —— 24000（绝对定位：0/24000 居中于弧端点 x=30/250，当前值居中于弧线进度点） */}
      <div className="relative mt-1 h-4 font-mono text-mcs-2xs text-mcs-text-muted">
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 border-t border-dashed border-mcs-border-muted" />
        <span className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${(30 / 280) * 100}%` }}>0</span>
        {displayTick != null && (
          <span
            className="tnum absolute top-1/2 -translate-x-1/2 -translate-y-1/2 font-medium"
            style={{
              // 居中于两端点（0/24000）正中间，与左右数值形成对称锚点
              left: '50%',
              color: 'var(--mcs-warning-fg)',
            }}
          >
            {Math.round(displayTick)} tick
          </span>
        )}
        <span className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${(250 / 280) * 100}%` }}>24000</span>
      </div>

      {/* 天气 */}
      <div className="mt-2 flex items-center gap-2">
        <span className="flex w-8 shrink-0 items-center text-mcs-2xs text-mcs-text-muted">天气</span>
        <div className="flex flex-1 gap-1.5" {...weatherGroup.groupProps}>
          {WEATHER_PRESETS.map((w, index) => (
            <Chip
              key={w.key}
              tone="default"
              selected={displayWeather === w.key}
              disabled={!canControl}
              {...weatherGroup.itemProps(index)}
              onClick={() => applyWeather(w.key)}
              className="flex-1"
            >
              {w.label}
            </Chip>
          ))}
        </div>
      </div>

      {/* 时间 */}
      <div className="mt-1.5 flex items-center gap-2">
        <span className="flex w-8 shrink-0 items-center text-mcs-2xs text-mcs-text-muted">时间</span>
        <div className="flex flex-1 gap-1.5" {...timeGroup.groupProps}>
          {TIME_PRESETS.map((p, index) => (
            <Chip
              key={p.key}
              tone="default"
              selected={worldTimePhase(p.tick) === phase && displayTick != null}
              disabled={!canControl}
              {...timeGroup.itemProps(index)}
              onClick={() => applyTime(p.key)}
              className="flex-1"
            >
              {p.label}
            </Chip>
          ))}
        </div>
      </div>

    </section>
  )
}
