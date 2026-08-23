import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { errorHandler, notFoundHandler } from '../middleware/error_handler.js';
import { AppError, ErrorCodes } from '../utils/response.js';

describe('errorHandler 500 分支', () => {
  let req, res, next;

  beforeEach(() => {
    req = { path: '/test', method: 'GET' };
    res = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };
    next = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return generic message without leaking err.message', () => {
    const err = new Error('spawn java ENOENT at /home/admin/server/boot.sh');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        message: 'Internal Server Error'
      })
    );
    // 敏感路径不得出现在响应体
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain('/home/admin');
    expect(JSON.stringify(body)).not.toContain('spawn java');
  });

  it('should return generic message even in development environment', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const err = new Error('/opt/mc-commander/secrets.key not found');

    try {
      errorHandler(err, req, res, next);
      const body = res.json.mock.calls[0][0];
      expect(body.message).toBe('Internal Server Error');
      expect(JSON.stringify(body)).not.toContain('/opt/mc-commander');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('should carry err.message in X-Debug-Error header in development env', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const err = new Error('failed to spawn: /srv/mc/boot.sh');

    try {
      errorHandler(err, req, res, next);

      expect(res.set).toHaveBeenCalledWith('X-Debug-Error', 'failed to spawn: /srv/mc/boot.sh');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('should sanitize newlines in X-Debug-Error header to prevent header injection', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const err = new Error('boom\r\nSet-Cookie: evil=1\r\nX-Evil: yes');

    try {
      errorHandler(err, req, res, next);

      expect(res.set).toHaveBeenCalledWith('X-Debug-Error', 'boom Set-Cookie: evil=1 X-Evil: yes');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('should not set X-Debug-Error header outside development (no leak in production)', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const err = new Error('spawn /opt/mc-commander/boot.sh ENOENT');

    try {
      errorHandler(err, req, res, next);

      expect(res.set).not.toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.message).toBe('Internal Server Error');
      expect(JSON.stringify(body)).not.toContain('/opt/mc-commander');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('should not crash on non-string err.message', () => {
    const err = { message: 42, stack: 'x' };

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Internal Server Error' })
    );
  });

  it('should preserve AppError structured response', () => {
    const appErr = new AppError(ErrorCodes.INSTANCE_NOT_FOUND, 'Instance s1 not found');

    errorHandler(appErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: ErrorCodes.INSTANCE_NOT_FOUND.code,
        message: 'Instance s1 not found'
      })
    );
  });

  it('should preserve Invalid JSON (400) handling', () => {
    const parseErr = new SyntaxError('Unexpected token');
    parseErr.type = 'entity.parse.failed';

    errorHandler(parseErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Invalid JSON' })
    );
  });
});

describe('notFoundHandler', () => {
  it('should return 404 with route info', () => {
    const req = { method: 'GET', path: '/nope' };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };

    notFoundHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        message: 'Route GET /nope not found'
      })
    );
  });
});
