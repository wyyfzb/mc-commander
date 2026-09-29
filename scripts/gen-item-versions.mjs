#!/usr/bin/env node
/**
 * 从**官方注册表**生成物品版本元数据（条目 9），并顺带校验面板目录里的 id 是否真实存在。
 *
 * 数据源两个，都是权威的：
 *   ① Mojang `version_manifest_v2.json` —— 「哪些 id 是正式发布版」的唯一权威列表
 *   ② misode/mcmeta 各版本的 `item/data.json` —— 该版本的物品注册表
 *      （mcmeta 逐版本一 tag，内容是官方 data generator 输出的处理后快照）
 *
 * 用法：node scripts/gen-item-versions.mjs [--check]
 *   --check 只校验生成结果与仓库内文件一致（守卫用），不写盘
 *
 * **只处理面板目录（`mc-items.ts` 的 212 条）里的 id**，不把 1658 条注册表整个倒进来：
 * 前端只渲染目录里的物品，倒进来的是用不上的死数据；且这样能让「目录里的 id 在官方
 * 注册表里查不到」直接暴露出来——那正是 `give` 命令必失败的写法（本脚本据此发现了
 * `concrete` / `geyser` / `bucket_of_sulfur_cube` 三条）。
 *
 * 为什么不用源码注释里的版本标注：那是**行内标注**，只覆盖 35/212 条，且作用域不可
 * 机械判定——按「注释当分组长」解析会把 bread/cake/torch 等 12 条远古物品误标为 1.21，
 * 在旧版服上被隐藏。注册表算出来的「首见版本」不依赖任何人维护注释。
 *
 * 网络：GitHub raw 在部分网络不可达，故走 jsDelivr CDN（实测 200）。脚本在离线环境
 * 会退出并说明——它只在需要更新版本表时跑，不是构建/测试的前置。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG = path.join(ROOT, 'mc_manager_web/src/lib/mc-items.ts')
const OUT = path.join(ROOT, 'mc_manager_web/src/lib/mc-item-versions.ts')
const FLOOR = '1.20.5'
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const cdn = (tag, p) => `https://cdn.jsdelivr.net/gh/misode/mcmeta@${tag}/${p}`

async function getJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
  return r.json()
}

async function itemsOf(version) {
  const j = await getJson(cdn(`${version}-registries`, 'item/data.json'))
  return new Set(Array.isArray(j) ? j : Object.keys(j))
}

/** 面板目录里的物品 id（与源码同一解析口径：行首对象字面量的 id 字段） */
function catalogIds() {
  const src = fs.readFileSync(CATALOG, 'utf8')
  return [...src.matchAll(/^\s*\{\s*id:\s*'([^']+)'/gm)].map((m) => m[1])
}

function render(since) {
  const byVersion = new Map()
  for (const [id, v] of Object.entries(since)) {
    if (!byVersion.has(v)) byVersion.set(v, [])
    byVersion.get(v).push(id)
  }
  const versions = [...byVersion.keys()].sort((a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < 3; i++)
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
    return 0
  })
  const lines = []
  for (const v of versions) {
    lines.push(`  // ${v}`)
    for (const id of byVersion.get(v).sort()) lines.push(`  ${id}: '${v}',`)
  }
  return lines.join('\n')
}

async function main() {
  const check = process.argv.includes('--check')
  const catalog = catalogIds()
  process.stderr.write(`面板目录 ${catalog.length} 条\n`)

  const manifest = await getJson(MANIFEST)
  const releases = manifest.versions
    .filter((v) => v.type === 'release')
    .map((v) => v.id)
    .reverse()
  const floorIdx = releases.indexOf(FLOOR)
  if (floorIdx < 0) throw new Error(`正式版列表中找不到起点版本 ${FLOOR}`)
  const scan = releases.slice(floorIdx)
  process.stderr.write(`扫描 ${scan.length} 个正式版（${scan[0]} … ${scan.at(-1)}）\n`)

  // 逐版本累加：只记面板目录里关心的 id
  const wanted = new Set(catalog)
  const firstSeen = new Map()
  for (const it of await itemsOf(FLOOR)) if (wanted.has(it)) firstSeen.set(it, FLOOR)
  for (const v of scan.slice(1)) {
    const set = await itemsOf(v)
    for (const it of set) if (wanted.has(it) && !firstSeen.has(it)) firstSeen.set(it, v)
  }

  // 官方注册表里查不到的 id：give 命令在任何版本都会失败
  const missing = catalog.filter((id) => !firstSeen.has(id))
  if (missing.length > 0) {
    process.stderr.write(`\n✗ ${missing.length} 条 id 在官方物品注册表中不存在（give 必失败）：\n`)
    for (const id of missing) process.stderr.write(`    ${id}\n`)
    process.stderr.write('  请在 mc-items.ts 中订正或移除后再生成。\n')
    process.exit(1)
  }

  const since = Object.fromEntries(
    [...firstSeen.entries()].filter(([, v]) => v !== FLOOR).sort(([a], [b]) => a.localeCompare(b)),
  )
  process.stderr.write(`\n需标注版本的物品 ${Object.keys(since).length} 条\n`)

  const src = fs.readFileSync(OUT, 'utf8')
  const next = src.replace(
    /(export const ITEM_SINCE_VERSION: Readonly<Record<string, string>> = \{\n)[\s\S]*?(\n\})/,
    (_m, head, tail) => `${head}${render(since)}${tail}`,
  )
  if (next === src) {
    process.stderr.write('生成结果与仓库内一致\n')
    return
  }
  if (check) {
    process.stderr.write('✗ 版本表与官方注册表不一致，请运行 node scripts/gen-item-versions.mjs\n')
    process.exit(1)
  }
  fs.writeFileSync(OUT, next)
  process.stderr.write(`已写入 ${path.relative(ROOT, OUT)}\n`)
}

main().catch((e) => {
  process.stderr.write(`生成失败：${e.message}\n`)
  process.stderr.write('（本脚本需要访问 piston-meta.mojang.com 与 cdn.jsdelivr.net）\n')
  process.exit(2)
})
