#!/usr/bin/env bash
# Check if final_form rate >= 10%
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Capture JSON output; redirect all tsx stderr to /dev/null
result=$(npx tsx scripts/apply-stats.ts --json 2>/dev/null) || true

if [ -z "$result" ]; then
  echo "ERROR: apply-stats returned empty output"
  exit 1
fi

# Extract values using python
final_form=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['final_form_total'])" 2>/dev/null) || true
total=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['total_jobs'])" 2>/dev/null) || true
pct=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['final_form_pct_of_total'])" 2>/dev/null) || true
pass=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['threshold_final_pass'])" 2>/dev/null) || true

echo "final_form=$final_form total=$total pct=$pct pass=$pass"

if [ "$pass" = "True" ]; then
  echo "PASS: final_form rate = $pct (>= 10%)"
  exit 0
else
  echo "FAIL: final_form rate = $pct (need >= 10%)"
  exit 1
fi
