// src/instances/status.ts
// =============================================================================
// Status classification and state vocabulary for Vast.ai instances.
//
// ⚠️ STATUS & ERROR FOOTGUNS (verified live 2026-09-27):
// 1. Host-level failure can leave an instance sitting at `actual_status: loading`
//    indefinitely while billing at full price. Must inspect `status_msg` early.
// 2. `cur_state: running` can appear WHILE `actual_status: loading`.
//    Always trust `actual_status`.
// 3. Normal docker pull progress lines ("Pull complete", "Extracting", etc.)
//    must NOT be classified as errors.
// =============================================================================

import { VastClient } from "../api/client.js";

export type StatusMsgClassification = "fatal-host" | "progress" | "normal";

export type InstanceStateCategory = "running" | "pending" | "terminal" | "fatal-host";

export const FATAL_HOST_PATTERNS = [
  "no such host",
  "manifest unknown",
  "unauthorized",
  "connection refused",
  "oci runtime create failed",
  "failed to create task",
] as const;

export const NORMAL_PROGRESS_PATTERNS = [
  "pull complete",
  "extracting",
  "downloading",
  "verifying checksum",
] as const;

/**
 * Returns true if the status message indicates an unrecoverable host-level failure
 * (e.g. DNS failure for ghcr.io, broken nvidia-container-toolkit).
 */
export function isFatalHostStatusMsg(statusMsg: string | null | undefined): boolean {
  if (!statusMsg) return false;
  const lower = statusMsg.toLowerCase();

  // Check explicit fatal patterns
  for (const pattern of FATAL_HOST_PATTERNS) {
    if (lower.includes(pattern)) {
      return true;
    }
  }

  // Match 'error response from daemon' as fatal ONLY when the line does not also contain 'complete'
  if (lower.includes("error response from daemon") && !lower.includes("complete")) {
    return true;
  }

  return false;
}

/**
 * Classify a status message as fatal-host, normal progress, or normal.
 */
export function classifyStatusMsg(statusMsg: string | null | undefined): StatusMsgClassification {
  if (isFatalHostStatusMsg(statusMsg)) {
    return "fatal-host";
  }

  if (statusMsg) {
    const lower = statusMsg.toLowerCase();
    for (const progress of NORMAL_PROGRESS_PATTERNS) {
      if (lower.includes(progress)) {
        return "progress";
      }
    }
  }

  return "normal";
}

export interface InstanceStateInput {
  readonly id?: number;
  readonly actual_status?: string | null;
  readonly cur_state?: string | null;
  readonly status_msg?: string | null;
  readonly dph_total?: number | null;
  readonly [key: string]: unknown;
}

/**
 * Classify instance state by prioritizing actual_status over cur_state,
 * and checking for fatal host conditions in status_msg.
 */
export function classifyInstanceState(instance: InstanceStateInput): InstanceStateCategory {
  // 1. Host-level failure in status_msg overrides everything
  if (isFatalHostStatusMsg(instance.status_msg)) {
    return "fatal-host";
  }

  // 2. Trust actual_status, NEVER cur_state (which can say "running" while loading)
  const actual = instance.actual_status ?? null;

  if (actual === "running") {
    return "running";
  }

  if (actual === "exited" || actual === "offline" || actual === "unknown") {
    return "terminal";
  }

  if (actual === null || actual === "loading" || actual === "created") {
    return "pending";
  }

  // Any other unexpected state is treated as terminal
  return "terminal";
}

export class FatalHostError extends Error {
  readonly instanceId: number;
  readonly statusMsg: string;

  constructor(instanceId: number, statusMsg: string) {
    super(`Host-level failure on instance ${instanceId}: ${statusMsg}`);
    this.name = "FatalHostError";
    this.instanceId = instanceId;
    this.statusMsg = statusMsg;
  }
}

export class TerminalInstanceStateError extends Error {
  readonly instanceId: number;
  readonly actualStatus: string;

  constructor(instanceId: number, actualStatus: string) {
    super(`Instance ${instanceId} entered terminal state: "${actualStatus}"`);
    this.name = "TerminalInstanceStateError";
    this.instanceId = instanceId;
    this.actualStatus = actualStatus;
  }
}

export interface WaitForInstanceOptions {
  readonly client?: VastClient;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Poll instance until it reaches "running" state.
 * Throws FatalHostError if status_msg indicates fatal host failure.
 * Throws TerminalInstanceStateError if instance enters exited/offline/unknown state.
 */
export async function waitForInstanceReady(
  instanceId: number,
  options?: WaitForInstanceOptions,
): Promise<InstanceStateInput> {
  const client = options?.client ?? new VastClient();
  const timeoutMs = options?.timeoutMs ?? 9 * 60_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 15_000;
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options?.now ?? (() => Date.now());

  const startMs = now();

  while (now() - startMs < timeoutMs) {
    const res = await client.get<unknown>("/instances");
    let list: InstanceStateInput[] | null = null;
    if (Array.isArray(res)) {
      list = res;
    } else if (res && typeof res === "object" && Array.isArray((res as { instances?: unknown[] }).instances)) {
      list = (res as { instances: InstanceStateInput[] }).instances;
    }

    if (!Array.isArray(list)) {
      throw new Error(`Invalid response from GET /instances: expected array, got ${typeof res}`);
    }

    const inst = list.find((i) => Number(i.id) === instanceId);
    if (!inst) {
      throw new TerminalInstanceStateError(instanceId, "vanished");
    }

    const state = classifyInstanceState(inst);
    if (state === "fatal-host") {
      throw new FatalHostError(instanceId, inst.status_msg ?? "fatal host error");
    }
    if (state === "terminal") {
      throw new TerminalInstanceStateError(instanceId, inst.actual_status ?? "terminal");
    }
    if (state === "running") {
      return inst;
    }

    // Still pending (null, loading, created)
    await sleep(pollIntervalMs);
  }

  throw new Error(`Instance ${instanceId} did not reach running state within ${timeoutMs}ms`);
}

/** Strip ANSI color and control escape sequences. */
export function stripAnsi(text: string): string {
  if (!text) return "";
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

export type BackendDevice = "cuda" | "cpu" | "unknown";

export const CPU_BACKEND_PATTERNS = [
  "using cpu instead",
  "model on cpu",
  "cuda is not available",
  "cuda_error_compat_not_supported",
] as const;

/**
 * Classify the backend compute device (cuda vs cpu vs unknown) from container log text.
 * Returns:
 *   - "cpu" if logs indicate CUDA failure or fallback to CPU
 *   - "cuda" if logs indicate model loaded on CUDA
 *   - "unknown" otherwise (unknown is NEVER assumed to be cuda)
 */
export function classifyBackendDevice(logText: string | null | undefined): BackendDevice {
  if (!logText) return "unknown";
  const clean = stripAnsi(logText);
  const lower = clean.toLowerCase();

  for (const pattern of CPU_BACKEND_PATTERNS) {
    if (lower.includes(pattern)) {
      return "cpu";
    }
  }

  // Matches "model on cuda" or "starting <x> model on cuda"
  if (/model\s+on\s+cuda/i.test(clean) || /starting\s+\S+\s+model\s+on\s+cuda/i.test(clean)) {
    return "cuda";
  }

  return "unknown";
}

export class CpuBackendError extends FatalHostError {
  constructor(instanceId: number, details?: string) {
    const msg = `Silent CPU fallback detected: model running on CPU instead of GPU${details ? ` (${details})` : ""}`;
    super(instanceId, msg);
    this.name = "CpuBackendError";
  }
}

export interface FetchLogsOptions {
  readonly client?: VastClient;
  readonly tail?: string | number;
  readonly fetch?: typeof fetch;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly stripAnsi?: boolean;
}

/**
 * Fetch container logs from Vast.ai:
 * 1. PUT /instances/request_logs/<id>/ returns a signed S3 URL
 * 2. Poll the S3 URL until the log appears
 * 3. Strip ANSI escape sequences by default
 */
export async function fetchInstanceLogs(
  instanceId: number,
  options?: FetchLogsOptions,
): Promise<string> {
  const client = options?.client ?? new VastClient();
  const tail = options?.tail ?? "60";
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const maxAttempts = options?.maxAttempts ?? 5;
  const retryDelayMs = options?.retryDelayMs ?? 1000;
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const shouldStripAnsi = options?.stripAnsi ?? true;

  const res = await client.put<{
    success?: boolean;
    result_url?: string;
    msg?: string;
    error?: string;
  }>(`/instances/request_logs/${instanceId}/`, { tail: String(tail) });

  if (!res || res.success === false || !res.result_url) {
    const errDetail = res?.msg ?? res?.error ?? JSON.stringify(res);
    throw new Error(`Failed to request logs for instance ${instanceId}: ${errDetail}`);
  }

  const resultUrl = res.result_url;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const logRes = await fetchImpl(resultUrl);
      if (logRes.ok) {
        const text = await logRes.text();
        return shouldStripAnsi ? stripAnsi(text) : text;
      }
    } catch {
      // transient network or log not uploaded yet
    }
    if (attempt < maxAttempts - 1) {
      await sleep(retryDelayMs);
    }
  }

  throw new Error(
    `Failed to fetch log from ${resultUrl} for instance ${instanceId} after ${maxAttempts} attempts`,
  );
}
