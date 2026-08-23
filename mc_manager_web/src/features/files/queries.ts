/**
 * 文件域 TanStack Query hooks
 * - useFileList：目录列表，无轮询（保存/删除成功后主动失效）
 * - useFileContent：文件内容，按 path 缓存；enabled 由调用方控制（编辑器打开才拉取）
 * - useSaveFile / useDeleteFile：mutation，成功后失效父目录列表与该文件内容缓存
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queries'
import {
  apiDeleteFile,
  apiGetFileContent,
  apiListFiles,
  apiSaveFileContent,
} from '@/api/files'
import { useConnectionStore } from '@/stores/connection'

/** 计算文件路径的父目录（与列表请求的 dir 参数格式一致：'/' 前缀风格） */
function parentDirOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  return idx <= 0 ? '/' : filePath.slice(0, idx)
}

/** 目录列表（无轮询；保存/删除后主动失效，避免轮询打扰编辑） */
export function useFileList(instanceId: string | null, dir: string) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.files(instanceId ?? '', dir),
    queryFn: () => apiListFiles(config, instanceId ?? '', dir),
    enabled: config.status === 'ready' && Boolean(instanceId),
    staleTime: 5_000,
  })
}

/** 文件内容（按完整文件路径缓存；打开编辑器时才拉取） */
export function useFileContent(
  instanceId: string | null,
  filePath: string | null,
  enabled = true,
) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.fileContent(instanceId ?? '', filePath ?? ''),
    queryFn: () => apiGetFileContent(config, instanceId ?? '', filePath ?? ''),
    enabled: config.status === 'ready' && Boolean(instanceId) && Boolean(filePath) && enabled,
    staleTime: 10_000,
  })
}

/** 保存文件（PUT /files/content）；成功后失效父目录列表 + 该文件内容缓存 */
export function useSaveFile(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ path, content }: { path: string; content: string }) => {
      if (!instanceId) throw new Error('未选择实例')
      return apiSaveFileContent(config, instanceId, path, content)
    },
    onSuccess: (_data, { path }) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.files(instanceId ?? '', parentDirOf(path)),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.fileContent(instanceId ?? '', path),
      })
    },
  })
}

/** 删除文件/目录（DELETE /files）；成功后失效父目录列表 */
export function useDeleteFile(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ path }: { path: string }) => {
      if (!instanceId) throw new Error('未选择实例')
      return apiDeleteFile(config, instanceId, path)
    },
    onSuccess: (_data, { path }) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.files(instanceId ?? '', parentDirOf(path)),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.fileContent(instanceId ?? '', path),
      })
    },
  })
}
