import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// =============================================================================
// Producer-proof gate.
//
// A package.json script pointing at a file that is not TRACKED IN GIT is the
// exit-127 crashloop pattern: the path exists on the author's disk, every local
// check passes, and a fresh clone (or `git submodule update --init`) gets a repo
// where the command fails instantly. Git does not track empty directories, so
// scaffolded dirs vanish silently.
//
// `test -f` is NOT proof — it passes on untracked files. `git ls-files` is.
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function trackedFiles(): Set<string> {
  const out = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  return new Set(out.split("\n").filter(Boolean));
}

/** Pull out local file paths a script invokes (e.g. `tsx bin/vast.ts`). */
function scriptFileTargets(command: string): string[] {
  return command
    .split(/\s+/)
    .filter((tok) => /^[\w./-]+\.(ts|js|mjs|cjs|sh|py)$/.test(tok))
    .map((tok) => tok.replace(/^\.\//, ""));
}

describe("every package.json script target is tracked in git", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };

  const tracked = trackedFiles();
  const entries = Object.entries(pkg.scripts ?? {});

  it("has scripts to check", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const [name, command] of entries) {
    const targets = scriptFileTargets(command);
    if (targets.length === 0) continue;

    it(`script "${name}" → ${targets.join(", ")} tracked in git (not just on disk)`, () => {
      for (const t of targets) {
        expect(tracked.has(t), `${t} is referenced by npm script "${name}" but is NOT tracked in git`).toBe(true);
      }
    });
  }
});

describe("setup files referenced by vitest config are tracked", () => {
  it("no-network setup file exists in git", () => {
    expect(trackedFiles().has("src/testing/no-network.ts")).toBe(true);
  });
});

// =============================================================================
// mise tasks were NOT covered by the check above, and they have exactly the same
// failure mode: `mise run vast:gate` invoking an untracked script gives a fresh
// clone an instant non-zero exit. Same gate, second entry point.
// =============================================================================
describe("every mise task target is tracked in git", () => {
  const miseToml = readFileSync(resolve(repoRoot, "mise.toml"), "utf8");
  const tracked = trackedFiles();

  // Paths a task shells out to, e.g. ${VAST_CONFIG_DIR}/scripts/gate-check.sh
  const referenced = [
    ...miseToml.matchAll(/(?:\$\{VAST_CONFIG_DIR\}\/|\.\/)?((?:scripts|bin|src|tests)\/[\w./-]+\.(?:sh|ts|js|py))/g),
  ].map((m) => m[1]!);

  it("finds task file references to check", () => {
    expect(referenced.length).toBeGreaterThan(0);
  });

  for (const target of [...new Set(referenced)]) {
    it(`mise task target ${target} is tracked in git`, () => {
      expect(
        tracked.has(target),
        `${target} is referenced by a mise task but is NOT tracked in git`,
      ).toBe(true);
    });
  }
});

// =============================================================================
// The OPA gate resolves its policy and data by PATH at runtime. If either were
// untracked, a fresh clone would deny every rental with a confusing
// "did not evaluate" error — fail-closed, so not a money leak, but a broken
// repo that looks like a policy problem.
// =============================================================================
describe("policy files the gate loads at runtime are tracked in git", () => {
  const tracked = trackedFiles();

  for (const p of [
    "policies/rego/vast_spend.rego",
    "policies/rego/vast_spend_test.rego",
    "policies/data/spend-limits.json",
    "scripts/gate-check.sh",
  ]) {
    it(`${p} is tracked`, () => {
      expect(tracked.has(p), `${p} must be committed — the gate loads it by path`).toBe(true);
    });
  }

  it("the limits file is the ONLY place the ceilings are written", () => {
    // Guards P14: a second literal copy of the ceiling is a split-brain waiting
    // to drift. src/limits.ts must read the JSON, never restate the numbers.
    const limitsTs = readFileSync(resolve(repoRoot, "src/limits.ts"), "utf8");
    expect(limitsTs).not.toMatch(/maxDphPerInstance\s*[:=]\s*0?\.\d/);
    expect(limitsTs).not.toMatch(/maxConcurrentInstances\s*[:=]\s*\d/);
    expect(limitsTs).toContain("spend-limits.json");
  });
});
