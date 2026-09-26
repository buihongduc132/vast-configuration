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
