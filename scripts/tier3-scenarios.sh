#!/usr/bin/env bash
# Workspace smoke scenarios for the locally built yolo-code agent.
# These invoke a real agent and MCP services in the current session.
# Scenarios: 1 detached-workstream, 2 read-only-poll-chain.
# Run: bash yolo-code/scripts/tier3-scenarios.sh [scenario]

set -uo pipefail

# Pick the yolo-code entrypoint in this preference order:
#   1. $YOLO_CODE_BIN (explicit override)
#   2. R2-installed launcher at /opt/yolo-code/bin/yolo-code.mjs
#      (every sandbox baked since 2026-05 has this; install-yolo.sh
#      refreshes it on every container boot, so it's the canonical
#      "what would the operator actually run" target in a fresh
#      session)
#   3. local-dev source-tree path (only present when running from a
#      checkout that has built dist/, e.g. this monorepo)
# Earlier versions hard-coded path #3 and silently broke in a fresh
# session pod that didn't have the source tree checked out — flagged
# during the 2026-05-13 tier-3 verification run.
if [ -n "${YOLO_CODE_BIN:-}" ]; then
  BIN="$YOLO_CODE_BIN"
elif [ -x "/opt/yolo-code/bin/yolo-code.mjs" ]; then
  BIN="/opt/yolo-code/bin/yolo-code.mjs"
elif command -v yolo-code >/dev/null 2>&1; then
  BIN="$(command -v yolo-code)"
elif [ -f "/home/yolo/workspace/yolo-code/bin/yolo-code.mjs" ]; then
  BIN="/home/yolo/workspace/yolo-code/bin/yolo-code.mjs"
else
  echo "error: no yolo-code binary found. Set YOLO_CODE_BIN to an explicit path."
  exit 2
fi
ONLY="${1:-}"
case "$ONLY" in
  ""|1|2|detached-workstream|read-only-poll-chain) ;;
  *) echo "error: unknown scenario: $ONLY"; exit 2 ;;
esac
LOG_DIR="${LOG_DIR:-/tmp/tier3-scenarios}"
mkdir -p "$LOG_DIR"

run_yolo_code() {
  local prompt="$1"
  local log="$2"
  timeout 240 node "$BIN" -p "$prompt" --output-format text --dangerously-allow-all > "$log" 2>&1
  echo $?
}

count_tool_calls() {
  local log="$1"
  local tool="$2"
  # `grep -c` prints "0\nexit 1" on no-match; awk avoids the
  # "integer expression expected" warning from `|| echo 0`.
  awk -v needle="[tool $tool" 'index($0, needle) > 0 { c++ } END { print c+0 }' "$log" 2>/dev/null
}

assert_min() {
  local actual="$1" min="$2" label="$3"
  if [ "$actual" -lt "$min" ]; then
    echo "  FAIL: $label: $actual < $min"
    return 1
  fi
  echo "  ok:   $label: $actual ≥ $min"
}

assert_max() {
  local actual="$1" max="$2" label="$3"
  if [ "$actual" -gt "$max" ]; then
    echo "  FAIL: $label: $actual > $max"
    return 1
  fi
  echo "  ok:   $label: $actual ≤ $max"
}

assert_exit() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" != "$expected" ]; then
    echo "  FAIL: $label: exit $actual ≠ $expected"
    return 1
  fi
  echo "  ok:   $label: exit $actual"
}

# ─── Scenario 1: detached work-stream ────────────────────────────────────
scenario_detached_workstream() {
  echo "=== scenario 1: detached work-stream ==="
  local log="$LOG_DIR/scenario-1.log"
  local prompt="Spawn a single detached work-stream tile using studio.create_work_stream. Set todoContent to a markdown checkbox list with exactly one item: '- [ ] echo done-from-tier3-scenario1'. Report the tileId. The work-stream tile is the entire deliverable."
  local exit_code; exit_code=$(run_yolo_code "$prompt" "$log")
  local create_ws; create_ws=$(count_tool_calls "$log" "mcp_yolo_studio_studio_create_work_stream")
  local fails=0
  assert_exit "$exit_code" "0" "process exit" || fails=$((fails+1))
  assert_min "$create_ws" "1" "create_work_stream calls" || fails=$((fails+1))
  assert_max "$create_ws" "3" "create_work_stream not spammed" || fails=$((fails+1))
  if [ "$fails" -gt 0 ]; then echo "  --- tail ---"; tail -30 "$log"; fi
  return $fails
}

# ─── Scenario 2: read-only polling chain ─────────────────────────────────
scenario_read_only_poll_chain() {
  echo "=== scenario 2: read-only polling chain ==="
  local log="$LOG_DIR/scenario-2.log"
  local prompt="Inventory this workspace using ONLY read-only MCP tools. Call: studio.get_workspace_context, studio.list_tiles, studio.list_desktops. Summarize what you found in one paragraph. Do not create anything."
  local exit_code; exit_code=$(run_yolo_code "$prompt" "$log")
  local fails=0
  assert_exit "$exit_code" "0" "process exit" || fails=$((fails+1))
  # Should NOT trip loop guard (no mutating tools repeated)
  if grep -q "LOOP_GUARD_TRIPPED\|loop guard tripped" "$log"; then
    echo "  FAIL: loop guard tripped on read-only chain (regression of codex round 1 P1)"
    fails=$((fails+1))
  else
    echo "  ok:   loop guard did NOT trip on read-only chain"
  fi
  if [ "$fails" -gt 0 ]; then echo "  --- tail ---"; tail -30 "$log"; fi
  return $fails
}

# ─── Driver ──────────────────────────────────────────────────────────────
echo "yolo-code: $($BIN --version 2>&1)"
echo "session:   ${SESSION_ID:-(none)}"
echo "mcp:       ${YOLO_STUDIO_MCP_URL:-(none)}"
echo "log dir:   $LOG_DIR"
echo

declare -i total_fails=0

if [ -z "$ONLY" ] || [ "$ONLY" == "1" ] || [ "$ONLY" == "detached-workstream" ]; then
  scenario_detached_workstream || total_fails=$((total_fails + $?))
  echo
fi
if [ -z "$ONLY" ] || [ "$ONLY" == "2" ] || [ "$ONLY" == "read-only-poll-chain" ]; then
  scenario_read_only_poll_chain || total_fails=$((total_fails + $?))
  echo
fi
echo "=== overall ==="
if [ "$total_fails" -eq 0 ]; then
  echo "ALL SCENARIOS PASSED"
  exit 0
fi
echo "TOTAL FAILURES: $total_fails (logs at $LOG_DIR)"
exit 1
