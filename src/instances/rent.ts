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
// =============================================================================

import { VastClient } from "../api/client.js";
import { canRent, SPEND_LIMITS } from "../limits.js";
import { getWorkload, type WorkloadId, type WorkloadSpec } from "../workloads.js";
import { makeLeaseIntent, type Lease, type LeaseIntent } from "./lease.js";
import { putLease, deleteLease, type KvOptions } from "../state/kv.js";
import { buildEmbeddingProvisionConfig, type WorkloadProvisionConfig } from "../provision/embedding.js";
import { type VastOffer } from "../offers/select.js";

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

  if (currentInstanceCount === undefined) {
    const instRes = await client.get<unknown>("/instances");
    let list: unknown[] = [];
    if (Array.isArray(instRes)) {
      list = instRes;
    } else if (instRes && typeof instRes === "object" && Array.isArray((instRes as { instances?: unknown[] }).instances)) {
      list = (instRes as { instances: unknown[] }).instances;
    }
    currentInstanceCount = list.length;
  }

  const decision = canRent({
    creditUsd,
    dphTotal: args.offer.dph_total,
    currentInstanceCount,
  });

  if (!decision.allowed) {
    throw new VastRentRefusalError(decision.reason);
  }

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
      throw new Error(`Vast.ai rent rejected: ${res.msg ?? res.error ?? "unknown reason"}`);
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
