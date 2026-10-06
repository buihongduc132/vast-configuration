// src/provision/combo.ts
// =============================================================================
// Provisioning artifacts for the combo workload (TEI + vLLM) on a single Vast.ai GPU.
//
// Workloads on single 24GB instance:
//   1. TEI serving Qwen/Qwen3-Embedding-0.6B on port 8003 (--pooling mean, 1024-dim)
//   2. vLLM serving cyankiwi/Qwen3.5-4B-AWQ-4bit on port 8032 (256K context, 0.62 util)
//
// Dual-onstart supervision guarantees:
//   - No bare `exec` that drops sibling service
//   - No `set -e` cascade that kills sibling on non-fatal error
//   - Graceful termination (SIGTERM propagation to both children)
//   - Clean exit if either critical service terminates
// =============================================================================

import {
  COMBO_IMAGE,
  COMBO_PORTS,
  COMBO_WORKLOAD,
  EMBEDDING_WORKLOAD,
  QWEN_WORKLOAD,
  TEI_POOLING,
} from "../workloads.js";
import { resolveHfToken, type WorkloadProvisionConfig } from "./embedding.js";
import type { ExecFileRunner } from "../state/kv.js";

export { resolveHfToken };

export interface ComboOnstartOptions {
  readonly embeddingPort?: number;
  readonly llmPort?: number;
  readonly embeddingModel?: string;
  readonly llmModel?: string;
  readonly teiPooling?: string;
  readonly vllmGpuMemoryUtilization?: number;
  readonly vllmMaxModelLen?: number;
  readonly vllmMaxNumSeqs?: number;
}

/**
 * Builds the supervisor onstart script for running both TEI and vLLM.
 * Supervised: handles signals, monitors both processes, and avoids `exec`/`set -e` traps.
 */
export function buildComboOnstartScript(options?: ComboOnstartOptions): string {
  const embedPort = options?.embeddingPort ?? EMBEDDING_WORKLOAD.port; // 8003
  const llmPort = options?.llmPort ?? QWEN_WORKLOAD.port;             // 8032
  const embedModel = options?.embeddingModel ?? EMBEDDING_WORKLOAD.model;
  const llmModel = options?.llmModel ?? QWEN_WORKLOAD.model;
  const pooling = options?.teiPooling ?? TEI_POOLING;
  const gpuUtil = options?.vllmGpuMemoryUtilization ?? 0.62;
  const maxModelLen = options?.vllmMaxModelLen ?? 262144;
  const maxNumSeqs = options?.vllmMaxNumSeqs ?? 4;

  return `#!/usr/bin/env bash
# Supervisor for dual-workload instance (TEI :${embedPort} + vLLM :${llmPort})
set -uo pipefail

mkdir -p /var/log /tmp

echo "[vast-combo] Starting combo supervisor on $(date -Is)..."

# Ensure HuggingFace token is propagated
if [[ -n "\${HUGGING_FACE_HUB_TOKEN:-}" ]]; then
  export HF_TOKEN="\${HUGGING_FACE_HUB_TOKEN}"
fi


TEI_PID=""
VLLM_PID=""

cleanup() {
  echo "[vast-combo] Trapped termination signal. Shutting down children..."
  if [[ -n "$TEI_PID" ]] && kill -0 "$TEI_PID" 2>/dev/null; then
    kill -TERM "$TEI_PID" 2>/dev/null || true
  fi
  if [[ -n "$VLLM_PID" ]] && kill -0 "$VLLM_PID" 2>/dev/null; then
    kill -TERM "$VLLM_PID" 2>/dev/null || true
  fi
  wait
  echo "[vast-combo] Teardown complete."
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── 1. Start TEI embedding producer ──────────────────────────────────────────
echo "[vast-combo] Starting TEI for ${embedModel} on port ${embedPort}..."
if command -v text-embeddings-router >/dev/null 2>&1; then
  text-embeddings-router \
    --model-id "${embedModel}" \
    --port ${embedPort} \
    --pooling "${pooling}" \
    --max-client-batch-size 32 \
    2>&1 | tee -a /var/log/tei.log &
  TEI_PID=$!
  echo "[vast-combo] TEI started with PID $TEI_PID"
else
  echo "[vast-combo] FATAL: text-embeddings-router binary not found" >&2
  exit 127
fi

# ── 2. Start vLLM LLM service ────────────────────────────────────────────────
echo "[vast-combo] Starting vLLM for ${llmModel} on port ${llmPort}..."
python3 -m vllm.entrypoints.openai.api_server \
  --model "${llmModel}" \
  --host 0.0.0.0 \
  --port ${llmPort} \
  --max-model-len ${maxModelLen} \
  --gpu-memory-utilization ${gpuUtil} \
  --max-num-seqs ${maxNumSeqs} \
  --cpu-offload-gb 0 \
  --trust-remote-code \
  2>&1 | tee -a /var/log/vllm.log &
VLLM_PID=$!
echo "[vast-combo] vLLM started with PID $VLLM_PID"

# ── 3. Monitor loop ─────────────────────────────────────────────────────────
echo "[vast-combo] Both services started. Entering supervisor loop..."
while true; do
  if ! kill -0 "$TEI_PID" 2>/dev/null; then
    echo "[vast-combo] FATAL: TEI (PID $TEI_PID) exited unexpectedly!" >&2
    tail -n 40 /var/log/tei.log >&2 || true
    cleanup
    exit 1
  fi

  if ! kill -0 "$VLLM_PID" 2>/dev/null; then
    echo "[vast-combo] FATAL: vLLM (PID $VLLM_PID) exited unexpectedly!" >&2
    tail -n 40 /var/log/vllm.log >&2 || true
    cleanup
    exit 2
  fi

  sleep 5
done
`;
}

export interface ComboProvisionOptions {
  readonly hfToken?: string;
  readonly env?: Record<string, string | undefined>;
  readonly execRunner?: ExecFileRunner;
  readonly image?: string;
  readonly onstartOptions?: ComboOnstartOptions;
}

export interface ComboProvisionConfig extends WorkloadProvisionConfig {
  readonly ports: readonly number[];
}

/**
 * Builds the complete provisioning configuration for the combo workload.
 * Injects HF token for BOTH models, binds both ports (8003 + 8032), and
 * sets up the supervised dual onstart script.
 */
export async function buildComboProvisionConfig(
  options?: ComboProvisionOptions,
): Promise<ComboProvisionConfig> {
  let hfToken = options?.hfToken;
  if (!hfToken) {
    try {
      hfToken = await resolveHfToken({
        env: options?.env,
        execRunner: options?.execRunner,
      });
    } catch {
      hfToken = "";
    }
  }

  const env: Record<string, string> = {};
  if (hfToken) {
    env["HUGGING_FACE_HUB_TOKEN"] = hfToken;
    env["HF_TOKEN"] = hfToken;
  }

  const onstart = buildComboOnstartScript(options?.onstartOptions);
  const image = options?.image ?? COMBO_IMAGE;

  return {
    image,
    args: [],
    port: COMBO_WORKLOAD.port, // Primary 8003
    ports: COMBO_PORTS,        // Dual [8003, 8032]
    env,
    onstart,
  };
}
