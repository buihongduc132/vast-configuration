// src/limits.ts
// =============================================================================
// Hard spend ceilings, enforced BEFORE any money-spending API call.
//
// The numbers are NOT written here. They live in policies/data/spend-limits.json
// and are read at module load, because the OPA policy reads that same file
// (P14: correlated values defined once). Two readers, one file, no drift. A
// second copy of "0.2" in this module would be a split-brain waiting to happen.
//
// ⚠️ This module must NEVER import from a test framework. Production code (the
// CLI, the reaper) needs it: an earlier version exported these from a
// vitest-importing module and the CLI died with "Vitest failed to access its
// internal state" the moment it ran outside the test runner.
//
// ⚠️ Fail-closed at load. A missing or malformed limits file THROWS. It does not
// fall back to a built-in default — a silent default is how you end up renting
// against a ceiling nobody set.
// =============================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class SpendLimitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendLimitsError";
  }
}

export interface SpendLimits {
  /** Never hold more than this many rented instances at once (whole account). */
  readonly maxConcurrentInstances: number;
  /**
   * Reject any offer at or above this hourly price (USD/hr), per instance.
   * STRICTLY under: an offer at exactly this price is refused.
   */
  readonly maxDphPerInstance: number;
  /** Destroy a rental after this long no matter what. */
  readonly maxLifetimeMinutes: number;
  /** Refuse to rent when remaining credit is at or below this (USD). */
  readonly minCreditFloorUsd: number;
}

/** Absolute path to the one file that defines the ceilings. */
export const SPEND_LIMITS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "policies",
  "data",
  "spend-limits.json",
);

/** The wrapper key inside that file — also its OPA mount path (`data.<this>`). */
export const SPEND_LIMITS_DATA_KEY = "vast_spend_limits";

const REQUIRED_KEYS = [
  "maxConcurrentInstances",
  "maxDphPerInstance",
  "maxLifetimeMinutes",
  "minCreditFloorUsd",
] as const;

function loadSpendLimits(path: string = SPEND_LIMITS_PATH): SpendLimits {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new SpendLimitsError(
      `cannot read spend limits at ${path}: ${(err as Error).message} — refusing to rent against an unknown ceiling`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SpendLimitsError(`spend limits at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpendLimitsError(`spend limits at ${path} must be a JSON object`);
  }

  const doc = (parsed as Record<string, unknown>)[SPEND_LIMITS_DATA_KEY];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new SpendLimitsError(
      `spend limits at ${path} must contain an object under "${SPEND_LIMITS_DATA_KEY}" (that key is the OPA mount path)`,
    );
  }

  const obj = doc as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of REQUIRED_KEYS) {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new SpendLimitsError(
        `spend limits at ${path}: "${key}" must be a finite positive number, got ${JSON.stringify(v)}`,
      );
    }
    out[key] = v;
  }

  return Object.freeze(out as unknown as SpendLimits);
}

/** The live ceilings, loaded from the single source at module load. */
export const SPEND_LIMITS: SpendLimits = loadSpendLimits();

/** Exposed for tests that need to check the loader's own failure modes. */
export const __loadSpendLimitsForTest = loadSpendLimits;

export interface RentRefusal {
  readonly allowed: false;
  readonly reason: string;
}
export interface RentApproval {
  readonly allowed: true;
}
export type RentDecision = RentRefusal | RentApproval;

/**
 * Decide whether a rent is permitted. Deterministic, side-effect free, and
 * checked BEFORE the API call — a ceiling enforced after renting is not a
 * ceiling. Every refusal names its reason so the audit log is meaningful.
 *
 * This mirrors policies/rego/vast_spend.rego. The Rego gate is authoritative;
 * this exists as defence in depth and for a fast local answer. A test asserts
 * the two agree on every boundary.
 */
export function canRent(args: {
  creditUsd: number;
  dphTotal: number;
  currentInstanceCount: number;
  limits?: SpendLimits;
}): RentDecision {
  const L = args.limits ?? SPEND_LIMITS;

  if (!Number.isFinite(args.creditUsd)) {
    return { allowed: false, reason: "credit is unknown — refusing to rent blind" };
  }
  if (args.creditUsd <= L.minCreditFloorUsd) {
    return {
      allowed: false,
      reason: `credit $${args.creditUsd.toFixed(2)} is at or below the $${L.minCreditFloorUsd.toFixed(2)} floor`,
    };
  }
  if (!Number.isFinite(args.dphTotal) || args.dphTotal <= 0) {
    return { allowed: false, reason: "offer price is unknown or non-positive" };
  }
  // STRICTLY under the cap: exactly at the cap is refused (VAST-SPEND-002).
  if (args.dphTotal >= L.maxDphPerInstance) {
    return {
      allowed: false,
      reason: `offer $${args.dphTotal.toFixed(4)}/hr is not strictly under the $${L.maxDphPerInstance}/hr per-instance cap`,
    };
  }
  if (!Number.isFinite(args.currentInstanceCount) || args.currentInstanceCount < 0) {
    return { allowed: false, reason: "current instance count is unknown — refusing to rent blind" };
  }
  if (args.currentInstanceCount >= L.maxConcurrentInstances) {
    return {
      allowed: false,
      reason: `already holding ${args.currentInstanceCount} instance(s); cap is ${L.maxConcurrentInstances} concurrent`,
    };
  }
  return { allowed: true };
}

/** Worst-case cost of a rental that runs to its full permitted lifetime. */
export function maxCostOfRentalUsd(
  dphTotal: number,
  limits: SpendLimits = SPEND_LIMITS,
): number {
  return (dphTotal * limits.maxLifetimeMinutes) / 60;
}

/** Worst-case cost of a full complement of rentals running to their lifetime. */
export function maxConcurrentCostUsd(limits: SpendLimits = SPEND_LIMITS): number {
  return (
    (limits.maxDphPerInstance * limits.maxConcurrentInstances * limits.maxLifetimeMinutes) / 60
  );
}
