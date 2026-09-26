import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SPEND_LIMITS, canRent, maxCostOfRentalUsd } from "../src/limits.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

describe("spend ceiling is enforced before spending, not after", () => {
  const base = { creditUsd: 99.98, dphTotal: 0.12, currentInstanceCount: 0 };

  it("allows a sane rental", () => {
    expect(canRent(base)).toEqual({ allowed: true });
  });

  it("refuses when credit is at or below the floor", () => {
    for (const credit of [SPEND_LIMITS.minCreditFloorUsd, SPEND_LIMITS.minCreditFloorUsd - 1, 0]) {
      const d = canRent({ ...base, creditUsd: credit });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toContain("floor");
    }
  });

  it("refuses to rent blind when credit is unknown", () => {
    const d = canRent({ ...base, creditUsd: Number.NaN });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain("unknown");
  });

  it("refuses an offer above the hourly cap", () => {
    const d = canRent({ ...base, dphTotal: SPEND_LIMITS.maxDphTotal + 0.01 });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain("cap");
  });

  it("accepts an offer exactly at the cap (boundary is inclusive)", () => {
    expect(canRent({ ...base, dphTotal: SPEND_LIMITS.maxDphTotal }).allowed).toBe(true);
  });

  it("refuses a nonsense price rather than treating it as free", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(canRent({ ...base, dphTotal: bad }).allowed).toBe(false);
    }
  });

  it("refuses when the concurrency cap is already reached", () => {
    const d = canRent({ ...base, currentInstanceCount: SPEND_LIMITS.maxConcurrentInstances });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain("cap is");
  });

  it("bounds the worst case of a single rental", () => {
    // 45 min at $0.45/hr — the most one permitted rental can ever cost.
    expect(maxCostOfRentalUsd(SPEND_LIMITS.maxDphTotal)).toBeCloseTo(0.3375, 4);
    expect(maxCostOfRentalUsd(0.12)).toBeCloseTo(0.09, 4);
  });

  it("keeps ceilings low enough that one rental cannot drain the account", () => {
    // Sanity on the constants themselves, not just the logic.
    expect(maxCostOfRentalUsd(SPEND_LIMITS.maxDphTotal)).toBeLessThan(1);
    expect(SPEND_LIMITS.maxConcurrentInstances).toBeLessThanOrEqual(2);
    expect(SPEND_LIMITS.maxLifetimeMinutes).toBeLessThanOrEqual(120);
  });
});

describe("production modules never import a test framework", () => {
  // Regression guard: SPEND_LIMITS once lived in a vitest-importing module, so
  // `npx tsx bin/vast.ts` died with "Vitest failed to access its internal
  // state". Tests did not catch it — under vitest the import resolves fine.
  // Only an out-of-runner check finds this class of bug.
  const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  const productionFiles = tracked.filter(
    (f) =>
      (f.startsWith("src/") || f.startsWith("bin/")) &&
      f.endsWith(".ts") &&
      !f.startsWith("src/testing/") &&
      !f.endsWith(".test.ts"),
  );

  it("found production files to check", () => {
    expect(productionFiles.length).toBeGreaterThan(0);
  });

  for (const f of productionFiles) {
    it(`${f} does not import vitest`, () => {
      const src = readFileSync(resolve(repoRoot, f), "utf8");
      expect(src).not.toMatch(/from\s+["']vitest["']/);
      expect(src).not.toMatch(/require\(["']vitest["']\)/);
      // Importing the test-gate module pulls vitest in transitively.
      expect(src).not.toMatch(/from\s+["'].*testing\/live-gate/);
    });
  }
});

describe("the CLI actually runs outside the test runner", () => {
  it("bin/vast.ts help exits 0 and prints usage", () => {
    const out = execFileSync("npx", ["tsx", "bin/vast.ts", "help"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(out).toContain("Vast.ai offload management");
    expect(out).toContain("whoami");
  }, 90_000);

  it("refuses money-spending commands instead of half-doing them", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync("npx", ["tsx", "bin/vast.ts", "rent", "qwen"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      status = e.status ?? 0;
      stderr = e.stderr ?? "";
    }
    expect(status).toBe(2);
    expect(stderr).toContain("not implemented");
  }, 90_000);
});
