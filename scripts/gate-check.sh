#!/usr/bin/env bash
# scripts/gate-check.sh
# =============================================================================
# Ask the OPA spend gate about a hypothetical rental, from a human's terminal.
#
#   ./scripts/gate-check.sh <dph_total> [live_instance_count]
#   ./scripts/gate-check.sh 0.15 0    -> ALLOW
#   ./scripts/gate-check.sh 0.20 0    -> DENY (VAST-SPEND-002, exactly at cap)
#   ./scripts/gate-check.sh 0.15 2    -> DENY (VAST-SPEND-001, third box)
#
# Exit 0 = allow, 1 = deny, 2 = could not obtain a verdict. A caller that treats
# only exit 0 as permission is safe by construction.
#
# ⚠️ This file exists as a SCRIPT rather than inline in mise.toml because mise
# APPENDS task arguments to the command line instead of binding them as $1/$2.
# Measured: `run = 'echo "[$1]"'` with `mise run t 0.15 2` prints `[] 0.15 2` —
# the positional refs are empty and the args land as trailing words on whatever
# command came last. Inline arg handling in a mise task silently reads nothing.
# Invoking a script makes the appended args that script's own argv.
#
# The deploy graph must OWN what it consumes: this is committed, so it is not
# another "artifact never committed -> exit 127" (see AGENTS.md).
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OPA="${VAST_OPA_BIN:-opa}"

if [[ $# -lt 1 ]]; then
  echo "usage: $(basename "$0") <dph_total> [live_instance_count]" >&2
  echo "  e.g. $(basename "$0") 0.15 0" >&2
  exit 2
fi

DPH="$1"
N="${2:-0}"

if ! [[ "$DPH" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "DENY — dph_total '$DPH' is not a number. An unpriced offer is never rentable." >&2
  exit 2
fi
if ! [[ "$N" =~ ^[0-9]+$ ]]; then
  echo "DENY — live_instance_count '$N' is not a non-negative integer." >&2
  exit 2
fi

if ! command -v "$OPA" >/dev/null 2>&1; then
  echo "DENY — '$OPA' not found on PATH. No verdict is not approval." >&2
  exit 2
fi

# The policy requires a LIST, not a count, so a caller cannot understate
# concurrency. Build one of the requested length.
LIVE="["
for ((i = 0; i < N; i++)); do
  [[ $i -gt 0 ]] && LIVE+=","
  LIVE+="{\"id\":$((1000 + i))}"
done
LIVE+="]"

INPUT="{\"action\":\"rent\",\"candidate\":{\"dph_total\":$DPH},\"live_instances\":$LIVE}"

OUT="$(printf '%s' "$INPUT" | "$OPA" eval \
  --data "$REPO/policies/rego" \
  --data "$REPO/policies/data" \
  --stdin-input --format json \
  'data.vast.spend.decision' 2>&1)" || {
  echo "DENY — opa failed: $OUT" >&2
  exit 2
}

# The verdict is read from the OUTPUT, not from python's exit status alone.
# A crashed interpreter (SyntaxError, missing module) exits 1, which a naive
# caller would read as an ordinary "DENY" — conflating "the policy refused" with
# "the checker is broken". Only a line that literally starts with ALLOW or DENY
# is a verdict; anything else is exit 2, no verdict.
set +e
VERDICT="$(printf '%s' "$OUT" | python3 -c '
import json, sys

try:
    doc = json.load(sys.stdin)
except Exception as e:
    print(f"DENY - opa output was not JSON: {e}", file=sys.stderr)
    sys.exit(2)

# opa exits 0 with no result when a referenced document is absent. That is the
# fail-open trap: it looks identical to "no violations". Never read it as allow.
result = doc.get("result")
if not result:
    print("DENY - the policy did not evaluate (undefined result). "
          "Are both policies/rego and policies/data loaded?", file=sys.stderr)
    sys.exit(2)

d = result[0]["expressions"][0]["value"]
allow = d.get("allow") is True
seen = d.get("limits_seen") or {}

if allow and (not isinstance(seen, dict) or "error" in seen):
    print("DENY - policy said allow but read no limits document.", file=sys.stderr)
    sys.exit(2)

print("ALLOW" if allow else "DENY")
for m in d.get("deny", []):
    print("  -", m)

# Echo the ceilings actually read, so the operator can see the gate was not
# evaluating against an empty document.
if isinstance(seen, dict) and "maxDphPerInstance" in seen:
    n_max = seen.get("maxConcurrentInstances")
    p_max = seen.get("maxDphPerInstance")
    print("  (ceilings read: max {} concurrent, < ${}/hr each)".format(n_max, p_max))

sys.exit(0 if allow else 1)
')"
PY_RC=$?
set -e

printf '%s\n' "$VERDICT"

case "$VERDICT" in
  ALLOW*)
    if [[ $PY_RC -ne 0 ]]; then
      echo "DENY - verdict said ALLOW but the checker exited $PY_RC; refusing." >&2
      exit 2
    fi
    exit 0
    ;;
  DENY*)
    exit 1
    ;;
  *)
    # No parsable verdict: the checker did not get to decide. Not a denial by the
    # policy, and emphatically not an approval.
    echo "DENY - no verdict could be obtained (checker exited $PY_RC)." >&2
    exit 2
    ;;
esac
