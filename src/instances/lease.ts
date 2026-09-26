// src/instances/lease.ts
// =============================================================================
// Crash-safe rental bookkeeping.
//
// THE PROBLEM: a `finally { destroy() }` block does NOT run if the process is
// SIGKILLed — host OOM, NVMe hang, reboot, vitest worker timeout, or an operator
// hitting Ctrl-C. This host has a documented history of hard hangs and GPU-
// driven reboots, and a rented GPU keeps billing regardless. An in-process
// cleanup handler is therefore necessary but NOT sufficient.
//
// THE FIX: write the intent to durable storage BEFORE renting, so that an
// independent reaper can find and destroy an instance whose owner died. State
// is written pre-rent (not post-rent) because the dangerous window is exactly
// between "API created the instance" and "we recorded its id".
// =============================================================================

/** A lease intent, written BEFORE the rent call. */
export interface LeaseIntent {
  /** Unique, greppable label applied to the instance so a reaper can match it
   *  even if state is lost entirely. */
  readonly label: string;
  /** Which workload this rental is for. */
  readonly workload: string;
  /** Offer id we intend to rent. */
  readonly offerId: number;
  /** Hourly price at selection time. */
  readonly dphTotal: number;
  /** Epoch ms when the intent was recorded. */
  readonly createdAtMs: number;
  /** Hard deadline — a reaper destroys the instance after this regardless. */
  readonly expiresAtMs: number;
  /** Who/what created it (session, test name, operator). */
  readonly owner: string;
}

/** A lease that has been confirmed against a real instance. */
export interface Lease extends LeaseIntent {
  readonly instanceId: number;
}

export const LEASE_LABEL_PREFIX = "nocomesh-offload";

/**
 * Build the instance label. The prefix is the reaper's last-resort handle: even
 * with all state lost, `GET /instances/` + prefix match finds our orphans and
 * distinguishes them from instances a human rented by hand (which must NOT be
 * destroyed).
 */
export function buildLeaseLabel(
  workload: string,
  owner: string,
  nowMs: number = Date.now(),
): string {
  const safeOwner = owner.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24);
  return `${LEASE_LABEL_PREFIX}--${workload}--${safeOwner}--${nowMs}`;
}

/** True when a label belongs to us (and is therefore reaper-eligible). */
export function isOurLabel(label: string | null | undefined): boolean {
  return typeof label === "string" && label.startsWith(`${LEASE_LABEL_PREFIX}--`);
}

export function makeLeaseIntent(args: {
  workload: string;
  offerId: number;
  dphTotal: number;
  owner: string;
  maxLifetimeMinutes: number;
  nowMs?: number;
}): LeaseIntent {
  const nowMs = args.nowMs ?? Date.now();
  if (!Number.isFinite(args.maxLifetimeMinutes) || args.maxLifetimeMinutes <= 0) {
    throw new Error("maxLifetimeMinutes must be a positive number");
  }
  return {
    label: buildLeaseLabel(args.workload, args.owner, nowMs),
    workload: args.workload,
    offerId: args.offerId,
    dphTotal: args.dphTotal,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + args.maxLifetimeMinutes * 60_000,
    owner: args.owner,
  };
}

/** True when a lease is past its hard deadline and must be destroyed. */
export function isExpired(lease: LeaseIntent, nowMs: number = Date.now()): boolean {
  return nowMs >= lease.expiresAtMs;
}

export interface LiveInstanceCostSource {
  readonly dph_total?: number | null;
  readonly start_date?: number | null;
  readonly createdAtMs?: number;
  readonly dphTotal?: number;
  readonly [key: string]: unknown;
}

/**
 * Cost accrued so far, from wall-clock lifetime — computable immediately and
 * deterministically, unlike the account balance which lags behind.
 *
 * ⚠️ PRICE DRIFT (verified live 2026-09-27):
 * The price quoted at search time is NOT what you are billed. Search said
 * $0.1489/hr; the live instance reported dph_total $0.1578; a third reported
 * $0.1711. Any cost estimate must read `dph_total` from the INSTANCE object,
 * not from the offer. If a liveInstance is provided, its `dph_total` overrides
 * any offer-time `dphTotal` on the lease.
 */
export function accruedCostUsd(
  leaseOrInstance: LeaseIntent | LiveInstanceCostSource,
  nowMs: number = Date.now(),
  liveInstance?: LiveInstanceCostSource | null,
): number {
  let dph = 0;
  if (liveInstance && liveInstance.dph_total !== undefined && liveInstance.dph_total !== null) {
    dph = Number(liveInstance.dph_total);
  } else if ("dph_total" in leaseOrInstance && leaseOrInstance.dph_total !== undefined && leaseOrInstance.dph_total !== null) {
    dph = Number(leaseOrInstance.dph_total);
  } else if ("dphTotal" in leaseOrInstance && leaseOrInstance.dphTotal !== undefined) {
    dph = Number(leaseOrInstance.dphTotal);
  }

  let startMs = nowMs;
  if ("createdAtMs" in leaseOrInstance && typeof leaseOrInstance.createdAtMs === "number") {
    startMs = leaseOrInstance.createdAtMs;
  } else if ("start_date" in leaseOrInstance && typeof leaseOrInstance.start_date === "number") {
    startMs = leaseOrInstance.start_date * 1000;
  } else if (liveInstance && typeof liveInstance.start_date === "number") {
    startMs = liveInstance.start_date * 1000;
  }

  const hours = Math.max(0, nowMs - startMs) / 3_600_000;
  return hours * dph;
}

export interface ReapDecision {
  readonly instanceId: number;
  readonly reason: "expired" | "undeclared" | "over-budget";
}

/**
 * Decide which live instances to destroy. Deliberately conservative:
 *
 *  - An instance WITHOUT our label prefix is never touched. A human's own
 *    rental is not ours to kill (bounded blast radius, GUARD-001).
 *  - Ours + expired → reap.
 *  - Ours + not in declared state → reap as an orphan (the pre-rent-write crash
 *    window, or a run that died before recording).
 */
export function decideReaps(args: {
  live: ReadonlyArray<{ id: number; label?: string | null }>;
  declared: ReadonlyArray<Lease>;
  nowMs?: number;
}): ReapDecision[] {
  const nowMs = args.nowMs ?? Date.now();
  const declaredById = new Map(args.declared.map((l) => [l.instanceId, l]));
  const out: ReapDecision[] = [];

  for (const inst of args.live) {
    // Never destroy what we did not create.
    if (!isOurLabel(inst.label)) continue;

    const lease = declaredById.get(inst.id);
    if (!lease) {
      out.push({ instanceId: inst.id, reason: "undeclared" });
      continue;
    }
    if (isExpired(lease, nowMs)) {
      out.push({ instanceId: inst.id, reason: "expired" });
    }
  }
  return out;
}
