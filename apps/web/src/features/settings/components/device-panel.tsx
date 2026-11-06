/**
 * DevicePanel —— 「连接与外观」子页：面板连到哪台服务器 + 界面长什么样。
 *
 * 两段合并的依据是**换设备跟不跟过来**：连接配置与界面偏好都只落在这个浏览器的
 * localStorage（ui store 的 partialize 只放 theme / terminalAutoScroll /
 * confirmCommands），换设备/换浏览器都不会跟随；而通知偏好、账号与安全存在服务端，
 * 换设备仍在。按到达频率分组会让「换电脑后重新配一遍」散在两页里。
 *
 * 两段各自用 SettingsSectionCard：同一页里两种区块基座（Card+CardHeader 与
 * SettingsSectionCard）并存时，标题字号与图标底块会各走一套。
 */
import { Laptop } from 'lucide-react'
import { SettingsSectionCard } from './settings-section-card'
import { ConnectionForm } from './connection-form'
import { GeneralPreferencesFields } from './general-preferences-fields'

export function DevicePanel() {
  return (
    <div className="flex flex-col gap-3">
      <SettingsSectionCard
        icon={Laptop}
        title="面板连接"
        description="面板地址与访问凭据；只存在这台电脑上，换设备要重新填"
      >
        <ConnectionForm variant="settings" bare />
      </SettingsSectionCard>

      <SettingsSectionCard
        icon={Laptop}
        title="界面外观"
        description="主题与终端行为；同样只存在这台电脑上，换设备回到默认值"
      >
        <GeneralPreferencesFields />
      </SettingsSectionCard>
    </div>
  )
}
