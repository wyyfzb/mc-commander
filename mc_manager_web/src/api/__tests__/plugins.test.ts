import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { apiDeletePlugin, apiGetPlugins, apiSetPluginEnabled } from '../plugins'
import type { PluginList } from '../types'
import type { ConnectionConfig } from '../client'

const mockPlugins: PluginList = {
  plugins: [
    {
      file: 'EssentialsX-2.20.1.jar',
      name: 'EssentialsX-2.20.1',
      enabled: true,
      sizeBytes: 1_800_000,
      mtimeMs: 1_753_600_000_000,
      meta: {
        name: 'EssentialsX',
        version: '2.20.1',
        main: 'net.essentialsx.Essentials',
        apiVersion: '1.20',
        description: null,
        authors: ['EssentialsX Team'],
        depend: ['Vault'],
      },
    },
    {
      file: 'WorldEdit.jar.disabled',
      name: 'WorldEdit',
      enabled: false,
      sizeBytes: 900_000,
      mtimeMs: 1_753_500_000_000,
      meta: null,
    },
  ],
}

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok', code: 0, message: 'Success', data,
    timestamp: new Date().toISOString(),
  })
}

const server = setupServer(
  http.get('*/api/v1/instances/inst1/plugins', () => ok(mockPlugins)),
  http.put('*/api/v1/instances/inst1/plugins/:file/enabled', async ({ request, params }) => {
    const body = (await request.json()) as { enabled: boolean }
    const file = params.file as string
    return ok({ file: body.enabled ? file.replace(/\.disabled$/, '') : `${file}.disabled`, enabled: body.enabled })
  }),
  http.delete('*/api/v1/instances/inst1/plugins/:file', ({ params }) => ok({ deleted: params.file as string })),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

const config: ConnectionConfig = {
  baseUrl: 'http://localhost:25566',
  apiKey: 'test-key',
  status: 'ready',
} as unknown as ConnectionConfig

describe('plugins API', () => {
  it('GET 列表解包 data（含元数据与启停状态）', async () => {
    const res = await apiGetPlugins(config, 'inst1')
    const first = res.plugins[0]!
    const second = res.plugins[1]!
    expect(res.plugins).toHaveLength(2)
    expect(first.meta?.name).toBe('EssentialsX')
    expect(first.enabled).toBe(true)
    expect(second.file).toBe('WorldEdit.jar.disabled')
    expect(second.meta).toBeNull()
  })

  it('PUT 启停发送 {enabled} 并返回重命名结果（.disabled 后缀切换）', async () => {
    const disabled = await apiSetPluginEnabled(config, 'inst1', 'Vault.jar', false)
    expect(disabled).toEqual({ file: 'Vault.jar.disabled', enabled: false })

    const enabled = await apiSetPluginEnabled(config, 'inst1', 'Vault.jar.disabled', true)
    expect(enabled).toEqual({ file: 'Vault.jar', enabled: true })
  })

  it('DELETE 返回被删文件名（文件名经 URL 编码传输）', async () => {
    const res = await apiDeletePlugin(config, 'inst1', 'Vault.jar.disabled')
    expect(res.deleted).toBe('Vault.jar.disabled')
  })
})
