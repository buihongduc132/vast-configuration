# policies/rego/vast_spend_test.rego
# =============================================================================
# Unit tests for the rental admission gate.
#
# Run: opa test policies/rego policies/data -v
#
# The "limits document entirely absent" case is NOT tested here — `opa test`
# always loads the data directory, so it cannot reproduce that failure. It is
# tested in tests/policy-gate.test.ts by invoking the real `opa eval` command
# line WITHOUT --data, which is exactly how the failure would happen in
# production.
# =============================================================================
package vast.spend_test

import rego.v1

import data.vast.spend

# A well-formed baseline: one cheap candidate, nothing running.
base := {
	"action": "rent",
	"candidate": {"id": 12345, "dph_total": 0.15, "machine_id": 999},
	"live_instances": [],
}

inst(n) := [x | some i in numbers.range(1, n); x := {"id": i}] if n > 0

inst(n) := [] if n <= 0

# -----------------------------------------------------------------------------
# Happy path
# -----------------------------------------------------------------------------

test_allows_cheap_offer_with_nothing_running if {
	spend.allow with input as base
}

test_allows_second_instance if {
	spend.allow with input as object.union(base, {"live_instances": inst(1)})
}

test_no_violations_on_happy_path if {
	count(spend.deny) == 0 with input as base
}

# -----------------------------------------------------------------------------
# VAST-SPEND-001 — concurrency cap of 2
# -----------------------------------------------------------------------------

test_denies_third_instance_when_two_already_running if {
	not spend.allow with input as object.union(base, {"live_instances": inst(2)})
}

test_denies_when_over_cap if {
	not spend.allow with input as object.union(base, {"live_instances": inst(3)})
}

test_concurrency_violation_names_the_rule if {
	msgs := spend.deny with input as object.union(base, {"live_instances": inst(2)})
	some m in msgs
	startswith(m, "VAST-SPEND-001")
}

# Foreign/unlabelled instances still count toward the cap — they bill the same card.
test_foreign_instances_count_toward_cap if {
	foreign := [{"id": 1, "label": null}, {"id": 2, "label": null}]
	not spend.allow with input as object.union(base, {"live_instances": foreign})
}

# -----------------------------------------------------------------------------
# VAST-SPEND-002 — strictly under $0.20/hr
# -----------------------------------------------------------------------------

test_allows_just_under_the_cap if {
	spend.allow with input as object.union(base, {"candidate": {"dph_total": 0.1999}})
}

test_denies_exactly_at_the_cap if {
	not spend.allow with input as object.union(base, {"candidate": {"dph_total": 0.2}})
}

test_denies_above_the_cap if {
	not spend.allow with input as object.union(base, {"candidate": {"dph_total": 0.25}})
}

test_price_violation_names_the_rule if {
	msgs := spend.deny with input as object.union(base, {"candidate": {"dph_total": 0.45}})
	some m in msgs
	startswith(m, "VAST-SPEND-002")
}

test_denies_zero_price if {
	not spend.allow with input as object.union(base, {"candidate": {"dph_total": 0}})
}

test_denies_negative_price if {
	not spend.allow with input as object.union(base, {"candidate": {"dph_total": -1}})
}

# -----------------------------------------------------------------------------
# Fail-closed on malformed input
# -----------------------------------------------------------------------------

test_denies_missing_price if {
	not spend.allow with input as {"action": "rent", "candidate": {"id": 1}, "live_instances": []}
}

test_denies_non_numeric_price if {
	not spend.allow with input as object.union(base, {"candidate": {"dph_total": "0.15"}})
}

test_denies_missing_live_instances if {
	not spend.allow with input as {"action": "rent", "candidate": {"dph_total": 0.15}}
}

test_denies_live_instances_not_an_array if {
	not spend.allow with input as object.union(base, {"live_instances": 2})
}

test_denies_empty_input if {
	not spend.allow with input as {}
}

# A count supplied as a bare number must NOT satisfy the array requirement —
# otherwise a caller could understate concurrency with a scalar.
test_scalar_count_does_not_satisfy_the_array_requirement if {
	msgs := spend.deny with input as object.union(base, {"live_instances": 0})
	some m in msgs
	contains(m, "must be an array")
}

# -----------------------------------------------------------------------------
# Fail-closed on a malformed limits document
# -----------------------------------------------------------------------------

test_denies_when_concurrency_limit_missing if {
	not spend.allow with input as base with data.vast_spend_limits as {"maxDphPerInstance": 0.2}
}

test_denies_when_price_limit_missing if {
	not spend.allow with input as base with data.vast_spend_limits as {"maxConcurrentInstances": 2}
}

test_denies_when_limits_not_an_object if {
	not spend.allow with input as base with data.vast_spend_limits as "nope"
}

test_denies_when_price_limit_is_a_string if {
	not spend.allow with input as base with data.vast_spend_limits as {"maxConcurrentInstances": 2, "maxDphPerInstance": "0.2"}
}

# -----------------------------------------------------------------------------
# Both rules can fire at once — the caller sees every reason, not just the first
# -----------------------------------------------------------------------------

test_reports_both_violations_together if {
	msgs := spend.deny with input as {
		"action": "rent",
		"candidate": {"dph_total": 0.99},
		"live_instances": inst(2),
	}
	count(msgs) == 2
	some a in msgs
	startswith(a, "VAST-SPEND-001")
	some b in msgs
	startswith(b, "VAST-SPEND-002")
}

# -----------------------------------------------------------------------------
# The decision object, and proof the gate read real numbers
# -----------------------------------------------------------------------------

test_decision_echoes_the_limits_it_evaluated_against if {
	d := spend.decision with input as base
	d.allow == true
	d.limits_seen.maxConcurrentInstances == 2
	d.limits_seen.maxDphPerInstance == 0.2
}

test_decision_carries_deny_reasons if {
	d := spend.decision with input as object.union(base, {"candidate": {"dph_total": 5}})
	d.allow == false
	count(d.deny) > 0
}

# The checked-in data file must hold the values the operator asked for.
test_shipped_limits_are_two_boxes_and_twenty_cents if {
	data.vast_spend_limits.maxConcurrentInstances == 2
	data.vast_spend_limits.maxDphPerInstance == 0.2
}
