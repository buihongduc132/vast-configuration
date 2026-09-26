import { it, expect } from "vitest";
import { describeLive, LIVE_ENABLED, SPEND_LIMITS } from "../../src/testing/live-gate.js";
import { buildUrl, normalizeGpuName } from "../../src/api/url.js";
import { execFileSync } from "node:child_process";

// =============================================================================
// READ-ONLY live tests. Needs network + credentials. Rents nothing, costs $0.
//
// This file is COLLECTED even when the gate is closed, so the report shows
// "skipped" rather than silently running zero tests. The earlier config
// path-excluded tests/live/**, which made `--testNamePattern=live` collect
// nothing and exit 0 — a green run that proved nothing.
// =============================================================================

// Meta-guard: if someone runs the live suite, this proves the gate really opened.
it("live gate reflects VAST_LIVE (guards against a zero-collection green run)", () => {
  expect(LIVE_ENABLED).toBe(process.env.VAST_LIVE === "1");
});

/** Key via env or Consul — never interpolated into a command line. */
function apiKey(): string {
  const fromEnv = process.env.VAST_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return execFileSync("consul", ["kv", "get", "creds/vast/api_key"], {
    encoding: "utf8",
  }).trim();
}

async function get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
  const res = await fetch(
    buildUrl(path, query as Record<string, string | number | boolean | object>),
    { headers: { Authorization: `Bearer ${apiKey()}`, Accept: "application/json" } },
  );
  expect(res.ok, `HTTP ${res.status} from ${path}`).toBe(true);
  return (await res.json()) as T;
}

describeLive("live: account (read-only, $0)", () => {
  it("authenticates and reports credit", async () => {
    const u = await get<Record<string, unknown>>("/users/current");
    expect(typeof u.id).toBe("number");
    expect(u.can_pay).toBe(true);
    // Not asserting an exact credit figure — it changes. Asserting the shape and
    // that we are above the floor where renting must be refused.
    expect(typeof u.credit).toBe("number");
    expect(Number(u.credit)).toBeGreaterThan(SPEND_LIMITS.minCreditFloorUsd);
  }, 30_000);

  it("FOOTGUN: an invalid key returns 404 + auth_error body, NOT 401/403", async () => {
    // Verified 2026-09-27. This breaks the obvious implementation: code that
    // classifies auth failure by status (401/403) sees a 404 and may treat it as
    // "not found" — i.e. retry it, or worse, read it as an empty result. The
    // discriminator is the BODY (`error: "auth_error"`), not the status.
    const res = await fetch(buildUrl("/users/current"), {
      headers: { Authorization: "Bearer definitely-not-a-valid-key" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("auth_error");
  }, 30_000);

  it("a MISSING auth header returns 403 (different path from an invalid key)", async () => {
    const res = await fetch(buildUrl("/users/current"));
    expect(res.status).toBe(403);
  }, 30_000);
});

describeLive("live: offer search footguns (read-only, $0)", () => {
  it("space-form gpu_name returns offers", async () => {
    const r = await get<{ offers?: unknown[] }>("/bundles", {
      q: {
        gpu_name: { eq: normalizeGpuName("RTX 3090") },
        rentable: { eq: true },
        num_gpus: { eq: 1 },
        limit: 3,
        type: "on-demand",
        order: [["dph_total", "asc"]],
      },
    });
    expect(Array.isArray(r.offers)).toBe(true);
    expect((r.offers ?? []).length).toBeGreaterThan(0);
  }, 45_000);

  it("underscore-form gpu_name returns ZERO offers with HTTP 200 — the silent-empty footgun", async () => {
    // Bypasses normalizeGpuName deliberately to prove the footgun is real and
    // that normalization is load-bearing, not decorative.
    const r = await get<{ offers?: unknown[] }>("/bundles", {
      q: {
        gpu_name: { eq: "RTX_3090" },
        rentable: { eq: true },
        num_gpus: { eq: 1 },
        limit: 3,
        type: "on-demand",
      },
    });
    expect(r.offers ?? []).toHaveLength(0);
  }, 45_000);

  it("offers carry storage_cost — a second billing dimension beyond dph_total", async () => {
    const r = await get<{ offers?: Array<Record<string, unknown>> }>("/bundles", {
      q: {
        gpu_name: { eq: "RTX 3090" },
        rentable: { eq: true },
        num_gpus: { eq: 1 },
        limit: 1,
        type: "on-demand",
        order: [["dph_total", "asc"]],
      },
    });
    const first = (r.offers ?? [])[0];
    expect(first).toBeDefined();
    expect(first).toHaveProperty("storage_cost");
  }, 45_000);
});

describeLive("live: rentals inventory (read-only, $0)", () => {
  it("lists instances as an array (never treats a non-list as 'clean')", async () => {
    const r = await get<{ instances?: unknown[] }>("/instances");
    // A teardown check that reads "falsy = clean" is one API quirk away from
    // reporting success while instances bill. Assert the SHAPE.
    expect(Array.isArray(r.instances)).toBe(true);
  }, 30_000);
});
