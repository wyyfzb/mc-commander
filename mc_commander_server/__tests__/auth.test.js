import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authMiddleware, authenticateWebSocket } from '../middleware/auth.js';
import config from '../config.js';

describe('authMiddleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = { query: {}, headers: {} };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };
    next = vi.fn();
  });

  it('should allow request with valid apikey in header', () => {
    req.headers['x-api-key'] = config.apiKey;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should reject request without apikey', () => {
    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' })
    );
  });

  it('should reject request with invalid apikey in header', () => {
    req.headers['x-api-key'] = 'wrong-key';

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should no longer accept apikey via query parameter', () => {
    req.query.apikey = config.apiKey;

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // find-001 回归测试：Upgrade: websocket 头不再是认证旁路。
  // 真实 WS 升级请求走 Node http server 的 upgrade 事件（不经过此中间件），
  // 攻击者仅需给普通 HTTP 请求伪造该头即可免 Key 访问 API——必须拒绝。
  it('should reject request with Upgrade: websocket header and no api key (find-001 regression)', () => {
    req.headers.upgrade = 'websocket';

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' })
    );
  });

  it('should reject request with Upgrade: websocket header and invalid api key (find-001 regression)', () => {
    req.headers.upgrade = 'websocket';
    req.headers['x-api-key'] = 'wrong-key';

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('authenticateWebSocket', () => {
  it('should return true for valid apikey', () => {
    expect(authenticateWebSocket(config.apiKey)).toBe(true);
  });

  it('should return false for invalid apikey', () => {
    expect(authenticateWebSocket('wrong')).toBe(false);
  });

  it('should return false for empty apikey', () => {
    expect(authenticateWebSocket('')).toBe(false);
  });
});
