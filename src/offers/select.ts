// src/offers/select.ts
// =============================================================================
// Deterministic offer selection for Vast.ai rentals.
//
// Filters out undersized, overpriced, or unrentable offers, then sorts by:
//   1. reliability2 (higher is better)
//   2. dph_total (lower is better)
//   3. inet_down (higher is better)
//
// Zero matching offers surfaces as a typed error — NEVER a silent empty.
// =============================================================================

import { SPEND_LIMITS } from "../limits.js";
import { getWorkload, type WorkloadId, type WorkloadSpec } from "../workloads.js";

export interface VastOffer {
  readonly id: number;
  readonly gpu_name?: string;
  readonly num_gpus?: number;
  readonly gpu_ram: number;
  readonly disk_space: number;
  readonly dph_total: number;
  readonly rentable: boolean;
  readonly reliability2?: number;
  readonly inet_down?: number;
  readonly storage_cost?: number;
  readonly geolocation?: string;
  readonly [key: string]: unknown;
}

export class NoEligibleOffersError extends Error {
  readonly workload: WorkloadSpec;
  readonly totalOffersConsidered: number;

  constructor(workload: WorkloadSpec, totalOffersConsidered: number) {
    super(
      `No eligible offers found for workload "${workload.id}": ` +
        `required >=${workload.minGpuRamMb}MB VRAM, >=${workload.minDiskGb}GB disk, ` +
        `<=$${SPEND_LIMITS.maxDphTotal}/hr (evaluated ${totalOffersConsidered} offers)`,
    );
    this.name = "NoEligibleOffersError";
    this.workload = workload;
    this.totalOffersConsidered = totalOffersConsidered;
  }
}

/**
 * Filter and rank offers for a workload. Returns the single best matching offer
 * or throws NoEligibleOffersError if none qualify.
 */
export function selectOffer(
  workload: WorkloadSpec | WorkloadId,
  offers: readonly VastOffer[],
): VastOffer {
  const spec = typeof workload === "string" ? getWorkload(workload) : workload;

  const eligible = offers.filter((o) => {
    if (!o.rentable) return false;
    if (o.gpu_ram < spec.minGpuRamMb) return false;
    if (o.disk_space < spec.minDiskGb) return false;
    if (o.dph_total > SPEND_LIMITS.maxDphTotal) return false;
    return true;
  });

  if (eligible.length === 0) {
    throw new NoEligibleOffersError(spec, offers.length);
  }

  // Sort: prefer higher reliability2, then lower dph_total, then higher inet_down
  const sorted = [...eligible].sort((a, b) => {
    const relA = a.reliability2 ?? 0;
    const relB = b.reliability2 ?? 0;
    if (relA !== relB) {
      return relB - relA; // higher first
    }

    if (a.dph_total !== b.dph_total) {
      return a.dph_total - b.dph_total; // lower first
    }

    const netA = a.inet_down ?? 0;
    const netB = b.inet_down ?? 0;
    return netB - netA; // higher first
  });

  const best = sorted[0];
  if (!best) {
    throw new NoEligibleOffersError(spec, offers.length);
  }
  return best;
}
