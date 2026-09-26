// src/testing/no-network.ts
// =============================================================================
// Turns "the default test suite costs $0 and needs no network" from a claim in
// a doc into an enforced gate.
//
// Without this, ONE `fetch` in a future test — or a fixture loader that falls
// back to a live call when a file is missing — silently converts the default
// suite into a money-spending suite. The failure is invisible: the test passes.
//
// Active unless VAST_LIVE=1. Live tests opt in explicitly.
// =============================================================================
import { beforeAll, afterAll } from "vitest";

const LIVE = process.env.VAST_LIVE === "1";

export class NetworkBlockedError extends Error {
  constructor(url: string) {
    super(
      `Network access blocked in the offline test suite (attempted: ${url}).\n` +
        `The default suite must run with no network and no credentials.\n` +
        `If this test genuinely needs the live API, put it under tests/live/ and\n` +
        `wrap it in describeLive() — which requires VAST_LIVE=1.`,
    );
    this.name = "NetworkBlockedError";
  }
}

const realFetch = globalThis.fetch;

beforeAll(() => {
  if (LIVE) return;
  globalThis.fetch = ((input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : ((input as { url?: string })?.url ?? String(input));
    throw new NetworkBlockedError(url);
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  if (LIVE) return;
  globalThis.fetch = realFetch;
});
