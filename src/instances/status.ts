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
  readonly actual_status?: string | null;
  readonly cur_state?: string | null;
  readonly status_msg?: string | null;
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
