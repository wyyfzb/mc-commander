import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { apiCreateDirectory, apiRenameFile, apiUploadFile } from '../files'
import type { ConnectionConfig } from '../client'

const config: ConnectionConfig = { baseUrl: '', apiKey: 'test-key' }

const server = setupServer(
  http.post('*/api/v1/instances/test-inst/files/mkdir', async ({ request }) => {
    const body = (await request.json()) as { path?: string }
    if (!body.path)
      return HttpResponse.json(
        { status: 'error', code: 40000, message: 'Validation Error', details: null, timestamp: '' },
        { status: 400 },
      )
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'Directory created successfully',
      data: { path: body.path, name: body.path!.split('/').pop() },
      timestamp: new Date().toISOString(),
    })
  }),
  http.post('*/api/v1/instances/test-inst/files/rename', async ({ request }) => {
    const body = (await request.json()) as { path?: string; newPath?: string }
    if (!body.path || !body.newPath)
      return HttpResponse.json(
        { status: 'error', code: 40000, message: 'Validation Error', details: null, timestamp: '' },
        { status: 400 },
      )
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'Renamed successfully',
      data: { oldPath: body.path, newPath: body.newPath, name: body.newPath!.split('/').pop() },
      timestamp: new Date().toISOString(),
    })
  }),
  http.post('*/api/v1/instances/test-inst/files/upload', async ({ request }) => {
    const ct = request.headers.get('content-type') ?? ''
    if (!ct.includes('multipart/form-data')) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 40000,
          message: 'Expected multipart',
          details: null,
          timestamp: '',
        },
        { status: 400 },
      )
    }
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'File uploaded successfully',
      data: {
        path: '/server.properties',
        name: 'server.properties',
        size: 1024,
        modifiedAt: '2026-08-28T12:00:00Z',
        isDirectory: false,
      },
      timestamp: new Date().toISOString(),
    })
  }),
  http.post('*/api/v1/instances/test-inst-bad/files/upload', () => {
    return HttpResponse.json(
      {
        status: 'error',
        code: 40006,
        message: 'File type .jar is not allowed',
        details: null,
        timestamp: '',
      },
      { status: 400 },
    )
  }),
)

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
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

describe('apiUploadFile', () => {
  it('uploads a file and returns metadata', async () => {
    const file = new File(['x'.repeat(1024)], 'server.properties', { type: 'text/plain' })
    const data = await apiUploadFile(config, 'test-inst', file)
    expect(data.name).toBe('server.properties')
    expect(data.path).toBe('/server.properties')
    expect(data.size).toBe(1024)
    expect(data.isDirectory).toBe(false)
  })

  it('throws error for blocked file type from server', async () => {
    const file = new File(['malicious'], 'plugin.jar', { type: 'application/java-archive' })
    await expect(apiUploadFile({ ...config, baseUrl: '' }, 'test-inst-bad', file)).rejects.toThrow(
      'File type .jar is not allowed',
    )
  })
})
