// src/provision/embedding.ts
// =============================================================================
// Provisioning artifacts for the TEI embedding workload on Vast.ai.
//
// Serves Qwen/Qwen3-Embedding-0.6B at port 8003 with --pooling mean.
// Model and dimension (1024) are HARD requirements per EMB-001.
// =============================================================================

import {
  EMBEDDING_WORKLOAD,
  TEI_IMAGE,
  TEI_POOLING,
} from "../workloads.js";
import type { ExecFileRunner } from "../state/kv.js";

const defaultExecRunner: ExecFileRunner = async (file, args) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile)(file, args as string[], { encoding: "utf8" });
};

export async function resolveHfToken(options?: {
  env?: Record<string, string | undefined>;
  execRunner?: ExecFileRunner;
}): Promise<string> {
  const env = options?.env ?? process.env;
  const fromEnv = env.HUGGING_FACE_HUB_TOKEN?.trim() || env.HF_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const runner = options?.execRunner ?? defaultExecRunner;
  try {
    const { stdout } = await runner("consul", [
      "kv",
      "get",
      "creds/common/huggingface/api_key",
    ]);
    const key = stdout.trim();
    if (!key) throw new Error("empty value");
    return key;
  } catch (err) {
    throw new Error(
      "Could not read HuggingFace token from Consul `creds/common/huggingface/api_key` or env. " +
        `(underlying: ${(err as Error).message})`,
    );
  }
}

export interface WorkloadProvisionConfig {
  readonly image: string;
  readonly args: readonly string[];
  readonly port: number;
  readonly env: Record<string, string>;
  readonly onstart: string;
}

export async function buildEmbeddingProvisionConfig(options?: {
  hfToken?: string;
  env?: Record<string, string | undefined>;
  execRunner?: ExecFileRunner;
}): Promise<WorkloadProvisionConfig> {
  let hfToken = options?.hfToken;
  if (!hfToken) {
    try {
      hfToken = await resolveHfToken({
        env: options?.env,
        execRunner: options?.execRunner,
      });
    } catch {
      // Allow fallback to empty string if credentials not available in environment
      hfToken = "";
    }
  }

  const model = EMBEDDING_WORKLOAD.model;
  const port = EMBEDDING_WORKLOAD.port;
  const pooling = TEI_POOLING;

  const args = [
    "--model-id",
    model,
    "--port",
    String(port),
    "--pooling",
    pooling,
  ];

  const env: Record<string, string> = {};
  if (hfToken) {
    env["HUGGING_FACE_HUB_TOKEN"] = hfToken;
  }

  const onstart = `#!/usr/bin/env bash
set -euo pipefail
echo "[vast-offload] Starting TEI for ${model} on port ${port} (pooling: ${pooling})..."
if command -v text-embeddings-router >/dev/null 2>&1; then
  exec text-embeddings-router --model-id "${model}" --port ${port} --pooling "${pooling}"
fi
`;

  return {
    image: TEI_IMAGE,
    args,
    port,
    env,
    onstart,
  };
}
