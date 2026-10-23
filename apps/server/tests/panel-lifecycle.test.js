import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 目录由本用例逐个创建；config 在导入时求值，故用 globalThis 让 mock 读到当次临时目录
vi.mock('../src/config.js', () => ({
  default: {
    get serversDir() {
      return path.join(globalThis.__testRoot ?? '/tmp/none', 'servers');
    },
    get dataDir() {
      return path.join(globalThis.__testRoot ?? '/tmp/none', 'data');
    },
    get backupsDir() {
      return path.join(globalThis.__testRoot ?? '/tmp/none', 'backups');
    },
  },
}));

const { surveyData, hasAnyData, collectExportSources } = await import(
  '../src/services/panel-lifecycle.js'
);

let root;

function write(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

describe('面板数据清点', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-life-'));
    globalThis.__testRoot = root;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete globalThis.__testRoot;
  });

  it('空目录时如实报 0 条，不虚报有数据', () => {
    const survey = surveyData();
    expect(survey).toHaveLength(3);
    for (const item of survey) expect(item.entries).toBe(0);
    // 空目录不能被说成「数据已保留」——那是假话
    expect(hasAnyData(survey)).toBe(false);
  });

  it('统计真实的文件条数与字节数（含子目录）', () => {
    write(path.join(root, 'servers', 'inst-1'), 'server.jar', 'x'.repeat(100));
    write(path.join(root, 'servers', 'inst-1', 'world'), 'level.dat', 'y'.repeat(50));
    write(path.join(root, 'backups', 'inst-1'), 'snap.tar', 'z'.repeat(30));

    const survey = surveyData();
    const servers = survey.find((s) => s.key === 'servers');
    const backups = survey.find((s) => s.key === 'backups');
    expect(servers.entries).toBe(2);
    expect(servers.bytes).toBe(150);
    expect(backups.entries).toBe(1);
    expect(backups.bytes).toBe(30);
    expect(hasAnyData(survey)).toBe(true);
  });

  it('目录不存在时不抛异常（首次安装或已清理）', () => {
    fs.rmSync(root, { recursive: true, force: true });
    expect(() => surveyData()).not.toThrow();
    expect(hasAnyData(surveyData())).toBe(false);
  });

  it('导出源只收有内容的目录', () => {
    expect(collectExportSources()).toEqual([]);

    write(path.join(root, 'servers', 'inst-1'), 'server.jar', 'x');
    const sources = collectExportSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe('servers');
  });
});
