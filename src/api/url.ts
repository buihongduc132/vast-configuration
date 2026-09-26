// src/api/url.ts
// =============================================================================
// URL construction for the Vast.ai REST API, with the two silent-failure
// footguns encoded as hard rules instead of tribal knowledge.
//
// FOOTGUN 1 — trailing slash. `GET /bundles?q=...` returns 301 and the query
// string is DROPPED on the redirect. The follow-up request then means "give me
// everything", which looks like a successful but wrong answer. So every path
// MUST end in "/".
//
// FOOTGUN 2 — gpu_name spacing. The API stores GPU names with SPACES
// ("RTX 3090"). Passing the underscore form ("RTX_3090") returns HTTP 200 with
// ZERO offers — indistinguishable from "the market is empty" unless you know.
// =============================================================================

export const VAST_API_BASE = "https://console.vast.ai/api/v0";

export class VastUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VastUrlError";
  }
}

/**
 * Normalize an API path so it always has a leading and trailing slash.
 * Throws on an empty path rather than silently producing the base URL.
 */
export function normalizePath(path: string): string {
  if (!path || !path.trim()) {
    throw new VastUrlError("API path must not be empty");
  }
  let p = path.trim();
  if (!p.startsWith("/")) p = `/${p}`;
  // FOOTGUN 1: a missing trailing slash costs you the query string via 301.
  if (!p.endsWith("/")) p = `${p}/`;
  return p;
}

/** True when a path is safe to request (would not 301-and-drop-query). */
export function hasTrailingSlash(path: string): boolean {
  return path.endsWith("/");
}

/**
 * Build a full API URL. `query` values are URL-encoded; the `q` filter object
 * is JSON-encoded first (the API expects a JSON blob in a single query param).
 */
export function buildUrl(
  path: string,
  query?: Record<string, string | number | boolean | object | undefined>,
  base: string = VAST_API_BASE,
): string {
  const url = new URL(`${base}${normalizePath(path)}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    );
  }
  return url.toString();
}

/**
 * FOOTGUN 2: normalize a GPU name to the space form the API actually matches.
 * Accepts the underscore form callers habitually write and converts it, so a
 * typo degrades to a correct query instead of a silent empty result.
 */
export function normalizeGpuName(name: string): string {
  const n = name.trim().replace(/_/g, " ").replace(/\s+/g, " ");
  if (!n) throw new VastUrlError("gpu_name must not be empty");
  return n;
}

/** True when a GPU name is already in the form the API matches (no underscores). */
export function isValidGpuName(name: string): boolean {
  return !name.includes("_") && name.trim().length > 0 && !/\s{2,}/.test(name);
}
