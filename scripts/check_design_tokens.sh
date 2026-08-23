#!/usr/bin/env bash
# Design token lint: detect Colors.white/black/Color(0x literals in screens/widgets
# Purpose: encourage business code to use MCSC fields or AppTheme tokens instead of hardcoded colors
# Usage: bash scripts/check_design_tokens.sh
# Exit code: 0=clean; 1=violations found (blocking, integrate into local-check.sh after token migration)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_DIR/mc_manager_app"

if [ ! -d "$APP_DIR/lib" ]; then
  echo "Error: mc_manager_app/lib directory not found" >&2
  exit 2
fi

echo "=== Design token lint: detect Colors.white/black/Color(0x literals ==="
echo "Scan scope: lib/screens/ lib/widgets/"
echo ""

TOTAL=0
REPORT=""

# Detect Colors.white / Colors.black
while IFS= read -r line; do
  REPORT+="  [Colors.white/black] $line"$'\n'
  TOTAL=$((TOTAL + 1))
done < <(grep -rnE 'Colors\.(white|black)\b' "$APP_DIR/lib/screens" "$APP_DIR/lib/widgets" --include='*.dart' 2>/dev/null || true)

# Detect Color(0x...) literals
while IFS= read -r line; do
  REPORT+="  [Color(0x...)]      $line"$'\n'
  TOTAL=$((TOTAL + 1))
done < <(grep -rnE 'Color\(0x[0-9A-Fa-f]+\)' "$APP_DIR/lib/screens" "$APP_DIR/lib/widgets" --include='*.dart' 2>/dev/null || true)

if [ "$TOTAL" -gt 0 ]; then
  echo "$REPORT"
  echo "=== Done: $TOTAL literal(s) detected ==="
  echo "Migrate these literals to MCSC fields (Theme.of(context).extension<MCSC>()!) or AppTheme tokens"
  echo "(Blocking lint, exit 1)"
  exit 1
fi

echo "=== Done: no literal violations ==="
