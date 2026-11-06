/**
 * 玩家可达性检测的结果说明
 *
 * 四种状态各自对应一个用户动作，缺一种就等于「点了按钮没有反馈」：
 * - reachable       无需动作
 * - blocked         本地在监听、外网连不进来 ⇒ 去云控制台放行端口（面板管不到这一层）
 * - not_listening   端口没监听 ⇒ 先启动；已在运行则等它就绪
 * - no_public_address 拿不到公网地址 ⇒ 面板所在机器没有公网 IP，玩家无法直连
 *
 * `state` 为 null 表示实例没在运行、无从判定。
 */
import type { Reachability } from '@mc-commander/schemas'

export type ReachabilityState = NonNullable<Reachability['state']>

export interface ReachabilityOutcome {
  /** 结论一句话（用户第一眼看的） */
  summary: string
  /** 下一步该做什么；null 表示无需动作 */
  action: string | null
}

/** 从 `地址:端口` 形态里取端口（取不到返回 null，不臆造默认值） */
export function portFromAddress(address: string | null | undefined): string | null {
  if (!address) return null
  const idx = address.lastIndexOf(':')
  if (idx < 0) return null
  const port = address.slice(idx + 1)
  return /^\d+$/.test(port) ? port : null
}

export function describeReachability(
  state: ReachabilityState,
  address: string | null | undefined,
): ReachabilityOutcome {
  switch (state) {
    case 'reachable':
      return { summary: '外网可以连进来', action: null }
    case 'blocked': {
      const port = portFromAddress(address)
      return {
        summary: '外网连不进来',
        action:
          port != null
            ? `本地已在监听，但请求到不了这个端口。登录你的云服务器控制台，在「安全组 / 防火墙」里放行 TCP ${port} 的入方向规则（阿里云、腾讯云、华为云均在这个位置）。`
            : '本地已在监听，但请求到不了这个端口。登录你的云服务器控制台，在「安全组 / 防火墙」里放行本实例端口的入方向规则（阿里云、腾讯云、华为云均在这个位置）。',
      }
    }
    case 'not_listening':
      return {
        summary: '端口还没有监听',
        action:
          '实例显示运行中时，先等它启动完成再看；一直如此就在实例设置里确认端口未被其他程序占用。',
      }
    case 'no_public_address':
      return {
        summary: '拿不到公网地址',
        action:
          '面板所在机器没有可对外的公网 IP，玩家无法直连；需要给这台机器分配公网 IP 或做端口映射。',
      }
  }
}
