// src/workloads.ts
// =============================================================================
// SINGLE SOURCE OF TRUTH for what each offloadable workload needs from a rented
// GPU (P14 — correlated values defined once).
//
// ⛔ The embedding model + dimension are NOT ours to change. They are owned by
// noco-mesh-infra/lib/embedding-contract.ts (EMB-001). The values mirrored here
// MUST match that contract; `tests/contract-parity.test.ts` asserts it.
// This repo may vary the *site* a workload runs on — never the model or the
// dimension. A remote producer emitting a different dimension silently corrupts
// the mesh's existing 1024-dim vectors.
// =============================================================================

/** Which site currently serves a workload. */
export type Site = "local" | "vast";

export type WorkloadId = "embedding" | "qwen" | "combo";

export interface WorkloadSpec {
  readonly id: WorkloadId;
  /** HuggingFace model id served. */
  readonly model: string;
  /**
   * Minimum GPU VRAM in MiB an offer must have to be selectable.
   * Undersized offers are rejected before rent — renting a box that cannot load
   * the model burns money for a guaranteed failure.
   */
  readonly minGpuRamMb: number;
  /**
   * Minimum instance disk in GiB. Model weights download to disk first; a box
   * with too little disk fails partway through provisioning (still billed).
   */
  readonly minDiskGb: number;
  /** Port the served API listens on inside the instance. */
  readonly port: number;
  /** Health endpoint path. */
  readonly healthPath: string;
  /**
   * Upper bound on cold start (weights download + model load + warmup) in
   * seconds. Health gating must wait at least this long before declaring
   * failure, or it kills a healthy-but-still-booting server (R-1 grace).
   */
  readonly coldStartBudgetSec: number;
  /** Approximate weights size in GiB — informs disk + download-time budget. */
  readonly weightsSizeGb: number;
}

/**
 * Embedding producer: TEI serving Qwen3-Embedding-0.6B at 1024 dimensions.
 * Mirrors EMBEDDING_CONTRACT in noco-mesh-infra (EMB-001).
 */
export const EMBEDDING_WORKLOAD: WorkloadSpec = {
  id: "embedding",
  model: "Qwen/Qwen3-Embedding-0.6B",
  // 0.6B params is small, but TEI on the GPU image still wants headroom for
  // batching. 8 GiB is the realistic floor for comfortable operation.
  minGpuRamMb: 8192,
  minDiskGb: 20,
  port: 8003,
  healthPath: "/health",
  coldStartBudgetSec: 300,
  weightsSizeGb: 2.5,
};

/**
 * qwen LLM: vLLM serving Qwen3.5-4B AWQ-4bit at 256K context.
 * Local cold start measured at 3-8 minutes (download + torch.compile + CUDA
 * graph capture + KV cache profiling), so the budget is deliberately generous.
 */
export const QWEN_WORKLOAD: WorkloadSpec = {
  id: "qwen",
  model: "cyankiwi/Qwen3.5-4B-AWQ-4bit",
  // AWQ weights ~3.9 GiB, but a 256K-context KV cache is the real consumer.
  // 24 GiB (3090-class) is what the local deployment uses at 0.62 utilization.
  minGpuRamMb: 24576,
  minDiskGb: 40,
  port: 8032,
  healthPath: "/health",
  coldStartBudgetSec: 900,
  weightsSizeGb: 3.9,
};

/**
 * Combo workload: single Vast.ai instance co-locating TEI embedding producer
 * (:8003) and vLLM LLM service (:8032) on a single 24 GB GPU (RTX 3090).
 * Combined VRAM footprint is ~16.5 GB (0.62 vLLM + ~1.5 GB TEI), safely fitting 24 GB.
 */
export const COMBO_WORKLOAD: WorkloadSpec = {
  id: "combo",
  model: "Qwen/Qwen3-Embedding-0.6B + cyankiwi/Qwen3.5-4B-AWQ-4bit",
  minGpuRamMb: 24576,
  minDiskGb: 50,
  port: 8003,
  healthPath: "/health",
  coldStartBudgetSec: 900,
  weightsSizeGb: 6.4,
};

export const COMBO_PORTS = [8003, 8032] as const;

export const COMBO_IMAGE = "ghcr.io/buihongduc132/vllm-tei-combo:v2";

export const WORKLOADS: Readonly<Record<WorkloadId, WorkloadSpec>> = {
  embedding: EMBEDDING_WORKLOAD,
  qwen: QWEN_WORKLOAD,
  combo: COMBO_WORKLOAD,
};

/**
 * The embedding dimension the mesh's vector store already holds. Any remote
 * producer MUST emit exactly this, verified by probe before it serves traffic.
 * Changing this number is a vector-store migration, not a config tweak.
 */
export const EMBEDDING_DIMENSION = 1024;

/** TEI image — GPU build; Qwen3 has no ONNX export so the CPU image cannot serve it. */
export const TEI_IMAGE = "ghcr.io/huggingface/text-embeddings-inference:1.9.3";

/** TEI pooling mode required by Qwen3-Embedding (default cls is wrong for it). */
export const TEI_POOLING = "mean";

/**
 * Producers that are PERMANENTLY retired. Never serve these from any site.
 * Resurrecting one is a known, repeated failure in this fleet.
 */
export const FORBIDDEN_MODELS: readonly string[] = [
  "BAAI/bge-large-en-v1.5",
  "BAAI/bge-small-en-v1.5",
  "nomic-embed-text",
];

/** Ports tied to dead producers — never bind these for a new producer. */
export const FORBIDDEN_PORTS: readonly number[] = [8005, 8004, 18001];

export function getWorkload(id: WorkloadId): WorkloadSpec {
  const w = WORKLOADS[id];
  if (!w) throw new Error(`unknown workload: ${id}`);
  return w;
}

/** True when a model id is one of the permanently-retired producers. */
export function isForbiddenModel(model: string): boolean {
  const needle = model.toLowerCase();
  return FORBIDDEN_MODELS.some((f) => needle.includes(f.toLowerCase()))
    // Any bge variant is dead, not just the two named above.
    || needle.includes("bge-");
}
