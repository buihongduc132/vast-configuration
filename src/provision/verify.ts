// src/provision/verify.ts
// =============================================================================
// Remote endpoint verification probes.
//
// EMB-001 HARD REQUIREMENT:
// The mesh's vector store holds 1024-dimensional vectors. A remote producer
// returning ANY other dimension silently corrupts vector search results.
// We assert the dimension before allowing an endpoint to serve traffic.
// =============================================================================

import { EMBEDDING_DIMENSION } from "../workloads.js";
import { VastClient } from "../api/client.js";
import {
  classifyBackendDevice,
  fetchInstanceLogs,
  CpuBackendError,
  UnknownBackendError,
  isBackendVerified,
  assertBackendVerified,
  PRE_CONTAINER_START_DEADLINE_MS,
  POST_CONTAINER_HEALTH_DEADLINE_MS,
  type BackendDevice,
} from "../instances/status.js";

export {
  CpuBackendError,
  UnknownBackendError,
  classifyBackendDevice,
  isBackendVerified,
  assertBackendVerified,
  PRE_CONTAINER_START_DEADLINE_MS,
  POST_CONTAINER_HEALTH_DEADLINE_MS,
  type BackendDevice,
};

export class EmbeddingDimensionMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(
      `Embedding dimension mismatch: expected ${expected}, but endpoint returned ${actual}. ` +
        `Refusing to accept misaligned producer (EMB-001 contract violation).`,
    );
    this.name = "EmbeddingDimensionMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

export interface ProbeOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Probe an embedding endpoint by posting {"inputs":"test"} to /embed
 * and verifying that the resulting vector has EXACTLY EMBEDDING_DIMENSION (1024).
 */
export async function probeEmbedding(
  baseUrl: string,
  options?: ProbeOptions,
): Promise<number[]> {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 15_000;

  const url = `${baseUrl.replace(/\/+$/, "")}/embed`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ inputs: "test" }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Probe failed: HTTP ${res.status} from ${url}: ${text.slice(0, 100)}`,
    );
  }

  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error(`Probe failed: expected array from ${url}, got ${typeof data}`);
  }

  // Handle both 1D vector [0.1, 0.2, ...] and batch 2D vector [[0.1, 0.2, ...]]
  let vector: unknown[];
  if (Array.isArray(data[0])) {
    vector = data[0];
  } else {
    vector = data;
  }

  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new EmbeddingDimensionMismatchError(EMBEDDING_DIMENSION, vector.length);
  }

  return vector as number[];
}

export interface VerifyBackendOptions {
  readonly client?: VastClient;
  readonly fetchLogs?: (instanceId: number) => Promise<string>;
  readonly logText?: string;
  readonly onWarning?: (warning: string) => void;
}

export interface VerifyBackendResult {
  readonly device: "cuda" | "unknown";
  readonly warning?: string;
}

/**
 * Verify backend compute device from container logs.
 * Throws CpuBackendError (a FatalHostError) if the model is running on CPU.
 * Surfaces an explicit warning for "unknown" (never assumes CUDA).
 */
export async function verifyBackendDevice(
  instanceId: number,
  options?: VerifyBackendOptions,
): Promise<VerifyBackendResult> {
  const logText =
    options?.logText ??
    (options?.fetchLogs
      ? await options.fetchLogs(instanceId)
      : await fetchInstanceLogs(instanceId, { client: options?.client }));

  const device = classifyBackendDevice(logText);

  if (device === "cpu") {
    throw new CpuBackendError(instanceId, "Container logs indicate CPU backend fallback");
  }

  if (device === "unknown") {
    const warning = `Instance ${instanceId}: could not determine backend device from container logs — recorded as UNVERIFIED`;
    options?.onWarning?.(warning);
    return { device: "unknown", warning };
  }

  return { device: "cuda" };
}

export interface VerifyProvisionOptions extends ProbeOptions, VerifyBackendOptions {
  readonly probeBaseUrl?: string;
}

export interface ProvisionVerificationResult {
  readonly dimension?: number;
  readonly backend: "cuda" | "unknown";
  readonly warning?: string;
}

/**
 * Complete provision verification:
 * 1. Verifies backend device from container logs (rejects CPU fallback)
 * 2. Probes embedding endpoint if probeBaseUrl is supplied (asserts 1024-dim per EMB-001)
 */
export async function verifyProvisioning(
  instanceId: number,
  options?: VerifyProvisionOptions,
): Promise<ProvisionVerificationResult> {
  const backendResult = await verifyBackendDevice(instanceId, options);

  let dimension: number | undefined;
  if (options?.probeBaseUrl) {
    const vector = await probeEmbedding(options.probeBaseUrl, options);
    dimension = vector.length;
  }

  return {
    dimension,
    backend: backendResult.device,
    warning: backendResult.warning,
  };
}

export interface WaitForHealthOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly healthPath?: string;
  readonly checkBackendEarly?: boolean;
  readonly instanceId?: number;
  readonly fetchLogs?: (instanceId: number) => Promise<string>;
  readonly onDeviceChecked?: (device: BackendDevice) => void;
  readonly onWarning?: (warning: string) => void;
}

export interface WaitForHealthResult {
  readonly healthy: boolean;
  readonly elapsedMs: number;
  readonly device?: BackendDevice;
}

/**
 * Wait for endpoint /health to return HTTP 200.
 * Default timeout is POST_CONTAINER_HEALTH_DEADLINE_MS (12 minutes), separate from
 * the pre-container deadline (pull+start).
 * If checkBackendEarly is enabled, checks container logs while waiting to reject CPU fallback early.
 */
export async function waitForEndpointHealth(
  baseUrl: string,
  options?: WaitForHealthOptions,
): Promise<WaitForHealthResult> {
  const timeoutMs = options?.timeoutMs ?? POST_CONTAINER_HEALTH_DEADLINE_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? 15_000;
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options?.now ?? (() => Date.now());
  const healthPath = options?.healthPath ?? "/health";
  const url = `${baseUrl.replace(/\/+$/, "")}${healthPath}`;

  const startMs = now();
  let deviceChecked = false;
  let detectedDevice: BackendDevice | undefined;

  while (now() - startMs < timeoutMs) {
    // Check backend device early while waiting for model load
    if (options?.checkBackendEarly && !deviceChecked && options.instanceId && options.fetchLogs) {
      try {
        const logs = await options.fetchLogs(options.instanceId);
        detectedDevice = classifyBackendDevice(logs);
        options.onDeviceChecked?.(detectedDevice);
        if (detectedDevice === "cpu") {
          throw new CpuBackendError(
            options.instanceId,
            "Early log check detected silent CPU fallback",
          );
        }
        if (detectedDevice === "cuda") {
          deviceChecked = true;
        }
      } catch (err) {
        if (err instanceof CpuBackendError) {
          throw err;
        }
        // Transient log fetch error: continue polling
      }
    }

    try {
      const res = await fetchImpl(url);
      if (res.status === 200) {
        return {
          healthy: true,
          elapsedMs: now() - startMs,
          device: detectedDevice,
        };
      }
    } catch {
      // Endpoint not up yet
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Endpoint ${baseUrl} did not report healthy within ${timeoutMs}ms`);
}

