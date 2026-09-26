import { describe, it, expect } from "vitest";
import {
  buildUrl,
  normalizePath,
  hasTrailingSlash,
  normalizeGpuName,
  isValidGpuName,
  VastUrlError,
  VAST_API_BASE,
} from "../src/api/url.js";

// These tests encode two VERIFIED live-API footguns. They are regression
// guards, not style preferences — each one maps to an observed silent failure.

describe("trailing slash (footgun 1: 301 drops the query string)", () => {
  it("adds a trailing slash when missing", () => {
    expect(normalizePath("/bundles")).toBe("/bundles/");
  });

  it("keeps an existing trailing slash", () => {
    expect(normalizePath("/bundles/")).toBe("/bundles/");
  });

  it("adds a leading slash when missing", () => {
    expect(normalizePath("instances")).toBe("/instances/");
  });

  it("rejects an empty path instead of silently hitting the base URL", () => {
    expect(() => normalizePath("")).toThrow(VastUrlError);
    expect(() => normalizePath("   ")).toThrow(VastUrlError);
  });

  it("every built URL ends its path with a slash", () => {
    for (const p of ["/bundles", "/instances", "users/current"]) {
      const u = new URL(buildUrl(p));
      expect(hasTrailingSlash(u.pathname)).toBe(true);
    }
  });

  it("preserves the query string on a slash-normalized path", () => {
    const url = buildUrl("/bundles", { q: { rentable: { eq: true } } });
    expect(url).toContain("/bundles/?");
    expect(url).toContain("q=");
    expect(decodeURIComponent(url)).toContain('{"rentable":{"eq":true}}');
  });
});

describe("gpu_name spacing (footgun 2: underscore form returns 0 offers, HTTP 200)", () => {
  it("converts the underscore form to the space form the API matches", () => {
    expect(normalizeGpuName("RTX_3090")).toBe("RTX 3090");
    expect(normalizeGpuName("RTX_4090")).toBe("RTX 4090");
    expect(normalizeGpuName("RTX_5060_Ti")).toBe("RTX 5060 Ti");
  });

  it("leaves an already-correct name untouched", () => {
    expect(normalizeGpuName("RTX 3090")).toBe("RTX 3090");
  });

  it("collapses accidental double spaces", () => {
    expect(normalizeGpuName("RTX  3090")).toBe("RTX 3090");
  });

  it("rejects an empty name", () => {
    expect(() => normalizeGpuName("  ")).toThrow(VastUrlError);
  });

  it("flags the underscore form as invalid so callers can be linted", () => {
    expect(isValidGpuName("RTX_3090")).toBe(false);
    expect(isValidGpuName("RTX 3090")).toBe(true);
  });
});

describe("base URL", () => {
  it("targets the v0 API on console.vast.ai", () => {
    expect(VAST_API_BASE).toBe("https://console.vast.ai/api/v0");
  });

  it("builds an absolute https URL", () => {
    expect(buildUrl("/users/current")).toBe(
      "https://console.vast.ai/api/v0/users/current/",
    );
  });
});
