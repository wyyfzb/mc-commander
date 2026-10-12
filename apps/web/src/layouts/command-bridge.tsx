/**
 * CommandBridge —— 全局命令执行器
 * 挂载于 AppShell：注册命令总线 baseRunner，将命令发送到当前实例（RCON/stdin 经服务端 command 端点）。
 * 仪表盘挂载时 CommandInput 的 overlayRunner（终端回显）优先级更高，离开仪表盘自动回退本执行器。
 * confirmCommands 偏好开启时，危险命令（非安全白名单）执行前弹确认——终端专家通道不受影响。
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { apiSendCommand } from '@/api/players'
import { getFriendlyErrorText } from '@/api/errors'
import { useCommandBus } from '@/stores/command-bus'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useUiStore } from '@/stores/ui'

/**
 * 安全白名单：只读/低风险命令（正则；确认偏好下免确认直接执行）。
 *
 * 前导 `/` 统一容忍：命令管道（服务端 sendCommand）会剥掉它，但本判据的入参是命令
 * 面板里的**原样文本**，无法保证一定不带。此前只为 `seed` 单写了一条带斜杠的替代分支，
 * 其余命令带上斜杠就落进「需要确认」——同一件事两种待遇。改为整条容忍。
 *
 * `gamerule` **只放行单参数形态**：`gamerule <规则名>` 是「读一条规则」（写形态必须带第二个
 * 参数，故读不进来）。裸 `gamerule` **不是**只读列表——实测 MC 26.3 与 1.21.4 都返回
 * `Unknown or incomplete command`；真正的只读列表面是 `/help gamerule`，已由 `help` 覆盖。
 * 规则名在 26.3 起是 snake_case（`keep_inventory`），1.21.x 是 camelCase（`keepInventory`），
 * 面板只按字符集校验、不按版本改写名字。
 */
const SAFE_COMMAND_PATTERNS: RegExp[] = [
  /^\/?(list|tps|help|save-all|say\s+|whitelist\s+(list|show)|gamerule\s+\S+\s*$|seed|version)/i,
]

export function isSafeCommand(command: string): boolean {
  return SAFE_COMMAND_PATTERNS.some((re) => re.test(command.trim()))
}

export function CommandBridge() {
  const config = useConnectionStore()
  const instanceId = useServerStore((s) => s.instanceId)
  const setBaseRunner = useCommandBus((s) => s.setBaseRunner)
  const confirmCommands = useUiStore((s) => s.confirmCommands)
  const [pendingCommand, setPendingCommand] = useState<string | null>(null)
  // setBaseRunner 依赖 confirmCommands 变化——ref 让执行器始终读最新偏好
  const confirmRef = useRef(confirmCommands)
  // eslint-disable-next-line react/refs -- latest-ref 模式：渲染期同步最新值，供 effect 注册的执行器闭包读取
  confirmRef.current = confirmCommands

  useEffect(() => {
    if (!instanceId) {
      setBaseRunner(null)
      return
    }
    setBaseRunner((command) => {
      void (async () => {
        // 二次确认偏好开启且命令不在安全白名单 → 挂起等待确认
        if (confirmRef.current && !isSafeCommand(command)) {
          setPendingCommand(command)
          return
        }
        try {
          await apiSendCommand(config, instanceId, command)
          // 成功不弹 toast：RCON 回显进终端日志流（失败仍 toast 告警）
        } catch (e) {
          toast.error(getFriendlyErrorText(e))
        }
      })()
    })
    return () => setBaseRunner(null)
  }, [config, instanceId, setBaseRunner])

  const doSend = async (command: string) => {
    try {
      await apiSendCommand(config, instanceId ?? '', command)
      // 同上：成功静默，终端日志流为反馈源
    } catch (e) {
      toast.error(getFriendlyErrorText(e))
    }
  }

  return (
    <ConfirmDialog
      open={pendingCommand !== null}
      onOpenChange={(open) => !open && setPendingCommand(null)}
      title="确认执行命令"
      description={`确定要向服务器执行命令 “${pendingCommand ?? ''}” 吗？`}
      confirmText="确认执行"
      danger
      onConfirm={() => {
        const cmd = pendingCommand
        setPendingCommand(null)
        if (cmd) void doSend(cmd)
      }}
    />
  )
}
