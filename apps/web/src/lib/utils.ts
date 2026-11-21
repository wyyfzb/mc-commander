import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * 本仓字号 token 的类名后缀（对应 index.css 的 --text-mcs-*）。
 * 新增字号档必须同步登记到这里——漏登记不会报错，只会退回「被颜色类吞掉」的老毛病，
 * 故有用例遍历 index.css 逐个断言，漏了即红。
 */
const MCS_FONT_SIZE_SUFFIXES = [
  'mcs-2xs',
  'mcs-xs',
  'mcs-sm',
  'mcs-md',
  'mcs-lg',
  'mcs-xl',
  'mcs-display',
]

/** 圆角 token 后缀（对应 index.css 的 --radius-mcs-*）；分侧档一并登记 */
const MCS_RADIUS_SUFFIXES = ['mcs-xs', 'mcs-sm', 'mcs-md', 'mcs-lg']

/**
 * twMerge 只能按类名前缀猜分组，而 `text-*` 同时承载字号与颜色：它把本仓
 * `text-mcs-xs`（字号）与 `text-mcs-info-fg`（颜色）判成同组，后写者把前者挤掉，
 * 字号静默失效、元素回落为继承字号（侧栏导航、公告条等都受影响）。
 * 登记字号词汇表把尺寸档归还 font-size 组，颜色档仍走默认的颜色组，两者不再互吞。
 * 这是声明词汇表（与 `@theme` 注册 token 同性质），不是逐点打补丁——新页面自动受保护。
 *
 * 同时解除 font-size → leading 的默认互斥：本仓 `--text-mcs-*` 已配逐档行高，
 * 沿用该规则会让 `leading-none` 在字号类后写时被静默删除（实测标签行高 12px → 19.2px）。
 * Tailwind v4 本就用 `--tw-leading` 让两者叠加（`leading-*` 写变量、`text-*` 读它），
 * 且产物里 `.leading-*` 一律排在 `.text-*` 之后，同时保留即得行高方的值。
 * 口径边界：带行高修饰的写法（`text-mcs-xs/2`）自带行高，与标准档 `text-sm/6` 同口径，
 * 仍与 `leading-*` 互斥（后写者胜）——这是 v4 的实际语义，不是遗留例外，用例已锁。
 *
 * 圆角同理：`rounded-mcs-*` 不在 twMerge 默认词汇表里，基座档与调用点覆盖档会同时留下，
 * 胜负交给样式表顺序；登记后才由调用点决定（卡片内控件覆盖为 8、内嵌按钮覆盖为 6）。
 * 分侧档（rounded-t/b/l/r…）也登记，否则 `rounded-t-mcs-lg` 之类的局部覆盖不受控。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: MCS_FONT_SIZE_SUFFIXES }],
      rounded: [{ rounded: MCS_RADIUS_SUFFIXES }],
      'rounded-s': [{ 'rounded-s': MCS_RADIUS_SUFFIXES }],
      'rounded-e': [{ 'rounded-e': MCS_RADIUS_SUFFIXES }],
      'rounded-t': [{ 'rounded-t': MCS_RADIUS_SUFFIXES }],
      'rounded-r': [{ 'rounded-r': MCS_RADIUS_SUFFIXES }],
      'rounded-b': [{ 'rounded-b': MCS_RADIUS_SUFFIXES }],
      'rounded-l': [{ 'rounded-l': MCS_RADIUS_SUFFIXES }],
      'rounded-ss': [{ 'rounded-ss': MCS_RADIUS_SUFFIXES }],
      'rounded-se': [{ 'rounded-se': MCS_RADIUS_SUFFIXES }],
      'rounded-ee': [{ 'rounded-ee': MCS_RADIUS_SUFFIXES }],
      'rounded-es': [{ 'rounded-es': MCS_RADIUS_SUFFIXES }],
      'rounded-tl': [{ 'rounded-tl': MCS_RADIUS_SUFFIXES }],
      'rounded-tr': [{ 'rounded-tr': MCS_RADIUS_SUFFIXES }],
      'rounded-br': [{ 'rounded-br': MCS_RADIUS_SUFFIXES }],
      'rounded-bl': [{ 'rounded-bl': MCS_RADIUS_SUFFIXES }],
    },
  },
  // override 按键覆盖：只清空 font-size 的冲突表（其余 48 项原样保留，
  // 用例以原生 twMerge 为基准逐条对拍守住这一点）
  override: {
    conflictingClassGroups: { 'font-size': [] },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
