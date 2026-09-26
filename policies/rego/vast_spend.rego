# policies/rego/vast_spend.rego
# =============================================================================
# Vast.ai rental admission gate.
#
#   VAST-SPEND-001  at most 2 rented instances at once (whole account)
#   VAST-SPEND-002  strictly under $0.20/hr per instance
#
# Both ceilings come from policies/data/spend-limits.json, mounted at
# data.vast_spend_limits (OPA puts a --data JSON at the ROOT of `data`; the
# wrapper key in that file IS the mount path).
#
# =============================================================================
# ⚠️⚠️ THE TWO FAIL-OPEN TRAPS THIS FILE EXISTS TO AVOID (both proven live
# 2026-09-27, the second one by this very file's own first draft):
#
# TRAP 1 — unloaded data document.
#   `deny if input.price > data.vast_spend_limits.cap` lets $9.99/hr through
#   with an empty deny set and exit 0 when --data is not passed. The reference
#   is undefined, the body never matches, the gate silently approves.
#
# TRAP 2 — `not` over an undefined reference does NOT mean "absent".
#   `not is_number(input.candidate.dph_total)` FAILS TO FIRE when dph_total is
#   missing. An unresolvable ref inside the body makes the whole body undefined,
#   and an undefined body is a rule that did not match — it is NOT a true `not`.
#   Measured:
#     dph_total: "0.15"  (wrong type) -> fires    ✅ caught
#     dph_total absent                -> SILENT   ❌ request with no price at all approved
#     candidate absent                -> SILENT   ❌
#   So a type check written the obvious way validates only values that EXIST.
#
# THE FIX, applied throughout below:
#   * input paths       -> object.get(input, [...], null), which is always
#                          defined, so is_number/is_array actually get to run.
#   * data-side paths    -> a `default <x> := false` helper. `default` is the
#                          only construct that converts "undefined" into a
#                          known value, so `not <x>` becomes reliable.
#
# Never write `not is_number(<bare ref>)` in this file. Never branch on
# `count(deny) == 0` computed by the caller. Branch on `allow`, which is
# `default false`.
# =============================================================================
package vast.spend

import rego.v1

default allow := false

allow if count(deny) == 0

# Structured verdict so one `opa eval` yields everything the caller needs.
decision := {
	"allow": allow,
	"deny": deny,
	"limits_seen": limits_seen,
}

# -----------------------------------------------------------------------------
# Always-defined views of the input. object.get supplies null for an absent
# path, which is what lets the type assertions below actually execute (TRAP 2).
# -----------------------------------------------------------------------------

price := object.get(input, ["candidate", "dph_total"], null)

live := object.get(input, ["live_instances"], null)

# -----------------------------------------------------------------------------
# Always-defined views of the limits document. `default` is what turns an
# unloaded or partial document into a knowable false rather than silence
# (TRAP 1 + TRAP 2). object.get is unusable here: it would have to take `data`
# wholesale as its object, and since these rules are themselves part of `data`
# that is a rego_recursion_error.
# -----------------------------------------------------------------------------

default limits_ok := false

limits_ok if is_object(data.vast_spend_limits)

default cap_count_ok := false

cap_count_ok if is_number(data.vast_spend_limits.maxConcurrentInstances)

default cap_price_ok := false

cap_price_ok if is_number(data.vast_spend_limits.maxDphPerInstance)

# What the policy actually read, echoed back so a caller can prove the gate
# evaluated against real numbers rather than against nothing.
limits_seen := data.vast_spend_limits if limits_ok

limits_seen := {"error": "limits document absent or not an object"} if not limits_ok

# -----------------------------------------------------------------------------
# Preconditions: the limits document itself
# -----------------------------------------------------------------------------

deny contains msg if {
	not limits_ok
	msg := "VAST-SPEND-000: spend-limits document missing at data.vast_spend_limits — refusing to rent against an unknown ceiling (load policies/data/spend-limits.json with --data)"
}

deny contains msg if {
	limits_ok
	not cap_count_ok
	msg := "VAST-SPEND-000: maxConcurrentInstances is missing or not a number"
}

deny contains msg if {
	limits_ok
	not cap_price_ok
	msg := "VAST-SPEND-000: maxDphPerInstance is missing or not a number"
}

# -----------------------------------------------------------------------------
# Preconditions: the input document
# -----------------------------------------------------------------------------

deny contains msg if {
	not is_number(price)
	msg := "VAST-SPEND-000: input.candidate.dph_total is missing or not a number — an unpriced offer is never rentable"
}

deny contains msg if {
	not is_array(live)
	msg := "VAST-SPEND-000: input.live_instances must be an array of the instances currently on the account — an unknown instance count cannot be compared to the concurrency cap"
}

# -----------------------------------------------------------------------------
# VAST-SPEND-002: per-instance hourly price, STRICTLY under the cap
# -----------------------------------------------------------------------------

deny contains msg if {
	is_number(price)
	cap_price_ok
	cap := data.vast_spend_limits.maxDphPerInstance
	price >= cap
	msg := sprintf("VAST-SPEND-002: offer at $%.4f/hr is not strictly under the $%.2f/hr per-instance cap", [price, cap])
}

deny contains msg if {
	is_number(price)
	price <= 0
	msg := sprintf("VAST-SPEND-002: offer price $%.4f/hr is non-positive — a free GPU is a parsing bug, not a bargain", [price])
}

# -----------------------------------------------------------------------------
# VAST-SPEND-001: concurrency, counted across the WHOLE account
#
# Foreign/unlabelled instances count. They bill the same card, so excluding
# them would make the cap meaningless. (The reaper still never DESTROYS a
# foreign instance — counting and destroying are different permissions.)
# -----------------------------------------------------------------------------

deny contains msg if {
	is_array(live)
	cap_count_ok
	cap := data.vast_spend_limits.maxConcurrentInstances
	count(live) >= cap
	msg := sprintf("VAST-SPEND-001: already holding %d instance(s) on this account; cap is %d concurrent", [count(live), cap])
}
