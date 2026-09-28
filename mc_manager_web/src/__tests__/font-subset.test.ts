/**
 * WOFF2 子集覆盖检查：字体子集必须真的包含中文标点与常用符号。
 *
 * 为什么不能用浏览器量：试过两条路都不成立。
 * ① `document.fonts.check(family, text)` —— 对**子集外**的字符（emoji、扩展 B 区）也返回 true，
 *    证不了覆盖范围（实测）；
 * ② canvas 量宽（站点字体栈 vs 裸 sans-serif）—— 把一串字符合起来量时，只要其中
 *    **任意一枚**字形在子集里，两端宽度就不同（实测：子集只含 `…` 一枚、其余标点全缺时，
 *    合起来的断言仍通过）；逐字符量也有 19/25 分辨不出（`，。、「」（）` 与回退字体同宽）。
 *
 * 真正等价于命题的判据是「某个码位在不在字体的 cmap 里」，故这里直接解析 WOFF2。
 * 本文件自带极简解析器（**不引第三方依赖**）：WOFF2 只对 glyf/loca 做表变换，
 * cmap 等表是原样 brotli 压缩进单一数据流，整段解压后按 origLength 切片即可。
 *
 * 缺口由来：子集此前只收汉字（6858 码位），`，。、「」（）` 全缺失 —— 中文正文里
 * 标点与汉字来自两套字体，字形与字重都对不上。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const FONT = join(import.meta.dirname, '..', 'assets', 'fonts', 'NotoSansSC-Subset.woff2')

/** WOFF2 已知表 tag 索引（规范 Table 1；索引 63 表示 tag 紧随其后） */
const KNOWN_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
]

function readBase128(buf: Buffer, pos: number): [number, number] {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const byte = buf[pos++]!
    if (i === 0 && byte === 0x80) throw new Error('UIntBase128 前导零')
    if (value & 0xfe000000) throw new Error('UIntBase128 溢出')
    value = (value << 7) | (byte & 0x7f)
    if ((byte & 0x80) === 0) return [value >>> 0, pos]
  }
  throw new Error('UIntBase128 过长')
}

/** 解析 WOFF2 → 表名到数据的映射（只做解压与切片，不重建 glyf） */
function parseWoff2Tables(buf: Buffer): Map<string, Buffer> {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('不是 WOFF2 文件')
  const numTables = buf.readUInt16BE(12)
  const totalCompressedSize = buf.readUInt32BE(20)

  let pos = 48
  const entries: Array<{ tag: string; origLength: number; transformLength: number | null }> = []
  for (let i = 0; i < numTables; i++) {
    const flags = buf[pos++]!
    const tagIndex = flags & 0x3f
    const transformVersion = (flags >> 6) & 0x03
    let tag: string
    if (tagIndex === 63) {
      tag = buf.toString('latin1', pos, pos + 4)
      pos += 4
    } else {
      tag = KNOWN_TAGS[tagIndex]!
    }
    let origLength: number
    ;[origLength, pos] = readBase128(buf, pos)
    // glyf/loca：version 0 = 已变换；其余表：version 0 = 未变换
    const isGlyfLoca = tag === 'glyf' || tag === 'loca'
    const hasTransformLength = isGlyfLoca ? transformVersion === 0 : transformVersion !== 0
    let transformLength: number | null = null
    if (hasTransformLength) {
      ;[transformLength, pos] = readBase128(buf, pos)
    }
    entries.push({ tag, origLength, transformLength })
  }

  const raw = brotliDecompressSync(buf.subarray(pos, pos + totalCompressedSize))
  const tables = new Map<string, Buffer>()
  let off = 0
  for (const e of entries) {
    const len = e.transformLength ?? e.origLength
    tables.set(e.tag, raw.subarray(off, off + len))
    off += len
  }
  return tables
}

/** 解析 cmap → 码位集合（合并 Unicode 子表；format 4 与 12） */
function cmapCodepoints(cmap: Buffer): Set<number> {
  const out = new Set<number>()
  const numTables = cmap.readUInt16BE(2)
  for (let i = 0; i < numTables; i++) {
    const rec = 4 + i * 8
    const platformID = cmap.readUInt16BE(rec)
    const encodingID = cmap.readUInt16BE(rec + 2)
    const offset = cmap.readUInt32BE(rec + 4)
    const isUnicode =
      platformID === 0 || (platformID === 3 && (encodingID === 1 || encodingID === 10))
    if (!isUnicode) continue
    const format = cmap.readUInt16BE(offset)
    if (format === 4) {
      const segCountX2 = cmap.readUInt16BE(offset + 6)
      const segCount = segCountX2 / 2
      const endBase = offset + 14
      const startBase = endBase + segCountX2 + 2
      for (let s = 0; s < segCount; s++) {
        const end = cmap.readUInt16BE(endBase + s * 2)
        const start = cmap.readUInt16BE(startBase + s * 2)
        for (let cp = start; cp <= end && cp !== 0xffff; cp++) out.add(cp)
      }
    } else if (format === 12) {
      const nGroups = cmap.readUInt32BE(offset + 12)
      for (let g = 0; g < nGroups; g++) {
        const base = offset + 16 + g * 12
        const start = cmap.readUInt32BE(base)
        const end = cmap.readUInt32BE(base + 4)
        for (let cp = start; cp <= end; cp++) out.add(cp)
      }
    }
  }
  return out
}

const codepoints = cmapCodepoints(parseWoff2Tables(readFileSync(FONT)).get('cmap')!)

describe('字体子集覆盖（中文标点与常用符号）', () => {
  it('解析器自检：码位总数落在合理区间（防解析失败后返回空集让断言恒真）', () => {
    // 子集 6916 码位（旧 6858 ∪ 补充）；解析错会得到 0，届时下面的断言会集体「通过」
    expect(codepoints.size).toBeGreaterThan(6800)
    expect(codepoints.size).toBeLessThan(7200)
  })

  /**
   * 中文标点是**成句必需**：缺了它们，同一句话里标点由回退字体渲染，
   * 字形与字重都与汉字不一致（回退字体未必有 500 字重）。
   * 判据写在码位级——这是唯一与「这串文字用了哪个字体」等价的观测量。
   */
  it('中文标点齐备（句读、引号、括号、书名号、省略与破折号）', () => {
    const required = '，。、；：？！（）（）「」『』【】《》〈〉〔〕［］｛｝—…·“”‘’'
    const missing = [...required].filter((ch) => !codepoints.has(ch.codePointAt(0)!))
    expect(missing, `字体内缺这些标点：${missing.join('')}`).toHaveLength(0)
  })

  it('常用符号齐备（箭头、比较符、单位与 UI 记号）', () => {
    // ← → 用于「返回」类文案；↑↓↔ 用于排序/对照；× ≤ ≥ ± 用于计数与阈值
    const required = '←→↑↓↔⇒×÷±≤≥≠≈∞⌘✓©§①'
    const missing = [...required].filter((ch) => !codepoints.has(ch.codePointAt(0)!))
    expect(missing, `字体内缺这些符号：${missing.join('')}`).toHaveLength(0)
  })

  it('空白字符齐备（U+3000 全角空格与 U+00A0 不换行空格）', () => {
    // 二者出现在用户数据（MOTD / 世界名 / 配置文件值）里，缺了会退化成不同宽度的空白
    expect(codepoints.has(0x3000), '缺 U+3000 全角空格').toBe(true)
    expect(codepoints.has(0x00a0), '缺 U+00A0 不换行空格').toBe(true)
  })

  /**
   * 负对照：确认「不在字体里」这件事真的能被观察到。
   * 若解析器坏成「什么都返回 true」，上面几条会集体假绿；这两枚字符确定不在子集里
   * （emoji 与扩展 B 区罕用字，源字体本身就没有），它们为 false 才说明判定面有效。
   */
  it('负对照：子集外字符确实判为缺失（防解析器恒真）', () => {
    expect(codepoints.has('🔥'.codePointAt(0)!)).toBe(false)
    expect(codepoints.has(0x20000)).toBe(false)
  })
})
