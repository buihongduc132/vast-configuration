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
