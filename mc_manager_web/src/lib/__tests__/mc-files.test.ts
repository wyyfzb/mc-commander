/**
 * mc-files 纯函数测试（feat-9 二进制文件判定）
 * isBinaryFileName：扩展名黑名单（归档/图片/字体/音视频/可执行/MC 特有二进制）
 * isEditableFile：目录不可编辑；二进制扩展名不可编辑；未知/无扩展名默认可编辑（保守方向：
 * 误禁文本文件只是少了便利，误放二进制进编辑器会误导用户）
 */
import { describe, it, expect } from 'vitest'
import { isBinaryFileName, isEditableFile, fileIconName } from '../mc-files'

describe('isBinaryFileName', () => {
  it('已知二进制扩展名 → true（归档/图片/字体/MC 存档等）', () => {
    // 归档与压缩
    expect(isBinaryFileName('server.jar')).toBe(true)
    expect(isBinaryFileName('backup.zip')).toBe(true)
    expect(isBinaryFileName('dump.tar.gz')).toBe(true)
    // 图片
    expect(isBinaryFileName('icon.png')).toBe(true)
    expect(isBinaryFileName('photo.JPG')).toBe(true)
    // 字体 / 音视频
    expect(isBinaryFileName('font.woff2')).toBe(true)
    expect(isBinaryFileName('sound.ogg')).toBe(true)
    // 可执行 / 库
    expect(isBinaryFileName('native.so')).toBe(true)
    expect(isBinaryFileName('run.exe')).toBe(true)
    // MC 特有二进制
    expect(isBinaryFileName('level.dat')).toBe(true)
    expect(isBinaryFileName('r.0.0.mca')).toBe(true)
    expect(isBinaryFileName('level.dat_old')).toBe(true)
  })

  it('文本扩展名与未知扩展名 → false', () => {
    expect(isBinaryFileName('server.properties')).toBe(false)
    expect(isBinaryFileName('config.yml')).toBe(false)
    expect(isBinaryFileName('whitelist.json')).toBe(false)
    expect(isBinaryFileName('latest.log')).toBe(false)
    // MC 生态常见但未收录的扩展名按可编辑处理（黑名单方向保守）
    expect(isBinaryFileName('rules.toml')).toBe(false)
    expect(isBinaryFileName('pack.mcmeta')).toBe(false)
    expect(isBinaryFileName('README.md')).toBe(false)
    // 无扩展名 / 隐藏文件
    expect(isBinaryFileName('noext')).toBe(false)
    expect(isBinaryFileName('.gitignore')).toBe(false)
  })

  it('大小写不敏感；dat_old 等双段扩展名命中', () => {
    expect(isBinaryFileName('WORLD.DAT')).toBe(true)
    expect(isBinaryFileName('Plugin.JAR')).toBe(true)
  })
})

describe('isEditableFile', () => {
  const entry = (overrides: { name: string; isDirectory?: boolean }) => ({
    name: overrides.name,
    isDirectory: overrides.isDirectory ?? false,
  })

  it('文本文件可编辑；目录与二进制文件不可编辑', () => {
    expect(isEditableFile(entry({ name: 'server.properties' }))).toBe(true)
    expect(isEditableFile(entry({ name: 'noext' }))).toBe(true)
    expect(isEditableFile(entry({ name: 'world', isDirectory: true }))).toBe(false)
    expect(isEditableFile(entry({ name: 'server.jar' }))).toBe(false)
    expect(isEditableFile(entry({ name: 'level.dat' }))).toBe(false)
  })
})

describe('fileIconName 与二进制判定一致性（回归：fileExtension 提取规则变更）', () => {
  it('图标映射在 fileExtension 重构后行为不变（含大写/多段扩展名）', () => {
    const e = (name: string) => ({ name, isDirectory: false })
    expect(fileIconName(e('config.YML'))).toBe('settings')
    expect(fileIconName(e('a.backup.tar.gz'))).toBe('file')
    expect(fileIconName({ name: 'dir', isDirectory: true })).toBe('folder')
  })
})
