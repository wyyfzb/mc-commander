/** RCON 断连提示横幅（经验/效果/召唤三表单共用） */
import { CloudOff } from 'lucide-react'
import { NoticeBanner } from '@/components/mcs/notice-banner'

export function OfflineBanner() {
  return (
    <NoticeBanner variant="warning" icon={CloudOff}>
      RCON 未连接，无法执行操作
    </NoticeBanner>
  )
}
