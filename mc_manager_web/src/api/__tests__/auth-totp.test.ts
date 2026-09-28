/**
 * api/auth 第二因子契约测试：
 * - login 的 totpCode 传参（省略 / 空串 / 有效串三种形态的请求体形状）
 * - status / enroll / confirm / disable 四个端点的路径与载荷
 * mock 数据为结构占位（虚构口令与恢复码），严禁真实凭据
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { handlers } from '@/test/mocks/handlers'
import { confirmTotp, disableTotp, enrollTotp, fetchTotpStatus, login } from '../auth'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** 登录成功信封（虚构会话） */
function sessionEnvelope() {
  return {
    status: 'ok',
    code: 0,
    message: 'Success',
    data: {
      token: 'mock-session-token-0123456789abcdef',
      sessionId: 'sess-mock-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    timestamp: '',
  }
}

describe('login 的第二因子传参', () => {
  it('未传 totpCode：请求体只有 password，第二因子字段不出现', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(sessionEnvelope())
      }),
    )

    await login('', 'demo-pass-12345')

    expect(body).toEqual({ password: 'demo-pass-12345' })
    expect('totpCode' in body).toBe(false)
  })

  it('totpCode 为空白串：不发该字段（服务端据此回 40105 而不是判一次错码）', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(sessionEnvelope())
      }),
    )

    await login('', 'demo-pass-12345', '   ')

    expect(body).toEqual({ password: 'demo-pass-12345' })
  })

  it('带 6 位动态口令：请求体含去掉首尾空白的 totpCode', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(sessionEnvelope())
      }),
    )

    await login('', 'demo-pass-12345', ' 123456 ')

    expect(body).toEqual({ password: 'demo-pass-12345', totpCode: '123456' })
  })

  it('带恢复码：同一字段承载（服务端按形状分流，前端不做模式区分）', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(sessionEnvelope())
      }),
    )

    await login('', 'demo-pass-12345', 'ABCD2345EF')

    expect(body).toEqual({ password: 'demo-pass-12345', totpCode: 'ABCD2345EF' })
  })
})

describe('TOTP 端点契约', () => {
  beforeEach(() => {
    server.use(
      http.get('*/api/v1/auth/totp/status', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: {
            enabled: true,
            confirmedAt: '2026-01-02T03:04:05.000Z',
            recoveryCodesRemaining: 7,
          },
          timestamp: '',
        }),
      ),
      http.post('*/api/v1/auth/totp/enroll', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: {
            secret: 'JBSWY3DPEHPK3PXP',
            otpauthUrl: 'otpauth://totp/MCCommander:admin?secret=JBSWY3DPEHPK3PXP',
            qrDataUrl: 'data:image/png;base64,AAAA',
          },
          timestamp: '',
        }),
      ),
      http.post('*/api/v1/auth/totp/confirm', async ({ request }) => {
        const body = (await request.json()) as { code: string }
        if (body.code !== '123456') {
          return HttpResponse.json(
            {
              status: 'error',
              code: 40106,
              message: '两步验证码错误',
              details: null,
              timestamp: '',
            },
            { status: 401 },
          )
        }
        return HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: {
            enabled: true,
            confirmedAt: '2026-01-02T03:04:05.000Z',
            // 服务端字母表内的 10 位虚构码（无 I/O/0/1），首枚全数字
            recoveryCodes: ['2345678923', 'ABCDEFGHJK'],
          },
          timestamp: '',
        })
      }),
      http.post('*/api/v1/auth/totp/disable', async ({ request }) => {
        const body = (await request.json()) as { password: string; code: string }
        if (body.password !== 'demo-pass-12345') {
          return HttpResponse.json(
            { status: 'error', code: 40102, message: '密码错误', details: null, timestamp: '' },
            { status: 401 },
          )
        }
        return HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: { ok: true },
          timestamp: '',
        })
      }),
    )
  })

  it('fetchTotpStatus：解包状态字段', async () => {
    await expect(fetchTotpStatus({ baseUrl: '', apiKey: 'demo-key' })).resolves.toEqual({
      enabled: true,
      confirmedAt: '2026-01-02T03:04:05.000Z',
      recoveryCodesRemaining: 7,
    })
  })

  it('enrollTotp：返回 secret / otpauthUrl / qrDataUrl', async () => {
    const data = await enrollTotp({ baseUrl: '', apiKey: 'demo-key' })
    expect(data.secret).toBe('JBSWY3DPEHPK3PXP')
    expect(data.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(data.otpauthUrl.startsWith('otpauth://totp/')).toBe(true)
  })

  it('confirmTotp：正确码返回恢复码明文数组；错误码抛 40106', async () => {
    const data = await confirmTotp({ baseUrl: '', apiKey: 'demo-key' }, '123456')
    expect(data.recoveryCodes).toHaveLength(2)

    await expect(confirmTotp({ baseUrl: '', apiKey: 'demo-key' }, '000000')).rejects.toMatchObject({
      code: 40106,
    })
  })

  it('disableTotp：密码与第二因子同发', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post('*/api/v1/auth/totp/disable', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: { ok: true },
          timestamp: '',
        })
      }),
    )

    await disableTotp({ baseUrl: '', apiKey: 'demo-key' }, 'demo-pass-12345', 'ABCD2345EF')
    expect(body).toEqual({ password: 'demo-pass-12345', code: 'ABCD2345EF' })
  })

  it('disableTotp：密码错抛 40102（与第二因子错的 40106 可区分）', async () => {
    await expect(
      disableTotp({ baseUrl: '', apiKey: 'demo-key' }, 'wrong-pass', 'ABCD2345EF'),
    ).rejects.toMatchObject({ code: 40102 })
  })
})
