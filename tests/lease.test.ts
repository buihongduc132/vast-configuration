import { describe, it, expect } from "vitest";
import {
  buildLeaseLabel,
  isOurLabel,
  makeLeaseIntent,
  isExpired,
  accruedCostUsd,
  decideReaps,
  LEASE_LABEL_PREFIX,
  type Lease,
} from "../src/instances/lease.js";

const T0 = 1_790_000_000_000;

function lease(over: Partial<Lease> = {}): Lease {
  return {
    instanceId: 111,
    label: buildLeaseLabel("embedding", "test", T0),
    workload: "embedding",
    offerId: 999,
    dphTotal: 0.12,
    createdAtMs: T0,
    expiresAtMs: T0 + 45 * 60_000,
    owner: "test",
    ...over,
  };
}

describe("lease labels", () => {
  it("prefixes every label so a reaper can find orphans with no state at all", () => {
    expect(buildLeaseLabel("qwen", "ci", T0).startsWith(`${LEASE_LABEL_PREFIX}--`)).toBe(true);
  });

  it("encodes workload and owner for human triage", () => {
    const l = buildLeaseLabel("qwen", "agy", T0);
    expect(l).toContain("qwen");
    expect(l).toContain("agy");
  });

  it("sanitizes owner so the label stays API-safe", () => {
    expect(buildLeaseLabel("qwen", "a b/c:d", T0)).not.toMatch(/[ /:]/);
  });

  it("recognizes our labels and rejects foreign ones", () => {
    expect(isOurLabel(buildLeaseLabel("qwen", "x", T0))).toBe(true);
    expect(isOurLabel("someone-elses-box")).toBe(false);
    expect(isOurLabel(null)).toBe(false);
    expect(isOurLabel(undefined)).toBe(false);
    expect(isOurLabel("")).toBe(false);
  });
});

describe("lease intent", () => {
  it("sets a hard expiry from maxLifetimeMinutes", () => {
    const i = makeLeaseIntent({
      workload: "qwen", offerId: 1, dphTotal: 0.2, owner: "t",
      maxLifetimeMinutes: 30, nowMs: T0,
    });
    expect(i.expiresAtMs).toBe(T0 + 30 * 60_000);
  });

  it("refuses a non-positive lifetime — an unbounded lease is an unbounded bill", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        makeLeaseIntent({
          workload: "qwen", offerId: 1, dphTotal: 0.2, owner: "t",
          maxLifetimeMinutes: bad, nowMs: T0,
        }),
      ).toThrow();
    }
  });
});

describe("expiry + cost", () => {
  it("is not expired before the deadline and is expired at/after it", () => {
    const l = lease();
    expect(isExpired(l, T0)).toBe(false);
    expect(isExpired(l, l.expiresAtMs - 1)).toBe(false);
    expect(isExpired(l, l.expiresAtMs)).toBe(true);
    expect(isExpired(l, l.expiresAtMs + 60_000)).toBe(true);
  });

  it("derives cost from wall-clock lifetime (the balance API lags, this does not)", () => {
    const l = lease({ dphTotal: 0.12 });
    expect(accruedCostUsd(l, T0)).toBe(0);
    expect(accruedCostUsd(l, T0 + 3_600_000)).toBeCloseTo(0.12, 6);
    expect(accruedCostUsd(l, T0 + 1_800_000)).toBeCloseTo(0.06, 6);
  });

  it("handles price drift: reads dph_total from INSTANCE object, not from offer search", () => {
    // Search said $0.1489/hr; live instance reported $0.1578
    const l = lease({ dphTotal: 0.1489 });
    const liveInstance = { dph_total: 0.1578 };

    // With live instance provided, 1 hour cost must be $0.1578, NOT $0.1489
    const cost = accruedCostUsd(l, T0 + 3_600_000, liveInstance);
    expect(cost).toBeCloseTo(0.1578, 6);

    // Third box reported $0.1711
    const liveInstance3 = { dph_total: 0.1711 };
    expect(accruedCostUsd(l, T0 + 3_600_000, liveInstance3)).toBeCloseTo(0.1711, 6);
  });

  it("calculates cost directly from live instance object with start_date and dph_total", () => {
    const liveInstance = {
      start_date: T0 / 1000,
      dph_total: 0.1578,
    };
    expect(accruedCostUsd(liveInstance, T0 + 3_600_000)).toBeCloseTo(0.1578, 6);
  });

  it("never reports negative cost when clocks go backwards", () => {
    expect(accruedCostUsd(lease(), T0 - 60_000)).toBe(0);
  });
});

describe("reaper decisions (bounded blast radius)", () => {
  it("NEVER touches an instance we did not label — a human's box is not ours to kill", () => {
    const decisions = decideReaps({
      live: [
        { id: 52783772, label: null },
        { id: 52783773, label: "my-own-desktop" },
      ],
      declared: [],
      nowMs: T0,
    });
    expect(decisions).toEqual([]);
  });

  it("reaps our instance that is live but undeclared (crashed before recording)", () => {
    const decisions = decideReaps({
      live: [{ id: 222, label: buildLeaseLabel("qwen", "dead-run", T0) }],
      declared: [],
      nowMs: T0,
    });
    expect(decisions).toEqual([{ instanceId: 222, reason: "undeclared" }]);
  });

  it("reaps our instance past its hard deadline", () => {
    const l = lease({ instanceId: 333 });
    const decisions = decideReaps({
      live: [{ id: 333, label: l.label }],
      declared: [l],
      nowMs: l.expiresAtMs + 1,
    });
    expect(decisions).toEqual([{ instanceId: 333, reason: "expired" }]);
  });

  it("leaves a declared, in-window instance alone", () => {
    const l = lease({ instanceId: 444 });
    expect(
      decideReaps({ live: [{ id: 444, label: l.label }], declared: [l], nowMs: T0 + 60_000 }),
    ).toEqual([]);
  });

  it("handles a declared lease whose instance is already gone (no crash, no decision)", () => {
    expect(decideReaps({ live: [], declared: [lease({ instanceId: 555 })], nowMs: T0 })).toEqual([]);
  });
});
