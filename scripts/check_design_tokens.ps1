# Design token lint: detect Colors.white/black/Color(0x literals in screens/widgets
# Purpose: encourage business code to use MCSC fields or AppTheme tokens instead of hardcoded colors
# Usage: powershell -ExecutionPolicy Bypass -File scripts/check_design_tokens.ps1
# Exit code: 0=clean; 1=violations found (blocking, integrate into local-check.ps1 after token migration)
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $ProjectDir 'mc_manager_app'

if (-not (Test-Path (Join-Path $AppDir 'lib'))) {
  Write-Error 'mc_manager_app/lib directory not found'
  exit 2
}

Write-Host '=== Design token lint: detect Colors.white/black/Color(0x literals ==='
Write-Host 'Scan scope: lib/screens/ lib/widgets/'
Write-Host ''

$ScreensDir = Join-Path $AppDir 'lib\screens'
$WidgetsDir = Join-Path $AppDir 'lib\widgets'
$Patterns = @(
  @{ Name = 'Colors.white/black'; Regex = 'Colors\.(white|black)\b' },
  @{ Name = 'Color(0x...)';       Regex = 'Color\(0x[0-9A-Fa-f]+\)' }
)

$Total = 0
$Report = [System.Collections.Generic.List[string]]::new()

foreach ($pat in $Patterns) {
  $files = @()
  if (Test-Path $ScreensDir) { $files += Get-ChildItem -Path $ScreensDir -Filter '*.dart' -File -Recurse }
  if (Test-Path $WidgetsDir) { $files += Get-ChildItem -Path $WidgetsDir -Filter '*.dart' -File -Recurse }
  foreach ($file in $files) {
    $matches = Select-String -Path $file.FullName -Pattern $pat.Regex -AllMatches
    foreach ($m in $matches) {
      $rel = $file.FullName.Substring($AppDir.Length).TrimStart('\','/')
      $line = "  [$($pat.Name)] ${rel}:$($m.LineNumber): $($m.Line.Trim())"
      $Report.Add($line)
      $Total++
    }
  }
}

if ($Total -gt 0) {
  $Report | ForEach-Object { Write-Host $_ }
  Write-Host ''
  Write-Host "=== Done: $Total literal(s) detected ==="
  Write-Host 'Migrate these literals to MCSC fields (Theme.of(context).extension<MCSC>()!) or AppTheme tokens'
  Write-Host '(Blocking lint, exit 1)'
  exit 1
}

Write-Host '=== Done: no literal violations ==='
