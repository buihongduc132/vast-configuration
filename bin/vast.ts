#!/usr/bin/env -S npx tsx
// bin/vast.ts
// =============================================================================
// CLI entry for Vast.ai offload management.
//
// Read-only commands work today. Money-spending commands (rent/destroy) are
// declared but refuse to run until the spend-ceiling enforcement and the reaper
// are wired — a half-built rent path is worse than none, because the failure
// mode is a billed GPU nobody is tracking.
// =============================================================================
import { buildUrl, normalizeGpuName } from "../src/api/url.js";
import { WORKLOADS, getWorkload, type WorkloadId } from "../src/workloads.js";
import { SPEND_LIMITS } from "../src/limits.js";
import { accruedCostUsd, isOurLabel } from "../src/instances/lease.js";

const USAGE = `vast — Vast.ai offload management

Read-only:
  whoami                 Account id, credit remaining, can-pay status
  instances              Current rentals + hourly burn + accrued cost
  offers <workload>      Rentable offers meeting a workload's requirements
  workloads              Declared workloads and their GPU requirements
  limits                 Spend ceilings enforced before any rent

Not yet implemented (deliberately refuse rather than half-work):
  rent <workload>        Rent + provision  [blocked: needs reaper + ceiling enforcement]
  destroy <instance-id>  Destroy a rental  [blocked: needs positive teardown verification]
  reap                   Destroy expired/orphaned rentals  [blocked: not implemented]

Credentials: Consul KV creds/vast/api_key, or env VAST_API_KEY.
`;

const NOT_IMPLEMENTED = new Set(["rent", "destroy", "reap"]);

/** Read the key WITHOUT ever putting it on a command line (argv is world-readable). */
async function apiKey(): Promise<string> {
  const fromEnv = process.env.VAST_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run("consul", ["kv", "get", "creds/vast/api_key"]);
    const key = stdout.trim();
    if (!key) throw new Error("empty value");
    return key;
  } catch (err) {
    throw new Error(
      "could not read the Vast.ai API key. Set VAST_API_KEY, or ensure " +
        "`consul kv get creds/vast/api_key` works. " +
        `(underlying: ${(err as Error).message})`,
    );
  }
}

async function api<T>(path: string, query?: Record<string, unknown>): Promise<T> {
  const key = await apiKey();
  const url = buildUrl(path, query as Record<string, string | number | boolean | object>);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  // FOOTGUN (verified 2026-09-27): an INVALID key returns HTTP **404** with
  // {"success":false,"error":"auth_error"} — not 401/403. A missing header
  // returns 403. So status alone cannot classify auth failure: a naive handler
  // reads the 404 as "not found" and may retry it forever, or treat it as empty.
  // Discriminate on the BODY.
  if (!res.ok) {
    let body: { error?: string; msg?: string } = {};
    try {
      body = (await res.clone().json()) as typeof body;
    } catch {
      /* non-JSON error body — fall through to the generic message */
    }
    if (body.error === "auth_error" || res.status === 401 || res.status === 403) {
      // Never retry: it will never succeed, and retry loops against a billing
      // API are their own hazard.
      throw new Error(
        `auth rejected (HTTP ${res.status}: ${body.msg ?? body.error ?? "no detail"}). ` +
          `The key is invalid or revoked — not retrying.`,
      );
    }
    throw new Error(`HTTP ${res.status} from ${path}${body.msg ? `: ${body.msg}` : ""}`);
  }
  return (await res.json()) as T;
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
      ? accruedCostUsd(
          {
            label: label ?? "", workload: "?", offerId: 0, dphTotal: dph,
            createdAtMs: startMs, expiresAtMs: Number.MAX_SAFE_INTEGER, owner: "?",
          },
          Date.now(),
        )
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
  // gpu_name MUST use spaces; normalizeGpuName converts the underscore form that
  // would otherwise return 0 offers with HTTP 200.
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
  const offers = (r.offers ?? []).filter(
    (o) =>
      Number(o.gpu_ram ?? 0) >= w.minGpuRamMb &&
      Number(o.disk_space ?? 0) >= w.minDiskGb &&
      Number(o.dph_total ?? Infinity) <= SPEND_LIMITS.maxDphTotal,
  );
  console.log(
    `workload ${w.id}: needs >=${(w.minGpuRamMb / 1024).toFixed(0)}GiB VRAM, ` +
      `>=${w.minDiskGb}GiB disk, <=$${SPEND_LIMITS.maxDphTotal}/hr\n`,
  );
  if (offers.length === 0) {
    // An empty result is an explicit condition, not a silent no-op.
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

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }
  if (NOT_IMPLEMENTED.has(cmd)) {
    console.error(
      `"${cmd}" is not implemented yet and will not be faked.\n` +
        `It spends money, so it stays blocked until the spend ceiling is enforced\n` +
        `pre-call and the reaper can clean up a crashed run. See the plan:\n` +
        `noco-mesh-infra/flow/plans/vast-ai-gpu-offload.md`,
    );
    process.exitCode = 2;
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
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
});
