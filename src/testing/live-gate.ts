// src/testing/live-gate.ts
// =============================================================================
// Gate for tests that rent REAL GPUs and spend REAL money.
//
// Why not a path-exclude in vitest.config.ts: `exclude` drops files at
// collection time, so `--testNamePattern=live` matched nothing and the live
// suite exited 0 having run zero tests. Green, and meaningless. Gating INSIDE a
// collected file means the report shows "skipped", which is honest.
//
// Two separate keys are required, deliberately:
//   VAST_LIVE=1          — "yes, run tests that touch the live API"
//   VAST_LIVE_CONFIRM=<t> — "yes, I accept that this RENTS and BILLS"
// One env var is too easy to set in a shell profile and forget.
// =============================================================================
import { describe, expect, it } from "vitest";

export const LIVE_ENABLED = process.env.VAST_LIVE === "1";

/** Token the operator must set to authorize money-spending (rent) tests. */
export const RENT_CONFIRM_TOKEN = "i-accept-gpu-rental-charges";

export const RENT_AUTHORIZED =
  LIVE_ENABLED && process.env.VAST_LIVE_CONFIRM === RENT_CONFIRM_TOKEN;

/**
 * Read-only live tests (GET /users/current/, GET /bundles/). Costs nothing but
 * needs network + credentials. Requires VAST_LIVE=1.
 *
 * Declared as a function rather than `export const … = describe.skipIf(…)`:
 * vitest's suite type references non-exported internals, so a re-exported const
 * trips TS4023 ("cannot be named").
 */
export function describeLive(name: string, fn: () => void): void {
  describe.skipIf(!LIVE_ENABLED)(name, fn);
}

/**
 * Money-spending live tests (rent/destroy). Requires VAST_LIVE=1 AND the
 * explicit confirm token.
 */
export function describeRent(name: string, fn: () => void): void {
  describe.skipIf(!RENT_AUTHORIZED)(name, fn);
}

/**
 * Meta-guard against the exact bug this module exists to prevent: a live run
 * that collects nothing and reports success. Call inside a live file; when
 * VAST_LIVE=1 it asserts the gate really is open, so "0 tests ran" can never be
 * mistaken for "all tests passed".
 */
export function assertLiveSuiteCollected(): void {
  it("live gate is open (guards against a zero-collection green run)", () => {
    expect(LIVE_ENABLED).toBe(true);
  });
}

// Spend ceilings live in src/limits.ts — a module with NO test-framework
// imports, because production code (CLI, reaper) needs them. Re-exported here
// only for convenience inside tests.
export { SPEND_LIMITS } from "../limits.js";
