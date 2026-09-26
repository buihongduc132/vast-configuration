// src/instances/destroy.ts
// =============================================================================
// Positive teardown verification for Vast.ai instances.
//
// ⚠️ TEARDOWN FOOTGUN:
// An API call DELETE /instances/<id>/ may return success immediately while the
// instance continues running or transitions to "stopped". A stopped instance
// STILL BILLS for storage. Moreover, network or API quirks may return an empty
// or non-list response that looks "clean" to a naive handler.
//
// TEARDOWN DISCIPLINE:
// 1. DELETE /instances/<id>/
// 2. Poll GET /instances/ until <id> is ABSENT in 2 consecutive polls >=15s apart.
// 3. Assert Array.isArray — never treat null/undefined/error as "clean".
// 4. Distinguish "stopped" from "destroyed" (a stopped box is NOT destroyed).
// 5. Clear the declared lease in Consul KV.
// =============================================================================

import { VastClient } from "../api/client.js";
import { deleteLeaseByInstanceId, type KvOptions } from "../state/kv.js";

export class VastTeardownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VastTeardownError";
  }
}

export class VastTeardownTimeoutError extends VastTeardownError {
  readonly instanceId: number;
  readonly polls: number;
  readonly durationMs: number;

  constructor(instanceId: number, polls: number, durationMs: number) {
    super(
      `Teardown verification timed out for instance ${instanceId} after ` +
        `${durationMs}ms (${polls} polls). Instance may still be running or billing.`,
    );
    this.name = "VastTeardownTimeoutError";
    this.instanceId = instanceId;
    this.polls = polls;
    this.durationMs = durationMs;
  }
}

export interface DestroyOptions {
  readonly client?: VastClient;
  /** Poll interval in milliseconds. Default 15_000ms. */
  readonly pollIntervalMs?: number;
  /** Required number of consecutive absent polls. Default 2. */
  readonly minConsecutiveCleanPolls?: number;
  /** Overall timeout in milliseconds. Default 300_000ms (5 min). */
  readonly timeoutMs?: number;
  /** Custom sleep function (for testing). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Custom clock function (for testing). */
  readonly now?: () => number;
  readonly kvOptions?: KvOptions;
  /** Custom hook for lease deletion (for testing). */
  readonly deleteLeaseFn?: (instanceId: number) => Promise<boolean>;
}

export interface DestroyResult {
  readonly instanceId: number;
  readonly destroyed: boolean;
  readonly polls: number;
  readonly durationMs: number;
}

export async function destroyInstance(
  instanceId: number,
  options?: DestroyOptions,
): Promise<DestroyResult> {
  const client = options?.client ?? new VastClient();
  const pollIntervalMs = options?.pollIntervalMs ?? 15_000;
  const minConsecutiveCleanPolls = options?.minConsecutiveCleanPolls ?? 2;
  const timeoutMs = options?.timeoutMs ?? 300_000;
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options?.now ?? (() => Date.now());

  // 1. Issue DELETE call
  await client.delete(`/instances/${instanceId}`);

  // 2. Positively verify teardown via polling
  const startMs = now();
  let consecutiveClean = 0;
  let pollCount = 0;

  while (now() - startMs < timeoutMs) {
    pollCount++;
    const res = await client.get<unknown>("/instances");

    // Assert Array.isArray — never treat null/undefined/object as clean
    let list: Array<{ id?: unknown; actual_status?: unknown; status?: unknown }> | null = null;
    if (Array.isArray(res)) {
      list = res;
    } else if (res && typeof res === "object" && Array.isArray((res as { instances?: unknown[] }).instances)) {
      list = (res as { instances: Array<{ id?: unknown; actual_status?: unknown; status?: unknown }> }).instances;
    }

    if (!Array.isArray(list)) {
      throw new VastTeardownError(
        `Invalid response from GET /instances/ during teardown verification of ${instanceId}: ` +
          `expected an array, received ${typeof res}`,
      );
    }

    // Check if the target instance is still present in the list
    const found = list.find((item) => Number(item?.id) === instanceId);

    if (found) {
      // Instance is still listed! Even if actual_status is "stopped", it is NOT destroyed.
      consecutiveClean = 0;
    } else {
      // Instance is completely absent from the returned list
      consecutiveClean++;
      if (consecutiveClean >= minConsecutiveCleanPolls) {
        break;
      }
    }

    await sleep(pollIntervalMs);
  }

  const durationMs = now() - startMs;
  if (consecutiveClean < minConsecutiveCleanPolls) {
    throw new VastTeardownTimeoutError(instanceId, pollCount, durationMs);
  }

  // 3. Clear KV lease
  if (options?.deleteLeaseFn) {
    await options.deleteLeaseFn(instanceId);
  } else {
    await deleteLeaseByInstanceId(instanceId, options?.kvOptions);
  }

  return {
    instanceId,
    destroyed: true,
    polls: pollCount,
    durationMs,
  };
}
