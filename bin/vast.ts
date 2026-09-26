#!/usr/bin/env -S npx tsx
// bin/vast.ts
// =============================================================================
// CLI entry for Vast.ai offload management.
//
// Read-only commands: whoami, instances, offers, workloads, limits.
// Lifecycle commands: rent, destroy, reap.
//
// Money-spending commands (rent) require the explicit confirmation token
// VAST_LIVE_CONFIRM=i-accept-gpu-rental-charges before doing anything.
// =============================================================================
import { normalizeGpuName } from "../src/api/url.js";
import { VastClient } from "../src/api/client.js";
import { WORKLOADS, getWorkload, type WorkloadId } from "../src/workloads.js";
import { SPEND_LIMITS } from "../src/limits.js";
import { accruedCostUsd, isOurLabel } from "../src/instances/lease.js";
import { selectOffer, selectCandidateOffers, type VastOffer } from "../src/offers/select.js";
import { rentInstance, rentFirstAvailable, RENT_CONFIRM_TOKEN } from "../src/instances/rent.js";
import { destroyInstance } from "../src/instances/destroy.js";
import { reapOrphans } from "../src/instances/reap.js";

const USAGE = `vast — Vast.ai offload management

Read-only:
  whoami                 Account id, credit remaining, can-pay status
  instances              Current rentals + hourly burn + accrued cost
  offers <workload>      Rentable offers meeting a workload's requirements
  workloads              Declared workloads and their GPU requirements
  limits                 Spend ceilings enforced before any rent

Lifecycle:
  rent <workload>        Rent + provision (requires VAST_LIVE_CONFIRM=i-accept-gpu-rental-charges)
  destroy <instance-id>  Destroy a rental with positive teardown verification
  reap                   Destroy expired/orphaned rentals (bounded: max 3)

Credentials: Consul KV creds/vast/api_key, or env VAST_API_KEY.
`;

const client = new VastClient();

async function api<T>(
  path: string,
  query?: Record<string, string | number | boolean | object | undefined>,
): Promise<T> {
  return client.get<T>(path, query);
}

async function cmdWhoami(): Promise<void> {
  const u = await api<Record<string, unknown>>("/users/current");
  console.log(`id:       ${u.id}`);
  console.log(`email:    ${u.email}`);
  console.log(`credit:   $${Number(u.credit ?? 0).toFixed(2)}`);
  console.log(`balance:  $${Number(u.balance ?? 0).toFixed(2)}`);
  console.log(`can_pay:  ${u.can_pay}`);
  const credit = Number(u.credit ?? 0);
  if (credit <= SPEND_LIMITS.minCreditFloorUsd) {
    console.log(
      `\n⚠️  credit $${credit.toFixed(2)} is at or below the $${SPEND_LIMITS.minCreditFloorUsd.toFixed(2)} floor — rentals must be refused.`,
    );
  }
}

async function cmdInstances(): Promise<void> {
  const r = await api<{ instances?: Array<Record<string, unknown>> }>("/instances");
  const list = r.instances ?? [];
  if (list.length === 0) {
    console.log("no rentals");
    return;
  }
  let burn = 0;
  for (const i of list) {
    const dph = Number(i.dph_total ?? 0);
    burn += dph;
    const startMs = Number(i.start_date ?? 0) * 1000;
    const label = (i.label as string | null) ?? null;
    const mine = isOurLabel(label) ? "ours" : "FOREIGN (never auto-destroy)";
    const cost = startMs
      ? accruedCostUsd(i, Date.now())
      : 0;
    console.log(
      `${i.id}  ${String(i.gpu_name)}  $${dph.toFixed(4)}/hr  util ${i.gpu_util ?? "?"}%  ` +
        `accrued ~$${cost.toFixed(2)}  [${mine}]  label=${label ?? "(none)"}`,
    );
  }
  console.log(
    `\nhourly burn: $${burn.toFixed(4)}/hr  →  $${(burn * 24).toFixed(2)}/day  $${(burn * 24 * 30).toFixed(2)}/mo`,
  );
}

async function cmdOffers(workloadId: string): Promise<void> {
  const w = getWorkload(workloadId as WorkloadId);
  const gpu = normalizeGpuName(process.env.VAST_GPU ?? "RTX 3090");
  const r = await api<{ offers?: Array<Record<string, unknown>> }>("/bundles", {
    q: {
      gpu_name: { eq: gpu },
      rentable: { eq: true },
      num_gpus: { eq: 1 },
      order: [["dph_total", "asc"]],
      limit: 20,
      type: "on-demand",
    },
  });
  const rawOffers = (r.offers ?? []) as unknown as VastOffer[];
  let offers: VastOffer[] = [];
  try {
    offers = selectCandidateOffers(w, rawOffers);
  } catch {
    offers = [];
  }
  console.log(
    `workload ${w.id}: needs >=${(w.minGpuRamMb / 1024).toFixed(0)}GiB VRAM, ` +
      `>=${w.minDiskGb}GiB disk, <=$${SPEND_LIMITS.maxDphTotal}/hr\n`,
  );
  if (offers.length === 0) {
    console.log(`NO ELIGIBLE OFFERS for gpu_name="${gpu}".`);
    process.exitCode = 3;
    return;
  }
  for (const o of offers.slice(0, 10)) {
    console.log(
      `offer ${o.id}  $${Number(o.dph_total).toFixed(4)}/hr  ` +
        `${(Number(o.gpu_ram) / 1024).toFixed(0)}GiB  disk ${Number(o.disk_space).toFixed(0)}GiB  ` +
        `storage $${Number(o.storage_cost ?? 0).toFixed(3)}/GB/mo  ` +
        `rel ${Number(o.reliability2 ?? 0).toFixed(3)}  ${o.geolocation}`,
    );
  }
}

function cmdWorkloads(): void {
  for (const w of Object.values(WORKLOADS)) {
    console.log(
      `${w.id.padEnd(10)} ${w.model}\n` +
        `  VRAM >=${(w.minGpuRamMb / 1024).toFixed(0)}GiB  disk >=${w.minDiskGb}GiB  ` +
        `port ${w.port}  cold-start budget ${w.coldStartBudgetSec}s  weights ~${w.weightsSizeGb}GiB`,
    );
  }
}

function cmdLimits(): void {
  console.log(`max concurrent instances: ${SPEND_LIMITS.maxConcurrentInstances}`);
  console.log(`max hourly price:         $${SPEND_LIMITS.maxDphTotal}`);
  console.log(`max lifetime:             ${SPEND_LIMITS.maxLifetimeMinutes} min`);
  console.log(`min credit floor:         $${SPEND_LIMITS.minCreditFloorUsd}`);
}

async function cmdRent(workloadArg?: string): Promise<void> {
  // Confirm token check is mandatory before renting
  if (process.env.VAST_LIVE_CONFIRM !== RENT_CONFIRM_TOKEN) {
    console.error(
      `renting a GPU spends real money. Set VAST_LIVE_CONFIRM=${RENT_CONFIRM_TOKEN} to proceed.`,
    );
    process.exitCode = 2;
    return;
  }

  if (!workloadArg) {
    console.error(`usage: vast rent <${Object.keys(WORKLOADS).join("|")}>`);
    process.exitCode = 1;
    return;
  }

  const workload = getWorkload(workloadArg as WorkloadId);
  const gpu = normalizeGpuName(process.env.VAST_GPU ?? "RTX 3090");

  console.log(`Searching offers for ${workload.id} (${gpu})...`);
  const r = await api<{ offers?: Array<Record<string, unknown>> }>("/bundles", {
    q: {
      gpu_name: { eq: gpu },
      rentable: { eq: true },
      num_gpus: { eq: 1 },
      order: [["dph_total", "asc"]],
      limit: 20,
      type: "on-demand",
    },
  });

  const rawOffers = (r.offers ?? []) as unknown as VastOffer[];
  const candidates = selectCandidateOffers(workload, rawOffers);

  console.log(
    `Found ${candidates.length} candidate offer(s) (top: ${candidates[0]?.id}, ` +
      `$${candidates[0]?.dph_total.toFixed(4)}/hr, rel ${candidates[0]?.reliability2 ?? "?"}). Renting...`,
  );

  const res = await rentFirstAvailable({
    workload,
    candidates,
    client,
  });

  console.log(
    `Successfully rented instance ${res.instanceId} (${res.label}) at $${res.dphTotal.toFixed(4)}/hr`,
  );
}

async function cmdDestroy(idArg?: string): Promise<void> {
  if (!idArg) {
    console.error("usage: vast destroy <instance-id>");
    process.exitCode = 1;
    return;
  }
  const id = Number(idArg);
  if (!Number.isFinite(id) || id <= 0) {
    console.error(`invalid instance id: ${idArg}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Destroying instance ${id} and verifying teardown...`);
  const res = await destroyInstance(id, { client });
  console.log(
    `Destroyed instance ${res.instanceId} (verified after ${res.polls} polls, ${(res.durationMs / 1000).toFixed(1)}s)`,
  );
}

async function cmdReap(): Promise<void> {
  console.log("Scanning for expired or orphaned rentals...");
  const res = await reapOrphans({ client });
  console.log(
    `Reap completed: scanned ${res.liveCount} live instance(s), made ${res.decisions.length} decision(s), destroyed ${res.reaped.length} instance(s)`,
  );
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }

  switch (cmd) {
    case "whoami": return void (await cmdWhoami());
    case "instances": return void (await cmdInstances());
    case "offers":
      if (!arg) {
        console.error(`usage: vast offers <${Object.keys(WORKLOADS).join("|")}>`);
        process.exitCode = 1;
        return;
      }
      return void (await cmdOffers(arg));
    case "workloads": return cmdWorkloads();
    case "limits": return cmdLimits();
    case "rent": return void (await cmdRent(arg));
    case "destroy": return void (await cmdDestroy(arg));
    case "reap": return void (await cmdReap());
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
});
