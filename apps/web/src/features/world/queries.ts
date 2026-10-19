/**
 * 世界/属性域 TanStack Query hooks
 * - useWorldInfo：世界信息，30s 轮询（对齐 usePlayers 的 enabled 模式）
 * - useServerProperties：server.properties，30s 轮询
 * - useUpdateProperties：保存属性，成功后失效 properties + world（difficulty/
 *   gameMode/viewDistance 等世界字段直接来源于 properties，需同步刷新）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queries'
import {
  apiGetGamerules,
  apiGetProperties,
  apiGetPushChannel,
  apiGetWorld,
  apiSetPushChannel,
  apiUpdateProperties,
} from '@/api/world'
import { useConnectionStore } from '@/stores/connection'
import type { ServerProperties } from '@/api/types'
import { buildDatapackListCommand, parseDatapackList } from '@/lib/mc-datapack'

/** 世界信息（30s 轮询；WS 事件/属性保存后另行失效） */
export function useWorldInfo(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.world(instanceId ?? ''),
    queryFn: () => apiGetWorld(config, instanceId ?? ''),
    enabled: config.status === 'ready' && Boolean(instanceId),
    refetchInterval: 30_000,
  })
}

/**
 * 游戏规则当前值（GET /gamerules，一次取整份快照）。
 *
 * **不轮询**：这份数据只在用户点刷新、或保存某条规则之后才需要更新；每次读取都是一条
 * `help gamerule` 加至多 58 条串行读值命令，挂 refetchInterval 等于定时向服务器发命令。
 *
 * 命令通道不可用（RCON 未连接）时由调用方传入 `enabled=false` 不发请求：服务端此刻只会回
 * `source: 'none'`，与「两条通道都读不到」同形，而两者处置不同（一个是等连接、一个是重试）。
 *
 * `staleTime` 与同域其它查询同档（30s），替这一档把关的不是时效而是**载荷成本**：整份快照
 * 背后是一次名单查询加几十条串行读值命令，30s 内重复触发纯属让服务器白跑一遍。窗口内新增
 * 的 observer（重挂载、切回本 Tab）直接吃缓存，不再打第二发；超过窗口重挂载会重取一次，
 * 那是「数据可能变了」的正常语义。乐观值的寿命不靠它——保存成功走的是显式 refetch。
 *
 * `queryFn` 刻意**不读 `signal`**：读它会把这一轮取数标记成「可中止」，而 React StrictMode
 * 的双挂载（卸载 → 中止并回滚 → 重新挂载 → 重新取）实测在真实浏览器里打出两发
 * （第一发 \`ERR_ABORTED\`，但服务端那次名单查询与几十条读值已经跑完了）。这份快照是只读的，
 * 结果本就该进缓存，让它在组件闪断时继续跑完，比中止再重取一次更省；不读信号时移除
 * observer 只会停掉重试、不取消在途请求，第二次挂载直接复用同一发。
 */
export function useGamerules(instanceId: string | null, enabled = true) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.gamerules(instanceId ?? ''),
    queryFn: () => apiGetGamerules(config, instanceId ?? ''),
    enabled: enabled && config.status === 'ready' && Boolean(instanceId),
    staleTime: 30_000,
    retry: false,
  })
}

/** server.properties（30s 轮询；仅连接就绪时启用） */
export function useServerProperties(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.properties(instanceId ?? ''),
    queryFn: () => apiGetProperties(config, instanceId ?? ''),
    enabled: config.status === 'ready' && Boolean(instanceId),
    refetchInterval: 30_000,
  })
}

/** 保存 server.properties；成功后失效 properties 与 world 查询（UI 层负责 toast/restartRequired 提示） */
export function useUpdateProperties(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (props: ServerProperties) => {
      if (!instanceId) throw new Error('未选择实例')
      return apiUpdateProperties(config, instanceId, props)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.properties(instanceId ?? '') })
      void queryClient.invalidateQueries({ queryKey: queryKeys.world(instanceId ?? '') })
    },
  })
}

/**
 * 数据包列表（`datapack list` 的命令返回）。
 *
 * **不轮询**：数据包的增删只来自本面板发出的命令，动作完成后由调用方 `refetch` 即可；
 * 轮询等于每次都给服务器发一条命令并解析。
 *
 * 命令通道没回执、或返回措辞不认识时**抛错**——显示一个空列表会让用户以为
 * 「这个实例一个数据包都没有」，那是把「读不到」谎报成「没有」。
 */
export function useDatapackList(
  instanceId: string | null,
  sendCommand: (command: string) => Promise<string | null>,
  isReady: boolean,
) {
  return useQuery({
    queryKey: queryKeys.datapacks(instanceId ?? ''),
    queryFn: async () => {
      const raw = await sendCommand(buildDatapackListCommand())
      if (raw == null) throw new Error('命令通道没有返回内容，读不到数据包列表')
      const parsed = parseDatapackList(raw)
      if (parsed.unparsed !== null) throw new Error(`无法识别服务端返回：${parsed.unparsed}`)
      return parsed
    },
    enabled: isReady && Boolean(instanceId),
    retry: false,
  })
}

/**
 * 推送通道（MSMP）状态。
 *
 * 与 properties 同步失效：开关写的就是 server.properties 里的键，属性面板也展示它们，
 * 两条缓存各留一份旧值会让用户看到自相矛盾的界面。
 *
 * 消费点是实例设置弹窗（世界页不再常驻这张卡）：它写的就是 server.properties 里的键，
 * 而属性面板把这几个键渲染成只读行，开关放在同一处设置里才有意义。
 *
 * 不轮询：状态只可能被设置弹窗的开关或外部手改改变，前者由 mutation 失效、后者刷新页面即得。
 */
export function usePushChannel(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.pushChannel(instanceId ?? ''),
    queryFn: () => apiGetPushChannel(config, instanceId ?? ''),
    enabled: config.status === 'ready' && Boolean(instanceId),
    retry: false,
  })
}

/** 开关推送通道；成功后同时失效 push-channel 与 properties（两者展示同一份事实） */
export function useSetPushChannel(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) => apiSetPushChannel(config, instanceId ?? '', enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pushChannel(instanceId ?? '') })
      void queryClient.invalidateQueries({ queryKey: queryKeys.properties(instanceId ?? '') })
    },
  })
}
