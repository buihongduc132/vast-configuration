// src/limits.ts
// =============================================================================
// Hard spend ceilings, enforced BEFORE any money-spending API call.
//
// ⚠️ This module must NEVER import from a test framework. It lives here rather
// than beside the test gate because production code (the CLI, the reaper) needs
// it: an earlier version exported these from a vitest-importing module, and the
// CLI died with "Vitest failed to access its internal state" the moment it ran
// outside the test runner. Test-only imports do not belong on a production path.
// =============================================================================

export const SPEND_LIMITS = {
  /** Never hold more than this many rented instances at once. */
  maxConcurrentInstances: 1,
  /** Reject any offer above this hourly price (USD/hr). */
  maxDphTotal: 0.45,
  /** Destroy a rental after this long no matter what. */
  maxLifetimeMinutes: 45,
  /** Refuse to rent when remaining credit is at or below this (USD). */
  minCreditFloorUsd: 5.0,
} as const;

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
 */
export function canRent(args: {
  creditUsd: number;
  dphTotal: number;
  currentInstanceCount: number;
  limits?: typeof SPEND_LIMITS;
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
  if (args.dphTotal > L.maxDphTotal) {
    return {
      allowed: false,
      reason: `offer $${args.dphTotal.toFixed(4)}/hr exceeds the $${L.maxDphTotal}/hr cap`,
    };
  }
  if (args.currentInstanceCount >= L.maxConcurrentInstances) {
    return {
      allowed: false,
      reason: `already holding ${args.currentInstanceCount} instance(s); cap is ${L.maxConcurrentInstances}`,
    };
  }
  return { allowed: true };
}

/** Worst-case cost of a rental that runs to its full permitted lifetime. */
export function maxCostOfRentalUsd(
  dphTotal: number,
  limits: typeof SPEND_LIMITS = SPEND_LIMITS,
): number {
  return (dphTotal * limits.maxLifetimeMinutes) / 60;
}
