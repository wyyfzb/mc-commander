/**
 * 崩溃诊断映射（词条表 + 匹配语义）。
 *
 * 样本来源：仓库内真实产物 fixture（26.1：MSMP 密钥非法 / TLS 未配 keystore）与本机 26.3 实测的
 * 看门狗崩溃；其余条目来自 26.3 jar 的 `Description:` 静态提取（来源类见词条表注释）。
 *
 * 承重点两条：① **每条词条都要被自己的真实样本命中**——删掉或写错任一条即转红；
 * ② **泛化条目不得抢走具体条目**（两个 26.1 样本的 `Description` 都是 `Exception in server tick loop`，
 * 若泛化条目排在前面，用户就拿不到「MSMP 密钥非法」这个真正有用的结论）。
 */
import { describe, it, expect } from 'vitest';
import { CRASH_DIAGNOSIS_TABLE, diagnoseCrash } from '../services/mc-server/crash-diagnosis.js';

/** 逐条真实样本：id → 诊断输入（取自真实产物或 26.3 jar 的固定词表） */
const REAL_SAMPLES = {
  // 真机 hs_err（MC 26.3 + Corretto 25，对本机服务端进程发 SIGSEGV 产出）故障行首段
  'jvm-native-signal': {
    fault: 'SIGSEGV (0xb) at pc=0x0000716d71298e4f (sent by kill), pid=119732, tid=119732',
  },
  'msmp-invalid-secret': {
    description: 'Exception in server tick loop',
    exception:
      'java.lang.IllegalStateException: Invalid management server secret, must be 40 alphanumeric characters',
  },
  'msmp-tls-without-keystore': {
    description: 'Exception in server tick loop',
    exception:
      'java.lang.IllegalStateException: Failed to configure TLS for the server management protocol',
  },
  'watchdog-hang': {
    description: 'Watching Server',
    exception: 'java.lang.Error: Watchdog (Watching Server)',
  },
  'ticking-entity': { description: 'Ticking entity' },
  'ticking-block-entity': { description: 'Ticking block entity' },
  'ticking-player': { description: 'Ticking player' },
  'exception-generating-chunk': { description: 'Exception generating new chunk' },
  'feature-placement': { description: 'Feature placement' },
  'loading-entity-nbt': { description: 'Loading entity NBT' },
  'saving-oversized-chunk': { description: 'Saving oversized chunk' },
  'exception-ticking-world': { description: 'Exception ticking world' },
  'tick-loop-exception': { description: 'Exception in server tick loop' },
};

describe('词条表结构自洽', () => {
  it('id 唯一、字段齐备，且每条都标注了已验证 MC 版本', () => {
    const ids = CRASH_DIAGNOSIS_TABLE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CRASH_DIAGNOSIS_TABLE) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.detail.length).toBeGreaterThan(0);
      expect(entry.actions.length).toBeGreaterThan(0);
      // 未标注已验证版本的词条等于「凭印象收录」，不允许进表
      expect(entry.verifiedVersions.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
      const keys = Object.keys(entry.match);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys)
        expect(['description', 'exception', 'fault', 'logger']).toContain(key);
    }
  });

  it('每条词条都有对应的真实样本（样本表不许留空或多余）', () => {
    expect(Object.keys(REAL_SAMPLES).sort()).toEqual(CRASH_DIAGNOSIS_TABLE.map((e) => e.id).sort());
  });
});

describe('逐条命中（词条逐条变异转红）', () => {
  it.each(CRASH_DIAGNOSIS_TABLE.map((e) => [e.id, e]))('%s 由自己的真实样本命中', (id, entry) => {
    const result = diagnoseCrash(REAL_SAMPLES[id]);

    expect(result.matched).toBe(true);
    expect(result.entry.id).toBe(id);
    // matchedBy 必须是该条自己声明的键之一，且契约枚举内
    expect(Object.keys(entry.match)).toContain(result.entry.matchedBy);
    expect(entry.verifiedVersions.length).toBeGreaterThan(0);
  });
});

describe('泛化条目不得抢走具体条目', () => {
  it('两个 26.1 样本的 Description 相同，仍各自命中自己的具体条目', () => {
    expect(diagnoseCrash(REAL_SAMPLES['msmp-invalid-secret']).entry.id).toBe('msmp-invalid-secret');
    expect(diagnoseCrash(REAL_SAMPLES['msmp-tls-without-keystore']).entry.id).toBe(
      'msmp-tls-without-keystore',
    );
  });

  it('只有泛化的 Description 时才落到泛化条目', () => {
    const result = diagnoseCrash({ description: 'Exception in server tick loop' });
    expect(result.entry.id).toBe('tick-loop-exception');
  });
});

describe('未命中不猜', () => {
  it('没有任何可用键：未命中', () => {
    const result = diagnoseCrash({});
    expect(result.matched).toBe(false);
    expect(result.entry).toBeNull();
  });

  it('未知的 Description：未命中（不拿相近条目顶替）', () => {
    expect(diagnoseCrash({ description: 'Something We Have Never Seen' }).matched).toBe(false);
  });

  it('同类异常但消息不同：未命中，不做行中子串猜测', () => {
    expect(
      diagnoseCrash({ exception: 'java.lang.IllegalStateException: 别的初始化失败' }).matched,
    ).toBe(false);
    // 锚在行首：完整锚出现在**行中**（如被前缀包裹）不算命中
    expect(
      diagnoseCrash({
        exception:
          'Caused by: java.lang.IllegalStateException: Invalid management server secret, must be 40 alphanumeric characters',
      }).matched,
    ).toBe(false);
    expect(
      diagnoseCrash({
        exception:
          'at net.minecraft.server.dedicated.DedicatedServer.initServer(Invalid management server secret)',
      }).matched,
    ).toBe(false);
  });

  it('只给类名（比锚更短）不算命中：锚必须是异常行的行首前缀', () => {
    expect(diagnoseCrash({ exception: 'java.lang.IllegalStateException' }).matched).toBe(false);
  });
});

describe('版本适用性', () => {
  it('词条已验证版本与实例版本一致 → true', () => {
    const result = diagnoseCrash({ description: 'Watching Server', mcVersion: '26.3' });
    expect(result.instanceVersion).toBe('26.3');
    expect(result.verifiedForInstance).toBe(true);
  });

  it('版本不一致 → false（键命中仍是证据，只是结论适用范围要讲清楚）', () => {
    const result = diagnoseCrash({ description: 'Watching Server', mcVersion: '1.21.6' });
    expect(result.matched).toBe(true);
    expect(result.verifiedForInstance).toBe(false);
  });

  it('版本未知 → null（既不说适用也不说不适用）', () => {
    const result = diagnoseCrash({ description: 'Watching Server' });
    expect(result.instanceVersion).toBeNull();
    expect(result.verifiedForInstance).toBeNull();
  });

  it('未命中时不给版本适用性结论', () => {
    expect(diagnoseCrash({ mcVersion: '26.3' }).verifiedForInstance).toBeNull();
  });
});

describe('logger 键（供日志侧诊断接入，表可注入）', () => {
  const stub = (match) => [
    {
      id: 'stub',
      match,
      title: 't',
      detail: 'd',
      actions: ['a'],
      verifiedVersions: ['26.3'],
      evidence: ['实测'],
    },
  ];

  it('logger 全等才命中，且 matchedBy 报 logger', () => {
    const table = stub({ logger: 'net.minecraft.server.dedicated.DedicatedServer' });
    const hit = diagnoseCrash({ logger: 'net.minecraft.server.dedicated.DedicatedServer' }, table);
    expect(hit.entry.matchedBy).toBe('logger');
    expect(diagnoseCrash({ logger: 'net.minecraft.server.dedicated.Other' }, table).matched).toBe(
      false,
    );
  });

  it('多键为「与」关系：缺任一键即不命中', () => {
    const table = stub({
      logger: 'net.minecraft.server.dedicated.DedicatedServer',
      description: 'Watching Server',
    });
    expect(
      diagnoseCrash({ logger: 'net.minecraft.server.dedicated.DedicatedServer' }, table).matched,
    ).toBe(false);
    expect(
      diagnoseCrash(
        {
          logger: 'net.minecraft.server.dedicated.DedicatedServer',
          description: 'Watching Server',
        },
        table,
      ).entry.matchedBy,
    ).toBe('description'); // matchedBy 取固定键序（description→exception→logger）里第一个被声明的键
  });
});
