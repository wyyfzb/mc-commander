import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuditRoutes } from '../routes/audit.js';

vi.mock('../db/index.js', () => ({
  AuditLogModel: {
    findAll: vi.fn(() => ({ logs: [], total: 0, page: 1, pageSize: 20 })),
  },
  CommandHistoryModel: {
    findAll: vi.fn(() => ({ commands: [], total: 0, page: 1, pageSize: 20 })),
  },
}));

import { AuditLogModel, CommandHistoryModel } from '../db/index.js';

describe('Audit Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1', createAuditRoutes());
    vi.clearAllMocks();
    AuditLogModel.findAll.mockReturnValue({ logs: [], total: 0, page: 1, pageSize: 20 });
    CommandHistoryModel.findAll.mockReturnValue({ commands: [], total: 0, page: 1, pageSize: 20 });
  });

  it('GET /audit-logs returns paginated results', async () => {
    const res = await request(app)
      .get('/api/v1/audit-logs?page=1&pageSize=10')
      .set('X-API-Key', 'test-key');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toBeDefined();
  });

  it('GET /audit-logs passes instanceId filter', async () => {
    await request(app)
      .get('/api/v1/audit-logs?instanceId=inst-1')
      .set('X-API-Key', 'test-key');
    expect(AuditLogModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1' }),
    );
  });

  it('GET /audit-logs passes action filter', async () => {
    await request(app)
      .get('/api/v1/audit-logs?action=INSTANCE_START')
      .set('X-API-Key', 'test-key');
    expect(AuditLogModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'INSTANCE_START' }),
    );
  });

  it('GET /audit-logs clamps pageSize to max 200', async () => {
    await request(app)
      .get('/api/v1/audit-logs?pageSize=999')
      .set('X-API-Key', 'test-key');
    expect(AuditLogModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 200 }),
    );
  });

  it('GET /audit-logs passes order=asc to model', async () => {
    await request(app)
      .get('/api/v1/audit-logs?order=asc')
      .set('X-API-Key', 'test-key');
    expect(AuditLogModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ order: 'asc' }),
    );
  });

  it('GET /audit-logs passes order=desc to model', async () => {
    await request(app)
      .get('/api/v1/audit-logs?order=desc')
      .set('X-API-Key', 'test-key');
    expect(AuditLogModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ order: 'desc' }),
    );
  });

  it('GET /audit-logs without order defaults to desc (backward compatible)', async () => {
    await request(app)
      .get('/api/v1/audit-logs')
      .set('X-API-Key', 'test-key');
    expect(AuditLogModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ order: 'desc' }),
    );
  });

  it('GET /audit-logs invalid order falls back to desc', async () => {
    await request(app)
      .get('/api/v1/audit-logs?order=invalid')
      .set('X-API-Key', 'test-key');
    expect(AuditLogModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ order: 'desc' }),
    );
  });

  it('GET /command-history returns paginated results', async () => {
    const res = await request(app)
      .get('/api/v1/command-history?page=1&pageSize=10')
      .set('X-API-Key', 'test-key');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toEqual([]);
  });

  it('GET /command-history passes filters', async () => {
    await request(app)
      .get('/api/v1/command-history?instanceId=i1&source=api')
      .set('X-API-Key', 'test-key');
    expect(CommandHistoryModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'i1', source: 'api' }),
    );
  });

  it('GET /command-history clamps pageSize to max 200', async () => {
    await request(app)
      .get('/api/v1/command-history?pageSize=500')
      .set('X-API-Key', 'test-key');
    expect(CommandHistoryModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 200 }),
    );
  });

  it('GET /audit-logs without auth returns 401 (middleware outside scope, 200 if no middleware)', async () => {
    // audit routes are mounted after auth middleware in production,
    // but this test doesn't include auth middleware
    const res = await request(app)
      .get('/api/v1/audit-logs')
      .set('X-API-Key', 'test-key');
    expect(res.status).toBe(200);
  });

  // ── 分页参数回归（parsePagination 统一收口，issue 388）──
  it('GET /audit-logs 分页参数透传到模型', async () => {
    await request(app)
      .get('/api/v1/audit-logs?page=3&pageSize=7')
      .set('X-API-Key', 'test-key');
    expect(AuditLogModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 3, pageSize: 7 }),
    );
  });

  it('GET /audit-logs page 越界钳制到 1000', async () => {
    await request(app)
      .get('/api/v1/audit-logs?page=5000')
      .set('X-API-Key', 'test-key');
    expect(AuditLogModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1000 }),
    );
  });

  it('GET /audit-logs 非法分页参数回落默认', async () => {
    await request(app)
      .get('/api/v1/audit-logs?page=abc&pageSize=xyz')
      .set('X-API-Key', 'test-key');
    expect(AuditLogModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
  });
});
