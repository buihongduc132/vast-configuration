// tests/policy-gate.test.ts
// =============================================================================
// Tests the OPA rental admission gate END TO END, by running the real `opa`
// binary against the real policy files. Mocked-only tests would not have caught
// either fail-open trap documented in vast_spend.rego, because both live in the
// interaction between the policy text and OPA's actual evaluation semantics.
//
// `opa` is a HARD DEPENDENCY. These tests fail loudly if it is missing rather
// than skipping: a silently-skipped gate test is indistinguishable from a gate
// that works, which is the exact failure class this file exists to prevent.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateRentGate,
  assertRentAllowed,
  PolicyGateError,
  POLICY_REGO_DIR,
  POLICY_DATA_DIR,
  opaBinary,
  type GateInput,
} from "../src/policy/gate.js";
import { SPEND_LIMITS, canRent } from "../src/limits.js";

const CHEAP = SPEND_LIMITS.maxDphPerInstance - 0.08;

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    action: "rent",
    candidate: { id: 1, dph_total: CHEAP, machine_id: 42 },
    live_instances: [],
    ...over,
  } as GateInput;
}

/** n opaque instances — the policy only ever counts them. */
function instances(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ id: 1000 + i }));
}

describe("opa is present", () => {
  it("is installed and runnable, because the gate cannot work without it", () => {
    const v = execFileSync(opaBinary(), ["version"], { encoding: "utf8" });
    expect(v).toMatch(/Version/i);
  });
});

describe("VAST-SPEND-002 — strictly under $0.20/hr per instance", () => {
  it("allows a cheap offer with nothing running", async () => {
    const v = await evaluateRentGate(input());
    expect(v.allow).toBe(true);
    expect(v.deny).toEqual([]);
  });

  it("allows just under the cap", async () => {
    const v = await evaluateRentGate(
      input({ candidate: { dph_total: SPEND_LIMITS.maxDphPerInstance - 0.0001 } }),
    );
    expect(v.allow).toBe(true);
  });

  it("DENIES exactly at the cap", async () => {
    const v = await evaluateRentGate(
      input({ candidate: { dph_total: SPEND_LIMITS.maxDphPerInstance } }),
    );
    expect(v.allow).toBe(false);
    expect(v.deny.join()).toContain("VAST-SPEND-002");
  });

  it("denies above the cap", async () => {
    const v = await evaluateRentGate(input({ candidate: { dph_total: 0.25 } }));
    expect(v.allow).toBe(false);
    expect(v.deny.join()).toContain("VAST-SPEND-002");
  });

  it("denies a non-positive price rather than reading it as free", async () => {
    for (const bad of [0, -1]) {
      const v = await evaluateRentGate(input({ candidate: { dph_total: bad } }));
      expect(v.allow).toBe(false);
    }
  });
});

describe("VAST-SPEND-001 — at most 2 concurrent instances", () => {
  it("allows a first rental", async () => {
    expect((await evaluateRentGate(input({ live_instances: [] }))).allow).toBe(true);
  });

  it("allows a second rental", async () => {
    expect((await evaluateRentGate(input({ live_instances: instances(1) }))).allow).toBe(true);
  });

  it("DENIES a third rental", async () => {
    const v = await evaluateRentGate(input({ live_instances: instances(2) }));
    expect(v.allow).toBe(false);
    expect(v.deny.join()).toContain("VAST-SPEND-001");
  });

  it("denies when already over the cap", async () => {
    expect((await evaluateRentGate(input({ live_instances: instances(5) }))).allow).toBe(false);
  });

  it("counts FOREIGN instances too — they bill the same card", async () => {
    const foreign = [{ id: 1, label: null }, { id: 2, label: null }];
    const v = await evaluateRentGate(input({ live_instances: foreign }));
    expect(v.allow).toBe(false);
    expect(v.deny.join()).toContain("VAST-SPEND-001");
  });
});

// -----------------------------------------------------------------------------
// TRAP 1 — the unloaded data document, in its real form
// -----------------------------------------------------------------------------
describe("fail-open trap 1: policy evaluated with no limits document", () => {
  // An EMPTY BUT EXISTING directory is the trap's real shape: opa loads happily,
  // exits 0, and evaluates the policy against no limits at all. (A *nonexistent*
  // path is a different, louder failure — opa exits 2 — covered separately below.)
  let emptyDir: string;
  beforeAll(() => {
    emptyDir = mkdtempSync(join(tmpdir(), "vast-no-limits-"));
  });
  afterAll(() => {
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("DENIES when no limits document is loaded, even though opa exits 0", async () => {
    // Measured 2026-09-27: exit 0, empty deny set from a naive policy. This is
    // exactly how $9.99/hr passed a first-draft gate.
    const v = await evaluateRentGate(input({ candidate: { dph_total: 9.99 } }), {
      dataDir: emptyDir,
    });
    expect(v.allow).toBe(false);
    expect(v.deny.join()).toContain("VAST-SPEND-000");
  });

  it("DENIES a would-be-legal offer when limits are absent — silence is not approval", async () => {
    const v = await evaluateRentGate(input(), { dataDir: emptyDir });
    expect(v.allow).toBe(false);
  });

  it("surfaces an error marker in limits_seen when the document is missing", async () => {
    const v = await evaluateRentGate(input(), { dataDir: emptyDir });
    expect(typeof v.limitsSeen?.error).toBe("string");
  });

  it("reports which limits it read, so a caller can prove the gate saw real numbers", async () => {
    const v = await evaluateRentGate(input());
    expect(v.limitsSeen?.maxConcurrentInstances).toBe(2);
    expect(v.limitsSeen?.maxDphPerInstance).toBe(0.2);
  });

  it("also denies when the limits path is missing outright (opa exits 2)", async () => {
    await expect(
      assertRentAllowed(input(), { dataDir: "/nonexistent-on-purpose" }),
    ).rejects.toThrow(PolicyGateError);
  });
});

// -----------------------------------------------------------------------------
// TRAP 2 — `not is_number(<bare ref>)` does not fire on an ABSENT key.
// These inputs are the ones the first draft of the policy waved through.
// -----------------------------------------------------------------------------
describe("fail-open trap 2: absent input fields, not merely wrong-typed ones", () => {
  it("DENIES when dph_total is absent entirely", async () => {
    const v = await evaluateRentGate({
      action: "rent",
      candidate: { id: 7 },
      live_instances: [],
    } as unknown as GateInput);
    expect(v.allow).toBe(false);
    expect(v.deny.join()).toContain("VAST-SPEND-000");
  });

  it("DENIES when candidate is absent entirely", async () => {
    const v = await evaluateRentGate({
      action: "rent",
      live_instances: [],
    } as unknown as GateInput);
    expect(v.allow).toBe(false);
  });

  it("DENIES when live_instances is absent entirely", async () => {
    const v = await evaluateRentGate({
      action: "rent",
      candidate: { dph_total: CHEAP },
    } as unknown as GateInput);
    expect(v.allow).toBe(false);
    expect(v.deny.join()).toContain("live_instances");
  });

  it("DENIES a wholly empty input", async () => {
    const v = await evaluateRentGate({} as unknown as GateInput);
    expect(v.allow).toBe(false);
  });

  it("denies a price given as a string", async () => {
    const v = await evaluateRentGate(
      input({ candidate: { dph_total: "0.12" } } as unknown as Partial<GateInput>),
    );
    expect(v.allow).toBe(false);
  });

  it("DENIES a scalar instance count — a caller must not be able to understate concurrency", async () => {
    const v = await evaluateRentGate(
      input({ live_instances: 0 } as unknown as Partial<GateInput>),
    );
    expect(v.allow).toBe(false);
    expect(v.deny.join()).toContain("must be an array");
  });
});

// -----------------------------------------------------------------------------
// No verdict obtainable => deny. Every one of these is a dollars-denominated
// failure mode, so none of them may resolve to "allowed".
// -----------------------------------------------------------------------------
describe("no verdict is a denial, never an approval", () => {
  it("denies when the opa binary does not exist", async () => {
    await expect(
      assertRentAllowed(input(), { binary: "/nonexistent/opa-binary" }),
    ).rejects.toThrow(PolicyGateError);
  });

  it("denies when the policy dir has no policy in it", async () => {
    await expect(assertRentAllowed(input(), { regoDir: "/nonexistent-rego" })).rejects.toThrow(
      PolicyGateError,
    );
  });

  it("denies when the query names a rule that does not exist", async () => {
    await expect(
      assertRentAllowed(input(), { query: "data.vast.spend.no_such_rule" }),
    ).rejects.toThrow(PolicyGateError);
  });

  it("denies on a non-zero exit", async () => {
    await expect(
      evaluateRentGate(input(), {
        runner: async () => ({ code: 1, signal: null, stdout: "", stderr: "boom" }),
      }),
    ).rejects.toThrow(/exited 1/);
  });

  it("denies when the process is killed by a signal", async () => {
    await expect(
      evaluateRentGate(input(), {
        runner: async () => ({ code: null, signal: "SIGKILL", stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow(/SIGKILL/);
  });

  it("denies when stdout is not JSON", async () => {
    await expect(
      evaluateRentGate(input(), {
        runner: async () => ({ code: 0, signal: null, stdout: "not json", stderr: "" }),
      }),
    ).rejects.toThrow(/not JSON/);
  });

  it("denies when the result set is empty (the undefined-document shape)", async () => {
    await expect(
      evaluateRentGate(input(), {
        runner: async () => ({ code: 0, signal: null, stdout: '{"result":[]}', stderr: "" }),
      }),
    ).rejects.toThrow(/did not evaluate|undefined/);
  });

  it("denies when allow is truthy but not exactly true", async () => {
    for (const sneaky of ['"yes"', "1", "{}", "[]"]) {
      const v = await evaluateRentGate(input(), {
        runner: async () => ({
          code: 0,
          signal: null,
          stdout: JSON.stringify({
            result: [
              {
                expressions: [
                  {
                    value: {
                      allow: JSON.parse(sneaky),
                      deny: [],
                      limits_seen: { maxConcurrentInstances: 2, maxDphPerInstance: 0.2 },
                    },
                  },
                ],
              },
            ],
          }),
          stderr: "",
        }),
      });
      expect(v.allow).toBe(false);
    }
  });

  it("denies when allow is true but the policy read no limits (defence in depth)", async () => {
    const v = await evaluateRentGate(input(), {
      runner: async () => ({
        code: 0,
        signal: null,
        stdout: JSON.stringify({
          result: [
            {
              expressions: [
                { value: { allow: true, deny: [], limits_seen: { error: "absent" } } },
              ],
            },
          ],
        }),
        stderr: "",
      }),
    });
    expect(v.allow).toBe(false);
    expect(v.deny.join()).toContain("VAST-SPEND-000");
  });

  it("denies when allow is true alongside a non-empty deny set", async () => {
    const v = await evaluateRentGate(input(), {
      runner: async () => ({
        code: 0,
        signal: null,
        stdout: JSON.stringify({
          result: [
            {
              expressions: [
                {
                  value: {
                    allow: true,
                    deny: ["VAST-SPEND-001: something"],
                    limits_seen: { maxConcurrentInstances: 2, maxDphPerInstance: 0.2 },
                  },
                },
              ],
            },
          ],
        }),
        stderr: "",
      }),
    });
    expect(v.allow).toBe(false);
  });

  it("assertRentAllowed resolves on a real allow and names reasons on a real deny", async () => {
    await expect(assertRentAllowed(input())).resolves.toMatchObject({ allow: true });
    await expect(
      assertRentAllowed(input({ candidate: { dph_total: 0.9 } })),
    ).rejects.toThrow(/VAST-SPEND-002/);
  });
});

// -----------------------------------------------------------------------------
// The two enforcement layers must not disagree. If they do, one of them is
// theatre — and it would be the fast local one people actually read.
// -----------------------------------------------------------------------------
describe("Rego and canRent() agree on every boundary", () => {
  const prices = [0.01, 0.05, 0.1, 0.1999, 0.2, 0.2001, 0.25, 0.45, 1.0];
  const counts = [0, 1, 2, 3];

  it.each(prices)("price $%s: same verdict from both layers", async (price) => {
    const rego = await evaluateRentGate(input({ candidate: { dph_total: price } }));
    const local = canRent({ creditUsd: 99, dphTotal: price, currentInstanceCount: 0 });
    expect(rego.allow).toBe(local.allowed);
  });

  it.each(counts)("instance count %i: same verdict from both layers", async (n) => {
    const rego = await evaluateRentGate(input({ live_instances: instances(n) }));
    const local = canRent({ creditUsd: 99, dphTotal: CHEAP, currentInstanceCount: n });
    expect(rego.allow).toBe(local.allowed);
  });

  it("both refuse the operator's exact stated boundary: $0.20 is not under $0.20", async () => {
    expect((await evaluateRentGate(input({ candidate: { dph_total: 0.2 } }))).allow).toBe(false);
    expect(canRent({ creditUsd: 99, dphTotal: 0.2, currentInstanceCount: 0 }).allowed).toBe(false);
  });

  it("both refuse a 3rd box", async () => {
    expect((await evaluateRentGate(input({ live_instances: instances(2) }))).allow).toBe(false);
    expect(canRent({ creditUsd: 99, dphTotal: CHEAP, currentInstanceCount: 2 }).allowed).toBe(
      false,
    );
  });
});
