// src/instances/rent.ts
// =============================================================================
// Rental lifecycle: spend-ceiling gate, pre-rent intent recording, API rent call,
// and durable lease registration.
//
// ⚠️ CRASH SAFETY DISCIPLINE:
// The lease intent MUST be written to Consul KV BEFORE the rent API call.
// The dangerous window is between "API created the instance" and "we recorded
// its id". By writing the intent first with a unique greppable label, an
// independent reaper can find and clean up the instance if our process dies.
//
// ⚠️ FOOTGUN RESOLUTIONS (verified live 2026-09-27):
// 1. Offer volatility: an offer can vanish between search and rent. The API
//    answers `no_such_ask` / `invalid_args`. We catch this, clean up intent,
//    and advance across a ranked candidate list.
// 2. Price ceiling re-assertion: every candidate retry re-asserts the cap.
// 3. Host-level failure: detect early via status_msg, destroy, advance.
// =============================================================================

import { VastClient } from "../api/client.js";
import { canRent, SPEND_LIMITS } from "../limits.js";
import { assertRentAllowed, type GateInput, type GateVerdict } from "../policy/gate.js";
import { getWorkload, type WorkloadId, type WorkloadSpec } from "../workloads.js";
import { makeLeaseIntent, type Lease, type LeaseIntent } from "./lease.js";
import { putLease, deleteLease, type KvOptions } from "../state/kv.js";
import { buildEmbeddingProvisionConfig, type WorkloadProvisionConfig } from "../provision/embedding.js";
import { type VastOffer, NoEligibleOffersError } from "../offers/select.js";
import { destroyInstance } from "./destroy.js";
import {
  waitForInstanceReady,
  FatalHostError,
  TerminalInstanceStateError,
  CpuBackendError,
  assertBackendVerified,
  PRE_CONTAINER_START_DEADLINE_MS,
} from "./status.js";
import { HostBlocklist } from "./blocklist.js";
import { verifyBackendDevice } from "../provision/verify.js";

/** Token the operator must set in VAST_LIVE_CONFIRM to authorize renting real GPUs. */
export const RENT_CONFIRM_TOKEN = "i-accept-gpu-rental-charges";

export class VastRentRefusalError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Vast.ai rent refused by spend ceiling: ${reason}`);
    this.name = "VastRentRefusalError";
    this.reason = reason;
  }
}

export class VastNoSuchAskError extends Error {
  readonly offerId: number;
  readonly details?: unknown;

  constructor(offerId: number, message: string, details?: unknown) {
    super(`Vast.ai offer ${offerId} unavailable: ${message}`);
    this.name = "VastNoSuchAskError";
    this.offerId = offerId;
    this.details = details;
  }
}

/** Check if an error represents offer volatility (no_such_ask or invalid_args). */
export function isNoSuchAskError(err: unknown): boolean {
  if (err instanceof VastNoSuchAskError) return true;
  if (!err || typeof err !== "object") return false;
  const msg = (err as Error).message?.toLowerCase() ?? "";
  if (msg.includes("no_such_ask") || msg.includes("not available")) return true;
  if ("body" in err && err.body && typeof err.body === "object") {
    const b = err.body as Record<string, unknown>;
    const bErr = String(b.error ?? "").toLowerCase();
    const bMsg = String(b.msg ?? "").toLowerCase();
    if (bErr === "invalid_args" || bMsg.includes("no_such_ask") || bMsg.includes("not available")) {
      return true;
    }
  }
  return false;
}

export interface RentInstanceArgs {
  readonly workload: WorkloadSpec | WorkloadId;
  readonly offer: VastOffer;
  readonly owner?: string;
  readonly maxLifetimeMinutes?: number;
  readonly client?: VastClient;
  readonly kvOptions?: KvOptions;
  /** Provisioning config override (e.g. for testing). */
  readonly provisionConfig?: WorkloadProvisionConfig;
  /** Hook to override putLease (e.g. for testing). */
  readonly putLeaseFn?: (lease: Lease | LeaseIntent) => Promise<void>;
  /** Hook to override deleteLease (e.g. for testing). */
  readonly deleteLeaseFn?: (label: string) => Promise<void>;
  /** Credit override (if already queried). */
  readonly creditUsd?: number;
  /** Instance count override (if already queried). */
  readonly currentInstanceCount?: number;
  /**
   * The instances currently on the account, if already queried. Passed to the
   * OPA gate, which refuses a bare count so a caller cannot understate
   * concurrency.
   */
  readonly liveInstances?: readonly unknown[];
  /**
   * Test seam for the OPA gate. Defaults to the real `assertRentAllowed`, i.e.
   * the gate is ON unless a test explicitly replaces it. A gate that must be
   * opted into is not a gate.
   */
  readonly assertGateFn?: (input: GateInput) => Promise<GateVerdict>;
}

export interface RentResult {
  readonly instanceId: number;
  readonly label: string;
  readonly dphTotal: number;
}

export async function rentInstance(args: RentInstanceArgs): Promise<RentResult> {
  const spec = typeof args.workload === "string" ? getWorkload(args.workload) : args.workload;
  const client = args.client ?? new VastClient();

  // 1. Check spend ceilings BEFORE any money-spending action
  let creditUsd = args.creditUsd;
  let currentInstanceCount = args.currentInstanceCount;

  if (creditUsd === undefined) {
    const user = await client.get<Record<string, unknown>>("/users/current");
    creditUsd = Number(user.credit ?? 0);
  }

  // The LIST is kept, not just its length: the OPA gate refuses a bare count so
  // a caller cannot understate concurrency.
  let liveInstances: readonly unknown[] | undefined = args.liveInstances;

  if (liveInstances === undefined) {
    if (currentInstanceCount === undefined) {
      const instRes = await client.get<unknown>("/instances");
      let list: unknown[] = [];
      if (Array.isArray(instRes)) {
        list = instRes;
      } else if (
        instRes &&
        typeof instRes === "object" &&
        Array.isArray((instRes as { instances?: unknown[] }).instances)
      ) {
        list = (instRes as { instances: unknown[] }).instances;
      }
      liveInstances = list;
      currentInstanceCount = list.length;
    } else {
      // A count was supplied without the list (test/caller override). The policy
      // only ever counts, so stand in opaque placeholders of the right length
      // rather than inventing instance shapes.
      liveInstances = Array.from({ length: currentInstanceCount }, () => ({
        _placeholder: "count-only override",
      }));
    }
  } else if (currentInstanceCount === undefined) {
    currentInstanceCount = liveInstances.length;
  }

  // Local ceiling check first: fast, and it needs no subprocess.
  const decision = canRent({
    creditUsd,
    dphTotal: args.offer.dph_total,
    currentInstanceCount,
  });

  if (!decision.allowed) {
    throw new VastRentRefusalError(decision.reason);
  }

  // AUTHORITATIVE gate: policies/rego/vast_spend.rego via OPA. This throws on a
  // denial AND on any failure to obtain a verdict, so "could not ask the policy"
  // can never be mistaken for "the policy said yes". Deliberately placed before
  // the lease-intent write — nothing at all should happen for a refused rent.
  const assertGate = args.assertGateFn ?? ((i: GateInput) => assertRentAllowed(i));
  await assertGate({
    action: "rent",
    candidate: {
      id: args.offer.id,
      dph_total: args.offer.dph_total,
      ...(typeof args.offer.machine_id === "number" ? { machine_id: args.offer.machine_id } : {}),
    },
    live_instances: liveInstances,
  });

  // 2. Prepare lease intent and write to Consul KV BEFORE rent call
  const owner = args.owner ?? "cli";
  const maxLifetimeMinutes = args.maxLifetimeMinutes ?? SPEND_LIMITS.maxLifetimeMinutes;
  const intent = makeLeaseIntent({
    workload: spec.id,
    offerId: args.offer.id,
    dphTotal: args.offer.dph_total,
    owner,
    maxLifetimeMinutes,
  });

  const recordIntent = args.putLeaseFn ?? ((l) => putLease(l, args.kvOptions));
  const removeIntent = args.deleteLeaseFn ?? ((label) => deleteLease(label, args.kvOptions));

  await recordIntent(intent);

  // 3. Resolve provisioning config
  let provision = args.provisionConfig;
  if (!provision) {
    if (spec.id === "embedding") {
      provision = await buildEmbeddingProvisionConfig();
    } else {
      // Basic fallback for other workloads (e.g. qwen)
      provision = {
        image: "vllm/vllm-openai:latest",
        args: [],
        port: spec.port,
        env: {},
        onstart: `#!/usr/bin/env bash\necho "[vast-offload] Starting ${spec.id}..."\n`,
      };
    }
  }

  // 4. Rent API call: PUT /asks/<offer_id>/
  const rentBody = {
    client_id: "me",
    image: provision.image,
    disk: Math.max(spec.minDiskGb, Math.ceil(args.offer.disk_space)),
    label: intent.label,
    onstart: provision.onstart,
    env: provision.env,
    runtype: "ssh",
  };

  let instanceId: number | undefined;

  try {
    const res = await client.put<{
      success?: boolean;
      new_contract?: number;
      instance_id?: number;
      id?: number;
      msg?: string;
      error?: string;
    }>(`/asks/${args.offer.id}`, rentBody);

    if (res.success === false) {
      const msg = res.msg ?? res.error ?? "unknown reason";
      if (
        res.error === "invalid_args" ||
        msg.toLowerCase().includes("no_such_ask") ||
        msg.toLowerCase().includes("not available")
      ) {
        throw new VastNoSuchAskError(args.offer.id, msg, res);
      }
      throw new Error(`Vast.ai rent rejected: ${msg}`);
    }

    const idCandidate = res.new_contract ?? res.instance_id ?? res.id;
    if (typeof idCandidate === "number" && Number.isFinite(idCandidate) && idCandidate > 0) {
      instanceId = idCandidate;
    } else {
      throw new Error(
        `Vast.ai rent returned unexpected response without contract ID: ${JSON.stringify(res)}`,
      );
    }
  } catch (err) {
    // On failure clean up the intent from KV
    try {
      await removeIntent(intent.label);
    } catch {
      // Don't mask the primary rent failure if KV cleanup errors
    }
    if (isNoSuchAskError(err)) {
      if (err instanceof VastNoSuchAskError) {
        throw err;
      }
      throw new VastNoSuchAskError(
        args.offer.id,
        (err as Error).message,
        (err as { body?: unknown }).body,
      );
    }
    throw err;
  }

  // 5. On success record instanceId into the same KV key
  const confirmedLease: Lease = {
    ...intent,
    instanceId,
  };

  await recordIntent(confirmedLease);

  return {
    instanceId,
    label: intent.label,
    dphTotal: intent.dphTotal,
  };
}

export interface RentCandidatesArgs {
  readonly workload: WorkloadSpec | WorkloadId;
  readonly candidates: readonly VastOffer[];
  readonly maxAttempts?: number;
  readonly owner?: string;
  readonly maxLifetimeMinutes?: number;
  readonly client?: VastClient;
  readonly kvOptions?: KvOptions;
  readonly provisionConfig?: WorkloadProvisionConfig;
  readonly putLeaseFn?: (lease: Lease | LeaseIntent) => Promise<void>;
  readonly deleteLeaseFn?: (label: string) => Promise<void>;
  readonly creditUsd?: number;
  readonly currentInstanceCount?: number;
  readonly liveInstances?: readonly unknown[];
  /** Test seam for the OPA gate; forwarded to every candidate attempt. */
  readonly assertGateFn?: (input: GateInput) => Promise<GateVerdict>;
  readonly rentInstanceFn?: (args: RentInstanceArgs) => Promise<RentResult>;
  readonly destroyFn?: (instanceId: number) => Promise<unknown>;
  readonly waitForReady?: boolean;
  readonly verifyBackend?: boolean;
  readonly fetchLogsFn?: (instanceId: number) => Promise<string>;
  readonly onWarning?: (warning: string) => void;
  readonly candidateDeadlineMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly blocklist?: HostBlocklist;
  readonly blocklistPath?: string;
}

/**
 * Walk a ranked candidate list and advance to the next candidate when the rent call
 * returns no_such_ask / invalid_args or when host-level failure is detected.
 * Bounded by maxAttempts. Re-asserts the spend ceiling per candidate.
 */
export async function rentFirstAvailable(args: RentCandidatesArgs): Promise<RentResult> {
  const spec = typeof args.workload === "string" ? getWorkload(args.workload) : args.workload;
  const candidates = args.candidates;

  if (!candidates || candidates.length === 0) {
    throw new NoEligibleOffersError(spec, 0);
  }

  const maxAttempts = Math.min(args.maxAttempts ?? 4, candidates.length);
  const client = args.client ?? new VastClient();
  const rentFn = args.rentInstanceFn ?? rentInstance;
  const destroyFn =
    args.destroyFn ?? ((id) => destroyInstance(id, { client, kvOptions: args.kvOptions }));
  const sleep = args.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = args.now ?? (() => Date.now());
  const blocklist =
    args.blocklist ??
    (args.blocklistPath ? new HostBlocklist({ filePath: args.blocklistPath, now }) : undefined);

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = candidates[attempt]!;

    // Re-assert the price ceiling per candidate — never rent at or above the cap
    // on a retry. STRICTLY under, matching VAST-SPEND-002.
    if (candidate.dph_total >= SPEND_LIMITS.maxDphPerInstance) {
      throw new VastRentRefusalError(
        `offer $${candidate.dph_total.toFixed(4)}/hr is not strictly under the $${SPEND_LIMITS.maxDphPerInstance}/hr per-instance cap`,
      );
    }

    let rentResult: RentResult;
    try {
      rentResult = await rentFn({
        workload: spec,
        offer: candidate,
        owner: args.owner,
        maxLifetimeMinutes: args.maxLifetimeMinutes,
        client,
        kvOptions: args.kvOptions,
        provisionConfig: args.provisionConfig,
        putLeaseFn: args.putLeaseFn,
        deleteLeaseFn: args.deleteLeaseFn,
        creditUsd: args.creditUsd,
        currentInstanceCount: args.currentInstanceCount,
        liveInstances: args.liveInstances,
        // Forwarded so every retry passes the same gate as the first attempt.
        assertGateFn: args.assertGateFn,
      });
    } catch (err) {
      if (isNoSuchAskError(err)) {
        lastError = err as Error;
        continue;
      }
      throw err;
    }

    if (args.waitForReady) {
      try {
        const readyInstance = await waitForInstanceReady(rentResult.instanceId, {
          client,
          timeoutMs: args.candidateDeadlineMs ?? PRE_CONTAINER_START_DEADLINE_MS,
          pollIntervalMs: args.pollIntervalMs ?? 15_000,
          sleep,
          now,
        });

        // Backend device assertion: CPU fallback or unverified must be treated as fatal-host failure
        if (args.verifyBackend) {
          const backendResult = await verifyBackendDevice(rentResult.instanceId, {
            client,
            fetchLogs: args.fetchLogsFn,
            onWarning: args.onWarning,
          });
          assertBackendVerified(backendResult, rentResult.instanceId);
        }

        // Live instance price update (price drift)
        const actualDph =
          readyInstance.dph_total != null ? Number(readyInstance.dph_total) : rentResult.dphTotal;

        return {
          instanceId: rentResult.instanceId,
          label: rentResult.label,
          dphTotal: actualDph,
        };
      } catch (err) {
        if (err instanceof FatalHostError || err instanceof TerminalInstanceStateError) {
          // Record machine to blocklist if machine_id is known
          if (candidate.machine_id != null && blocklist) {
            const reason =
              err instanceof CpuBackendError
                ? "cpu-fallback"
                : err instanceof FatalHostError
                  ? `host-fail:${err.statusMsg}`
                  : `terminal:${(err as TerminalInstanceStateError).actualStatus}`;
            await blocklist.add(candidate.machine_id, reason).catch(() => {});
          }

          // Host-level failure or terminal state on this box: destroy and advance
          await destroyFn(rentResult.instanceId);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    return rentResult;
  }

  throw lastError ?? new Error(`Failed to rent after ${maxAttempts} attempt(s)`);
}

export const rentCandidateOffers = rentFirstAvailable;
