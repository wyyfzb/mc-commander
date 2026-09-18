#!/usr/bin/env node
/**
 * check-coverage-gate.mjs —— CI 覆盖率门禁（issue #338）
 * 汇总前端/服务端两份 vitest coverage-final.json（istanbul 格式），
 * 按语句覆盖率（statements.covered / statements.total）与阈值比较，低于则 exit 1 阻止合并。
 * 口径说明：v8 provider 产物无 lines 汇总字段（statementMap + s 推导行覆盖不准确——
 * 一行多语句去重后按行计，会系统性低估）；statements 口径为 CI 门禁行业惯例，
 * 与 vitest 文本报告的 % Stmts 一致。owner 2026-09-03 拍板：statements；阈值 65%。
 * owner 2026-09-18 拍板提到 **70%**（前提是「先实测两包真实覆盖率」，实测结果：
 * 前端 statements 82.95% / 服务端 92.74%，均远超 70，无补测试的缺口门槛问题）。
 * 用法：node scripts/check-coverage-gate.mjs <web-json> <server-json> [threshold=70]
 */
import { readFileSync } from 'node:fs'

function sumStatements(jsonPath) {
  const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
  let total = 0
  let covered = 0
  for (const file of Object.values(report)) {
    if (!file?.statementMap) continue
    for (const [id, stmt] of Object.entries(file.statementMap)) {
      if (!stmt?.start) continue
      total++
      if ((file.s?.[id] ?? 0) > 0) covered++
    }
  }
  return { total, covered, pct: total > 0 ? (covered / total) * 100 : 0 }
}

const [webPath, serverPath, thresholdArg] = process.argv.slice(2)
if (!webPath || !serverPath) {
  console.error('用法：node scripts/check-coverage-gate.mjs <web-json> <server-json> [threshold]')
  process.exit(2)
}
const threshold = Number(thresholdArg ?? 65)

const web = sumStatements(webPath)
const server = sumStatements(serverPath)
const combined = { total: web.total + server.total, covered: web.covered + server.covered }
combined.pct = combined.total > 0 ? (combined.covered / combined.total) * 100 : 0

const fmt = (v) => v.toFixed(2) + '%'
console.log(`前端语句覆盖率：${fmt(web.pct)}（${web.covered}/${web.total}）`)
console.log(`服务端语句覆盖率：${fmt(server.pct)}（${server.covered}/${server.total}）`)
console.log(`合计语句覆盖率：${fmt(combined.pct)}（${combined.covered}/${combined.total}）`)
console.log(`门禁阈值：${threshold}%`)

if (combined.pct < threshold) {
  console.error(`✗ 覆盖率 ${fmt(combined.pct)} 低于阈值 ${threshold}%，门禁失败`)
  process.exit(1)
}
console.log('✓ 覆盖率门禁通过')
