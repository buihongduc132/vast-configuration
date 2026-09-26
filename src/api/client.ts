// src/api/client.ts
// =============================================================================
// Typed REST client for the Vast.ai API.
//
// CRITICAL FOOTGUN: an INVALID key returns HTTP 404 with
//   {"success":false,"error":"auth_error"}
// NOT 401 or 403. A missing header returns 403.
// Status code ALONE cannot classify auth failure — we must inspect the BODY.
// Auth errors must fail loudly and immediately (never retried).
//
// Retries are bounded and only apply to transient 429/5xx responses.
// The API key is NEVER logged or interpolated into errors.
// =============================================================================

import { buildUrl } from "./url.js";

export class VastApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body?: unknown;

  constructor(message: string, status: number, path: string, body?: unknown) {
    super(message);
    this.name = "VastApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class VastAuthError extends VastApiError {
  constructor(message: string, status: number, path: string, body?: unknown) {
    super(message, status, path, body);
    this.name = "VastAuthError";
  }
}

export type ExecFileRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecRunner: ExecFileRunner = async (file, args) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile)(file, args as string[], { encoding: "utf8" });
};

/** Read the key WITHOUT ever putting it on a command line or logging it. */
export async function resolveApiKey(options?: {
  env?: Record<string, string | undefined>;
  execRunner?: ExecFileRunner;
}): Promise<string> {
  const env = options?.env ?? process.env;
  const fromEnv = env.VAST_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const runner = options?.execRunner ?? defaultExecRunner;
  try {
    const { stdout } = await runner("consul", ["kv", "get", "creds/vast/api_key"]);
    const key = stdout.trim();
    if (!key) throw new Error("empty value");
    return key;
  } catch (err) {
    throw new Error(
      "Could not read the Vast.ai API key. Set VAST_API_KEY, or ensure " +
        "`consul kv get creds/vast/api_key` works. " +
        `(underlying: ${(err as Error).message})`,
    );
  }
}

export interface VastClientOptions {
  /** API key or async resolver. If omitted, resolved via resolveApiKey(). */
  apiKey?: string | (() => Promise<string>);
  /** Custom fetch implementation (for testing / mocking). */
  fetch?: typeof fetch;
  /** Max retry attempts for 429/5xx responses. Default 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default 500ms. */
  baseDelayMs?: number;
  /** Custom sleep function (for testing). */
  sleep?: (ms: number) => Promise<void>;
}

export class VastClient {
  private readonly apiKeyProvider: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options?: VastClientOptions) {
    const key = options?.apiKey;
    if (typeof key === "function") {
      this.apiKeyProvider = key;
    } else if (typeof key === "string") {
      this.apiKeyProvider = () => Promise.resolve(key);
    } else {
      this.apiKeyProvider = () => resolveApiKey();
    }
    this.fetchImpl = options?.fetch ?? globalThis.fetch;
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseDelayMs = options?.baseDelayMs ?? 500;
    this.sleepImpl = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | object | undefined>,
  ): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }

  async post<T>(
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | object | undefined>,
  ): Promise<T> {
    return this.request<T>("POST", path, body, query);
  }

  async put<T>(
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | object | undefined>,
  ): Promise<T> {
    return this.request<T>("PUT", path, body, query);
  }

  async delete<T>(
    path: string,
    query?: Record<string, string | number | boolean | object | undefined>,
  ): Promise<T> {
    return this.request<T>("DELETE", path, undefined, query);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | object | undefined>,
  ): Promise<T> {
    const key = await this.apiKeyProvider();
    const url = buildUrl(path, query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    };

    let requestBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    let attempt = 0;
    while (true) {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: requestBody,
      });

      if (res.ok) {
        // Successful response
        return (await res.json()) as T;
      }

      // Parse error body if JSON
      let parsedBody: Record<string, unknown> | undefined;
      let rawText = "";
      try {
        const text = await res.text();
        rawText = text;
        parsedBody = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Non-JSON response
      }

      // Check for auth rejection:
      // FOOTGUN: Invalid key returns 404 with {"success":false,"error":"auth_error"}.
      // Missing header returns 403.
      const isAuthError =
        res.status === 401 ||
        res.status === 403 ||
        parsedBody?.error === "auth_error";

      if (isAuthError) {
        const detail =
          (parsedBody?.msg as string | undefined) ??
          (parsedBody?.error as string | undefined) ??
          (rawText.slice(0, 100) || `HTTP ${res.status}`);
        throw new VastAuthError(
          `Vast.ai API authentication rejected (HTTP ${res.status}: ${detail}). ` +
            `The key is invalid or revoked — not retrying.`,
          res.status,
          path,
          parsedBody,
        );
      }

      // Check if eligible for retry (only 429 or 5xx)
      const isRetryable = res.status === 429 || res.status >= 500;
      if (isRetryable && attempt < this.maxRetries) {
        const delay = this.baseDelayMs * 2 ** attempt;
        attempt++;
        await this.sleepImpl(delay);
        continue;
      }

      // Non-retryable error or retries exhausted
      const detail =
        (parsedBody?.msg as string | undefined) ??
        (parsedBody?.error as string | undefined) ??
        rawText.slice(0, 200) ??
        "no detail";
      throw new VastApiError(
        `HTTP ${res.status} from ${path} (${method}): ${detail}`,
        res.status,
        path,
        parsedBody,
      );
    }
  }
}
