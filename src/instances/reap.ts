// src/instances/reap.ts
// =============================================================================
// Autonomous reaper for orphaned and expired Vast.ai rentals.
//
// ⚠️ GUARD-001 (bounded blast radius):
//  - NEVER touch an instance whose label lacks our prefix (a human's personal box).
//  - Bounded: at most 3 destroys per run to prevent catastrophic cascading kills.
//  - Audit-log every destroy with reason and accrued cost.
// =============================================================================

import { VastClient } from "../api/client.js";
import {
  decideReaps,
  accruedCostUsd,
  isOurLabel,
  type Lease,
  type ReapDecision,
} from "./lease.js";
import { destroyInstance, type DestroyResult } from "./destroy.js";
import { listLeases, type KvOptions } from "../state/kv.js";

export const MAX_REAPS_PER_RUN = 3;

export interface AuditLogEntry {
  readonly instanceId: number;
  readonly label?: string | null;
  readonly reason: string;
  readonly costUsd: number;
  readonly timestampMs: number;
}

export type AuditLogger = (entry: AuditLogEntry) => void;

export const defaultAuditLogger: AuditLogger = (entry) => {
  console.log(
    `[reap-guard] DESTROYED orphan/expired instance ${entry.instanceId} ` +
      `(reason=${entry.reason}, accrued ~$${entry.costUsd.toFixed(2)}, label=${entry.label ?? "(none)"})`,
  );
};

export interface ReapOptions {
  readonly client?: VastClient;
  readonly kvOptions?: KvOptions;
  readonly maxReaps?: number;
  readonly nowMs?: number;
  readonly auditLogger?: AuditLogger;
  /** Hook for listing leases (for testing). */
  readonly listLeasesFn?: () => Promise<Array<Lease>>;
  /** Hook for destroying instances (for testing). */
  readonly destroyFn?: (instanceId: number) => Promise<DestroyResult>;
}

export interface ReapResult {
  readonly liveCount: number;
  readonly decisions: readonly ReapDecision[];
  readonly reaped: readonly AuditLogEntry[];
}

export async function reapOrphans(options?: ReapOptions): Promise<ReapResult> {
  const client = options?.client ?? new VastClient();
  const maxReaps = options?.maxReaps ?? MAX_REAPS_PER_RUN;
  const nowMs = options?.nowMs ?? Date.now();
  const auditLogger = options?.auditLogger ?? defaultAuditLogger;
  const destroyFn = options?.destroyFn ?? ((id) => destroyInstance(id, { client, kvOptions: options?.kvOptions }));

  // 1. Fetch live instances from Vast.ai API
  const res = await client.get<unknown>("/instances");

  let liveList: Array<{
    id: number;
    label?: string | null;
    start_date?: number | null;
    dph_total?: number | null;
    actual_status?: string | null;
  }> | null = null;

  if (Array.isArray(res)) {
    liveList = res;
  } else if (res && typeof res === "object" && Array.isArray((res as { instances?: unknown[] }).instances)) {
    liveList = (res as { instances: typeof liveList }).instances;
  }

  if (!Array.isArray(liveList)) {
    throw new Error(
      `Invalid response from GET /instances/: expected an array, got ${typeof res}`,
    );
  }

  // 2. Fetch declared leases from Consul KV
  const rawLeases = options?.listLeasesFn
    ? await options.listLeasesFn()
    : await listLeases(options?.kvOptions);

  // Filter to confirmed leases with instanceId
  const declaredLeases: Lease[] = rawLeases.filter(
    (l): l is Lease => typeof (l as Lease).instanceId === "number",
  );

  // 3. Evaluate decisions (never touches boxes without our label prefix)
  const decisions = decideReaps({
    live: liveList,
    declared: declaredLeases,
    nowMs,
  });

  // 4. Bound to at most maxReaps per run
  const toDestroy = decisions.slice(0, maxReaps);
  const declaredByInstanceId = new Map(declaredLeases.map((l) => [l.instanceId, l]));
  const liveByInstanceId = new Map(liveList.map((i) => [i.id, i]));

  const reapedEntries: AuditLogEntry[] = [];

  for (const decision of toDestroy) {
    const liveInst = liveByInstanceId.get(decision.instanceId);
    // Double check: NEVER destroy without our label prefix
    if (!liveInst || !isOurLabel(liveInst.label)) {
      continue;
    }

    const lease = declaredByInstanceId.get(decision.instanceId);
    let costUsd = 0;
    if (lease) {
      costUsd = accruedCostUsd(lease, nowMs);
    } else if (liveInst.start_date && liveInst.dph_total) {
      const startMs = Number(liveInst.start_date) * 1000;
      const dph = Number(liveInst.dph_total);
      costUsd = accruedCostUsd(
        {
          label: liveInst.label ?? "",
          workload: "?",
          offerId: 0,
          dphTotal: dph,
          createdAtMs: startMs,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
          owner: "?",
        },
        nowMs,
      );
    }

    // Execute teardown
    await destroyFn(decision.instanceId);

    const auditEntry: AuditLogEntry = {
      instanceId: decision.instanceId,
      label: liveInst.label,
      reason: decision.reason,
      costUsd,
      timestampMs: nowMs,
    };

    auditLogger(auditEntry);
    reapedEntries.push(auditEntry);
  }

  return {
    liveCount: liveList.length,
    decisions,
    reaped: reapedEntries,
  };
}
