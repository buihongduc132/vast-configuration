import { defineConfig } from "vitest/config";

// Default run: offline, $0, no live rental. Live tests are opt-in via VAST_LIVE=1
// and are named "live ..." so `--testNamePattern=live` selects them.
export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    watch: false,
    // Live tests rent real GPUs and cost real money — never let them run by
    // accident in the default suite.
    exclude: ["node_modules/**", "dist/**", "tests/live/**"],
  },
});
