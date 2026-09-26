import { defineConfig } from "vitest/config";

// Default run: offline, $0, no live rental.
//
// ⚠️ DO NOT path-exclude tests/live/** here. That was the original design and it
// was BROKEN: `exclude` is applied at file-collection time, while
// `--testNamePattern` only filters WITHIN already-collected files. So
// `vitest run --testNamePattern=live` collected nothing and exited 0 — the
// opt-in live suite reported green while running zero tests. A "proof" artifact
// from that run proves nothing.
//
// Live tests are therefore COLLECTED always and GATED INSIDE the file via
// `describeLive` (src/testing/live-gate.ts), which uses describe.skipIf on
// VAST_LIVE. Skipped-but-collected is visible in the report; excluded is not.
export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    watch: false,
    exclude: ["node_modules/**", "dist/**"],
    // Live tests rent real GPUs and wait on multi-minute cold starts. The 5s
    // default would SIGKILL the worker mid-rental, skipping the teardown
    // `finally` and leaking a billed instance. Per-test timeouts still apply;
    // this is the floor.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Blocks accidental network egress in the default suite (see setup file).
    setupFiles: ["src/testing/no-network.ts"],
  },
});
