import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fakeDb, sqlLog, paramLog } = vi.hoisted(() => {
  const sqlLog = [];
  const paramLog = [];
  let autoId = 1;
  const fakeDb = {
    prepare: vi.fn((sql) => {
      sqlLog.push(sql);
      return {
        all: () => [],
        get: () => ({ count: 0 }),
        run: (...params) => {
          paramLog.push(params);
          const id = autoId++;
          return { lastInsertRowid: id, changes: 1 };
        },
      };
    }),
  };
  return { fakeDb, sqlLog, paramLog };
});
vi.mock('../db/database.js', () => ({ getDb: () => fakeDb }));

import { AuditLogModel, CommandHistoryModel } from '../db/audit.model.js';

describe('AuditLogModel', () => {
  beforeEach(() => {
    sqlLog.length = 0;
    paramLog.length = 0;
  });

  it('create inserts with correct fields', () => {
    AuditLogModel.create({
      instanceId: 'inst-1',
      action: 'INSTANCE_START',
      targetType: 'instance',
      targetId: 'inst-1',
      detail: { foo: 'bar' },
      source: 'api',
    });

    // create calls INSERT then findById (SELECT)
    const insertSql = sqlLog.find(s => s.includes('INSERT INTO audit_logs'));
    expect(insertSql).toContain('INSERT INTO audit_logs');
    const insertIdx = sqlLog.indexOf(insertSql);
    const p = paramLog[insertIdx];
    expect(p[0]).toBe('inst-1');
    expect(p[1]).toBe('INSTANCE_START');
    expect(p[4]).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('create JSON-stringifies detail', () => {
    AuditLogModel.create({ instanceId: 'i1', action: 'TEST', detail: { nested: true } });
    const insertSql = sqlLog.find(s => s.includes('INSERT INTO audit_logs'));
    const insertIdx = sqlLog.indexOf(insertSql);
    const p = paramLog[insertIdx];
    expect(p[4]).toBe('{"nested":true}');
  });

  it('findAll with instanceId filter', () => {
    AuditLogModel.findAll({ instanceId: 'inst-1' });
    const sql = sqlLog[sqlLog.length - 1];
    expect(sql).toContain('WHERE instance_id = ?');
  });

  it('findAll with action filter', () => {
    AuditLogModel.findAll({ action: 'INSTANCE_START' });
    const sql = sqlLog[sqlLog.length - 1];
    expect(sql).toContain('action = ?');
  });

  it('findAll with time range filters', () => {
    AuditLogModel.findAll({ startTime: '2025-01-01', endTime: '2025-12-31' });
    const sql = sqlLog[sqlLog.length - 1];
    expect(sql).toContain('created_at >= ?');
    expect(sql).toContain('created_at <= ?');
  });

  it('findAll with pagination', () => {
    AuditLogModel.findAll({ page: 3, pageSize: 10 });
    // findAll runs SELECT then COUNT; verify the SELECT has LIMIT/OFFSET
    const selectSql = sqlLog.find(s => s.includes('LIMIT ? OFFSET ?'));
    expect(selectSql).toContain('LIMIT ? OFFSET ?');
  });

  it('findAll default order is DESC (backward compatible)', () => {
    AuditLogModel.findAll({});
    const selectSql = sqlLog.find(s => s.includes('LIMIT ? OFFSET ?'));
    expect(selectSql).toContain('ORDER BY id DESC');
  });

  it('findAll order=asc sorts ascending', () => {
    AuditLogModel.findAll({ order: 'asc' });
    const selectSql = sqlLog.find(s => s.includes('LIMIT ? OFFSET ?'));
    expect(selectSql).toContain('ORDER BY id ASC');
  });

  it('findAll order=desc sorts descending', () => {
    AuditLogModel.findAll({ order: 'desc' });
    const selectSql = sqlLog.find(s => s.includes('LIMIT ? OFFSET ?'));
    expect(selectSql).toContain('ORDER BY id DESC');
  });

  it('findAll invalid order falls back to DESC', () => {
    AuditLogModel.findAll({ order: 'DROP TABLE' });
    const selectSql = sqlLog.find(s => s.includes('LIMIT ? OFFSET ?'));
    expect(selectSql).toContain('ORDER BY id DESC');
    expect(selectSql).not.toContain('DROP');
  });

  it('_toCamel parses JSON detail', () => {
    const result = AuditLogModel._toCamel({
      id: 1, instance_id: 'i1', action: 'TEST',
      target_type: 'player', target_id: 'Steve',
      detail: '{"reason":"kick"}',
      source: 'api', created_at: '2025-01-01T00:00:00Z',
    });
    expect(result.detail).toEqual({ reason: 'kick' });
    expect(result.instanceId).toBe('i1');
  });

  it('_toCamel handles null detail', () => {
    const result = AuditLogModel._toCamel({
      id: 1, instance_id: 'i1', action: 'TEST',
      target_type: null, target_id: null, detail: null,
      source: 'api', created_at: '2025-01-01T00:00:00Z',
    });
    expect(result.detail).toBeNull();
  });

  it('_toCamel handles invalid JSON detail gracefully', () => {
    const result = AuditLogModel._toCamel({
      id: 1, instance_id: 'i1', action: 'TEST',
      target_type: null, target_id: null, detail: 'not-json',
      source: 'api', created_at: '2025-01-01T00:00:00Z',
    });
    expect(result.detail).toBe('not-json');
  });

  it('prune deletes records older than cutoff', () => {
    AuditLogModel.prune(30);
    const sql = sqlLog[sqlLog.length - 1];
    expect(sql).toContain('DELETE FROM audit_logs WHERE created_at < ?');
  });
});

describe('CommandHistoryModel', () => {
  beforeEach(() => {
    sqlLog.length = 0;
    paramLog.length = 0;
  });

  it('create inserts with correct fields', () => {
    CommandHistoryModel.create({
      instanceId: 'i1', command: 'say hello', source: 'api',
      success: true, response: 'OK', durationMs: 42,
    });
    const p = paramLog[paramLog.length - 1];
    expect(p[0]).toBe('i1');
    expect(p[1]).toBe('say hello');
    expect(p[3]).toBe(1); // success = true → 1
    expect(p[5]).toBe(42);
  });

  it('create maps success false to 0', () => {
    CommandHistoryModel.create({
      instanceId: 'i1', command: 'invalid', success: false, response: 'error', durationMs: 10,
    });
    const p = paramLog[paramLog.length - 1];
    expect(p[3]).toBe(0);
  });

  it('_toCamel maps success integer to boolean', () => {
    const result = CommandHistoryModel._toCamel({
      id: 1, instance_id: 'i1', command: 'test',
      source: 'api', success: 1, response: 'ok',
      duration_ms: 50, created_at: '2025-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
    expect(result.durationMs).toBe(50);
    expect(result.instanceId).toBe('i1');
  });

  it('findAll with instanceId filter', () => {
    CommandHistoryModel.findAll({ instanceId: 'i1' });
    const sql = sqlLog[sqlLog.length - 1];
    expect(sql).toContain('WHERE instance_id = ?');
  });

  it('prune deletes old records', () => {
    CommandHistoryModel.prune(60);
    const sql = sqlLog[sqlLog.length - 1];
    expect(sql).toContain('DELETE FROM command_history WHERE created_at < ?');
  });
});
