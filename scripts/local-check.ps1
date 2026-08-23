# 本地 CI：统一执行后端 lint/test 与前端 analyze
# 用法：powershell -ExecutionPolicy Bypass -File scripts/local-check.ps1 [-SkipFrontend]
[CmdletBinding()]
param(
  [switch]$SkipFrontend
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ServerDir = Join-Path $ProjectDir 'mc_commander_server'
$AppDir = Join-Path $ProjectDir 'mc_manager_app'

function Invoke-Step {
  param([string]$Label, [scriptblock]$Action)
  Write-Host "=== $Label ===" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "步骤失败：$Label (exit $LASTEXITCODE)" }
}

try {
  if (-not (Test-Path $ServerDir)) { throw '未找到 mc_commander_server 目录' }

  Invoke-Step '[1/2] 后端 Lint + 单元测试' {
    Set-Location $ServerDir
    if (-not (Test-Path 'node_modules')) {
      Write-Host 'node_modules 不存在，执行 npm ci --no-audit --no-fund'
      npm ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
    }
    npm run lint
    if ($LASTEXITCODE -ne 0) { throw 'npm run lint 失败' }
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'npm test 失败' }
  }

  if ($SkipFrontend) {
    Write-Host '已跳过前端检查（-SkipFrontend）'
  } else {
    if (-not (Test-Path $AppDir)) { throw '未找到 mc_manager_app 目录' }
    Invoke-Step '[2/2] 前端静态分析' {
      Set-Location $AppDir
      flutter pub get
      if ($LASTEXITCODE -ne 0) { throw 'flutter pub get 失败' }
      flutter analyze
      if ($LASTEXITCODE -ne 0) { throw 'flutter analyze 失败' }
      flutter test
      if ($LASTEXITCODE -ne 0) { throw 'flutter test 失败' }
    }
  }

  Write-Host '=== 本地检查通过 ===' -ForegroundColor Green
}
catch {
  Write-Host "本地检查未通过：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
