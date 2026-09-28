/**
 * mc-backup 单测：formatBackupSize / formatBackupDate / backupStatusLabel / backupStatusTone
 */
import { describe, expect, it } from 'vitest'
import {
  backupStatusLabel,
  backupStatusTone,
  formatBackupDate,
  formatBackupSize,
} from '../mc-backup'

describe('formatBackupSize', () => {
  it('null/0/负数 → 空串', () => {
    expect(formatBackupSize(null)).toBe('')
    expect(formatBackupSize(undefined)).toBe('')
    expect(formatBackupSize(0)).toBe('')
    expect(formatBackupSize(-5)).toBe('')
  })

  it('B 档（<1024）', () => {
    expect(formatBackupSize(1)).toBe('1 B')
    expect(formatBackupSize(1023)).toBe('1023 B')
  })

  it('KB 档（<1MB，1 位小数）', () => {
    expect(formatBackupSize(1024)).toBe('1.0 KB')
    expect(formatBackupSize(1536)).toBe('1.5 KB')
    expect(formatBackupSize(1024 * 1024 - 1)).toBe('1024.0 KB')
  })

  it('MB 档（<1GB，1 位小数）', () => {
    expect(formatBackupSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatBackupSize(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })

  it('GB 档（≥1GB，2 位小数）', () => {
    expect(formatBackupSize(1024 * 1024 * 1024)).toBe('1.00 GB')
    expect(formatBackupSize(1.5 * 1024 * 1024 * 1024)).toBe('1.50 GB')
  })
})

describe('formatBackupDate', () => {
  it('null/空 → 空串', () => {
    expect(formatBackupDate(null)).toBe('')
    expect(formatBackupDate(undefined)).toBe('')
    expect(formatBackupDate('')).toBe('')
  })

  it('ISO → YYYY-MM-DD HH:mm 本地时区', () => {
    // 用本地时区构造期望值，避免测试机时区差异
    const t = new Date('2026-08-15T14:30:00')
    const pad = (n: number) => String(n).padStart(2, '0')
    const expected = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
    expect(formatBackupDate('2026-08-15T14:30:00')).toBe(expected)
  })

  it('解析失败原样返回', () => {
    expect(formatBackupDate('not-a-date')).toBe('not-a-date')
  })
})

describe('backupStatusLabel', () => {
  it('completed → 已就绪（表达快照可用于恢复/浏览）', () => {
    expect(backupStatusLabel('completed')).toBe('已就绪')
  })

  it('failed/creating/restoring 逐字', () => {
    expect(backupStatusLabel('failed')).toBe('失败')
    expect(backupStatusLabel('creating')).toBe('备份中')
    expect(backupStatusLabel('restoring')).toBe('恢复中')
  })

  it('未知状态原样返回，null → 空串', () => {
    expect(backupStatusLabel('weird')).toBe('weird')
    expect(backupStatusLabel(null)).toBe('')
  })
})

describe('backupStatusTone', () => {
  it('completed success / failed error / restoring warning / 其余 info', () => {
    expect(backupStatusTone('completed')).toBe('success')
    expect(backupStatusTone('failed')).toBe('error')
    expect(backupStatusTone('restoring')).toBe('warning')
    expect(backupStatusTone('creating')).toBe('info')
    expect(backupStatusTone('unknown')).toBe('info')
    expect(backupStatusTone(null)).toBe('info')
  })
})
