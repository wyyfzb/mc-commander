import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { apiCreateDirectory, apiRenameFile } from '../files'
import type { ConnectionConfig } from '../client'

const config: ConnectionConfig = { baseUrl: '', apiKey: 'test-key' }

const server = setupServer(
  http.post('*/api/v1/instances/test-inst/files/mkdir', async ({ request }) => {
    const body = (await request.json()) as { path?: string }
    if (!body.path) return HttpResponse.json({ status: 'error', code: 40000, message: 'Validation Error', details: null, timestamp: '' }, { status: 400 })
    return HttpResponse.json({
      status: 'ok', code: 0, message: 'Directory created successfully',
      data: { path: body.path, name: body.path!.split('/').pop() },
      timestamp: new Date().toISOString(),
    })
  }),
  http.post('*/api/v1/instances/test-inst/files/rename', async ({ request }) => {
    const body = (await request.json()) as { path?: string; newPath?: string }
    if (!body.path || !body.newPath) return HttpResponse.json({ status: 'error', code: 40000, message: 'Validation Error', details: null, timestamp: '' }, { status: 400 })
    return HttpResponse.json({
      status: 'ok', code: 0, message: 'Renamed successfully',
      data: { oldPath: body.path, newPath: body.newPath, name: body.newPath!.split('/').pop() },
      timestamp: new Date().toISOString(),
    })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

describe('apiCreateDirectory', () => {
  it('creates a directory and returns path + name', async () => {
    const data = await apiCreateDirectory(config, 'test-inst', '/new-dir')
    expect(data.path).toBe('/new-dir')
    expect(data.name).toBe('new-dir')
  })
})

describe('apiRenameFile', () => {
  it('renames a file and returns old/new paths', async () => {
    const data = await apiRenameFile(config, 'test-inst', '/old.txt', '/new.txt')
    expect(data.oldPath).toBe('/old.txt')
    expect(data.newPath).toBe('/new.txt')
    expect(data.name).toBe('new.txt')
  })
})
