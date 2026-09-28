/**
 * players API 函数行为级测试（issue 495：api 层三文件覆盖率洼地收口）
 * msw 局部拦截真链路：路径/请求体契约断言 + 解包契约；
 * 错误传播：非 2xx 错误信封 → ApiError / 200 error 信封 → ApiError
 * 数据均为虚构测试值，不含真实服务器/玩家信息
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import {
  apiAddWhitelist,
  apiBanPlayer,
  apiDeopPlayer,
  apiKickPlayer,
  apiOpPlayer,
  apiPardonBan,
  apiPardonPlayer,
  apiRemoveWhitelist,
  apiSendCommand,
} from '../players'
import { type ConnectionConfig } from '../client'

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

function err(code: number, message: string, httpStatus: number) {
  return HttpResponse.json(
    { status: 'error', code, message, details: null, timestamp: '' },
    { status: httpStatus },
  )
}

let lastBody: unknown

const server = setupServer(
  http.post('*/api/v1/instances/inst1/players/Steve/op', () => ok(null)),
  http.delete('*/api/v1/instances/inst1/players/Steve/op', () => ok(null)),
  http.post('*/api/v1/instances/inst1/players/Steve/kick', async ({ request }) => {
    lastBody = await request.json()
    return ok(null)
  }),
  http.post('*/api/v1/instances/inst1/players/Steve/ban', async ({ request }) => {
    lastBody = await request.json()
    return ok({ expiresAt: 1735689600000 })
  }),
  http.post('*/api/v1/instances/inst1/players/Steve/pardon', () => ok(null)),
  http.post('*/api/v1/instances/inst1/players/bans/1.2.3.4/pardon', async ({ request }) => {
    lastBody = await request.json()
    return ok(null)
  }),
  http.post('*/api/v1/instances/inst1/players/Alex/whitelist/add', () => ok(null)),
  http.delete('*/api/v1/instances/inst1/players/Alex/whitelist', () => ok(null)),
  http.post('*/api/v1/instances/inst1/command', async ({ request }) => {
    lastBody = await request.json()
    return ok(null)
  }),
  // 错误传播专用玩家（正常用例不可见，仅错误用例命中）
  http.post('*/api/v1/instances/inst-err/players/Ghost/op', () =>
    err(40402, 'instance not found', 404),
  ),
  // 200 error 信封（信封级错误不受 HTTP 200 误导）
  http.post('*/api/v1/instances/inst1/players/Offline/pardon', () =>
    HttpResponse.json(
      { status: 'error', code: 50001, message: 'rcon offline', details: null, timestamp: '' },
      { status: 200 },
    ),
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

const config: ConnectionConfig = { baseUrl: 'http://localhost:25566', apiKey: 'test-key' }

describe('players API · 操作端点契约', () => {
  it('OP 授予：POST /players/:name/op，data=null 解包', async () => {
    const res = await apiOpPlayer(config, 'inst1', 'Steve')
    expect(res).toBeNull()
  })

  it('OP 撤销：DELETE /players/:name/op', async () => {
    const res = await apiDeopPlayer(config, 'inst1', 'Steve')
    expect(res).toBeNull()
  })

  it('踢出：reason 透传请求体（服务端负责消毒，客户端原样发送）', async () => {
    const res = await apiKickPlayer(config, 'inst1', 'Steve', '违规建造')
    expect(res).toBeNull()
    expect(lastBody).toEqual({ reason: '违规建造' })
  })

  it('踢出无理由：reason 为 undefined 时请求体仍为 { reason: undefined }（JSON 序列化后缺省）', async () => {
    await apiKickPlayer(config, 'inst1', 'Steve')
    expect(lastBody).toEqual({})
  })

  it('封禁：body 透传 + expiresAt 解包（缺省=永久 null）', async () => {
    const body = { reason: 'griefing', duration: '1h', ip: '1.2.3.4' }
    const res = await apiBanPlayer(config, 'inst1', 'Steve', body)
    expect(res).toEqual({ expiresAt: 1735689600000 })
    expect(lastBody).toEqual(body)
  })

  it('按玩家名解封：POST /players/:name/pardon', async () => {
    const res = await apiPardonPlayer(config, 'inst1', 'Steve')
    expect(res).toBeNull()
  })

  it('按目标+类型解封：targetType 透传请求体', async () => {
    const res = await apiPardonBan(config, 'inst1', '1.2.3.4', 'ip')
    expect(res).toBeNull()
    expect(lastBody).toEqual({ targetType: 'ip' })
  })

  it('白名单加入/移除：POST add 与 DELETE 双端点', async () => {
    expect(await apiAddWhitelist(config, 'inst1', 'Alex')).toBeNull()
    expect(await apiRemoveWhitelist(config, 'inst1', 'Alex')).toBeNull()
  })

  it('通用命令：command 透传 /command 端点（给予/传送/gamemode 落点）', async () => {
    const res = await apiSendCommand(config, 'inst1', 'give Steve diamond 64')
    expect(res).toBeNull()
    expect(lastBody).toEqual({ command: 'give Steve diamond 64' })
  })
})

describe('players API · 错误传播', () => {
  it('非 2xx 错误信封：ApiError 携带错误码与 HTTP 状态传播', async () => {
    await expect(apiOpPlayer(config, 'inst-err', 'Ghost')).rejects.toMatchObject({
      name: 'ApiError',
      code: 40402,
      httpStatus: 404,
    })
  })

  it('200 error 信封：ApiError 传播（信封级错误不受 HTTP 200 误导）', async () => {
    await expect(apiPardonPlayer(config, 'inst1', 'Offline')).rejects.toMatchObject({
      name: 'ApiError',
      code: 50001,
      message: 'rcon offline',
    })
  })
})
