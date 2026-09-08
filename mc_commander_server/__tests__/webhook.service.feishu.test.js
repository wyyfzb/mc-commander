/**
 * WebhookService 渠道预设格式测试（飞书 + 国内平台）
 * 验收：
 * - 飞书：消息体结构（msg_type/content）、官方签名协议
 *   （key=`${timestamp}\n${secret}`、data 空串、base64 输出、body 内 timestamp/sign 字段）
 * - 钉钉：加签 URL（毫秒 timestamp + sign 查询参数，可按官方算法复算）、msgtype/text 消息体
 * - 企微：msgtype/text 无签名
 * - Server酱/PushPlus：title+desp / token+title+content 结构
 * - platform 分发：webhooks.platform 显式字段驱动（迁移 v11 已按 URL 推断存量行，
 *   generic=纯用户显式选择，不做 URL 二次推断）；testDelivery 与真实投递同路径
 * 背景：通用 X-MC-Signature（GitHub 风格）发飞书被签名校验拒收（code 19021），
 * 投递 HTTP 200 但消息不出群——适配后须可复算出与平台侧一致的签名。
 * 测试凭据一律虚构（test-secret/dummy-token 等），禁止写入可用凭据字面量。
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { WebhookService } from '../services/webhook.service.js';

describe('WebhookService._resolvePlatform', () => {
  it('显式平台字段原样返回', () => {
    expect(WebhookService._resolvePlatform({ platform: 'dingtalk', url: 'https://example.com/hook' })).toBe('dingtalk');
    expect(WebhookService._resolvePlatform({ platform: 'feishu', url: 'https://example.com/hook' })).toBe('feishu');
  });

  it('generic 或缺失 → generic（显式选通用即通用格式，不做 URL 二次推断）', () => {
    expect(WebhookService._resolvePlatform({ platform: 'generic', url: 'https://example.com/hook' })).toBe('generic');
    expect(WebhookService._resolvePlatform({ url: 'https://example.com/hook' })).toBe('generic');
  });
});

describe('WebhookService._buildPlatformRequest 各平台格式', () => {
  const feishuWebhook = { platform: 'feishu', name: '飞书', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx' };

  it('generic 返回 null（维持通用 payload + X-MC-Signature 路径）', () => {
    expect(
      WebhookService._buildPlatformRequest(
        { platform: 'generic', url: 'https://example.com/hook' },
        'instance.stop',
        { instanceId: 'i1' },
      ),
    ).toBeNull();
  });

  it('ping 事件（测试投递）有专属文案', () => {
    const req = WebhookService._buildPlatformRequest(feishuWebhook, 'ping', { instanceId: null });
    expect(req.body.content.text).toContain('测试投递');
  });

  it('飞书无 secret：仅消息结构，不带 timestamp/sign', () => {
    const req = WebhookService._buildPlatformRequest(feishuWebhook, 'instance.stop', { instanceId: 'i1' });
    expect(req.body.msg_type).toBe('text');
    expect(req.body.content.text).toContain('服务器已停止');
    expect(req.body.content.text).toContain('【MC_Commander】');
    expect(req.body.timestamp).toBeUndefined();
    expect(req.body.sign).toBeUndefined();
  });

  it('飞书有 secret：body 携带秒级 timestamp 与 base64 签名，且可按官方算法复算一致', () => {
    const webhook = { ...feishuWebhook, secret: 'test-secret-abcdef' };
    const before = Math.floor(Date.now() / 1000);
    const req = WebhookService._buildPlatformRequest(webhook, 'instance.stop', { instanceId: 'i1' });
    const after = Math.floor(Date.now() / 1000);

    expect(req.body.timestamp).toMatch(/^\d{10}$/);
    expect(Number(req.body.timestamp)).toBeGreaterThanOrEqual(before);
    expect(Number(req.body.timestamp)).toBeLessThanOrEqual(after);

    const expected = crypto
      .createHmac('sha256', `${req.body.timestamp}\n${webhook.secret}`)
      .update('')
      .digest('base64');
    expect(req.body.sign).toBe(expected);
  });

  it('实例名经 serverManager 解析进文案（查不到时回退 id）', () => {
    const prev = WebhookService._serverManager;
    WebhookService._serverManager = {
      getInstance: (id) => (id === 'i1' ? { name: '我的测试' } : undefined),
    };
    try {
      const req = WebhookService._buildPlatformRequest(feishuWebhook, 'instance.stop', { instanceId: 'i1' });
      expect(req.body.content.text).toContain('我的测试');
      const fallback = WebhookService._buildPlatformRequest(feishuWebhook, 'instance.stop', { instanceId: 'i9' });
      expect(fallback.body.content.text).toContain('i9');
    } finally {
      WebhookService._serverManager = prev;
    }
  });

  it('钉钉：毫秒 timestamp + sign 拼接 URL 查询参数，签名可按官方算法复算', () => {
    const webhook = {
      platform: 'dingtalk',
      name: '钉钉',
      url: 'https://oapi.dingtalk.com/robot/send?access_token=dummy-token',
      secret: 'SECdummy-secret',
    };
    const req = WebhookService._buildPlatformRequest(webhook, 'instance.start', { instanceId: 'i1' });

    expect(req.body.msg_type).toBeUndefined();
    expect(req.body.msgtype).toBe('text');
    expect(req.body.text.content).toContain('服务器已启动');

    const parsed = new URL(req.url);
    const timestamp = parsed.searchParams.get('timestamp');
    expect(timestamp).toMatch(/^\d{13}$/); // 毫秒级
    const expected = encodeURIComponent(
      crypto.createHmac('sha256', webhook.secret).update(`${timestamp}\n${webhook.secret}`).digest('base64'),
    );
    expect(parsed.searchParams.get('sign')).toBe(decodeURIComponent(expected));
  });

  it('钉钉无 secret：URL 原样（不加签）', () => {
    const req = WebhookService._buildPlatformRequest(
      { platform: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=dummy-token' },
      'instance.stop',
      { instanceId: 'i1' },
    );
    expect(req.url).toBe('https://oapi.dingtalk.com/robot/send?access_token=dummy-token');
    expect(req.body.msgtype).toBe('text');
  });

  it('企业微信：msgtype/text 消息体，URL 原样，无签名字段', () => {
    const req = WebhookService._buildPlatformRequest(
      { platform: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=dummy-key' },
      'instance.stop',
      { instanceId: 'i1' },
    );
    expect(req.url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=dummy-key');
    expect(req.body).toEqual({ msgtype: 'text', text: { content: expect.stringContaining('服务器已停止') } });
    expect(req.body.timestamp).toBeUndefined();
  });

  it('Server酱：title+desp 结构（title 不含换行）', () => {
    const req = WebhookService._buildPlatformRequest(
      { platform: 'serverchan', url: 'https://sctapi.ftqq.com/SCTdummykey.send' },
      'instance.stop',
      { instanceId: 'i1' },
    );
    expect(req.body.title).toContain('服务器已停止');
    expect(req.body.title).not.toContain('\n');
    expect(req.body.desp).toContain('【MC_Commander】');
    expect(req.body.token).toBeUndefined();
  });

  it('PushPlus：token 取自 secret 字段进 body，txt 模板', () => {
    const req = WebhookService._buildPlatformRequest(
      { platform: 'pushplus', url: 'https://www.pushplus.plus/send', secret: 'dummy-pushplus-token' },
      'instance.stop',
      { instanceId: 'i1' },
    );
    expect(req.body.token).toBe('dummy-pushplus-token');
    expect(req.body.title).toContain('服务器已停止');
    expect(req.body.content).toContain('【MC_Commander】');
    expect(req.body.template).toBe('txt');
  });

  it('PushPlus 缺 secret：token 为空串（前端已拦截必填，此处兜底不抛错）', () => {
    const req = WebhookService._buildPlatformRequest(
      { platform: 'pushplus', url: 'https://www.pushplus.plus/send' },
      'instance.stop',
      { instanceId: 'i1' },
    );
    expect(req.body.token).toBe('');
  });

  it('玩家事件文案带玩家名（平台无关）', () => {
    expect(WebhookService._feishuText('player.join', { name: 'Steve' })).toContain('Steve 加入了游戏');
    expect(WebhookService._feishuText('player.achievement', { name: 'Steve', advancement: '获取升级' })).toContain('Steve 获得成就 [获取升级]');
  });

  it('未知事件兜底原始类型（ping 已是已知事件，用真正未注册的类型验证兜底）', () => {
    expect(WebhookService._feishuText('custom.event', {})).toContain('custom.event');
  });
});
