// src/offers/select.ts
// =============================================================================
// Deterministic offer selection for Vast.ai rentals.
//
// Filters out undersized, overpriced, unrentable, or geo-excluded offers,
// then sorts candidates by:
//   1. reliability2 (higher is better)
//   2. dph_total (lower is better)
//   3. inet_down (higher is better)
//
// Zero matching offers surfaces as a typed error — NEVER a silent empty.
// =============================================================================

import { SPEND_LIMITS } from "../limits.js";
import { getWorkload, type WorkloadId, type WorkloadSpec } from "../workloads.js";

export const DEFAULT_MIN_CUDA = 12.8;

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
  readonly cuda_max_good?: number | string | null;
  readonly [key: string]: unknown;
}

export interface SelectOffersOptions {
  /** Country / region codes to exclude from candidate selection. Default: ["CN"]. */
  readonly excludeGeo?: readonly string[];
  /** Maximum hourly price in USD. Default: SPEND_LIMITS.maxDphTotal. */
  readonly maxDphTotal?: number;
  /** Minimum CUDA version required (from cuda_max_good). Default: DEFAULT_MIN_CUDA (12.8). */
  readonly minCuda?: number;
}

export class NoEligibleOffersError extends Error {
  readonly workload: WorkloadSpec;
  readonly totalOffersConsidered: number;

  constructor(workload: WorkloadSpec, totalOffersConsidered: number) {
    super(
      `No eligible offers found for workload "${workload.id}": ` +
        `required >=${workload.minGpuRamMb}MB VRAM, >=${workload.minDiskGb}GB disk, ` +
        `>=CUDA ${DEFAULT_MIN_CUDA}, ` +
        `<=$${SPEND_LIMITS.maxDphTotal}/hr (evaluated ${totalOffersConsidered} offers)`,
    );
    this.name = "NoEligibleOffersError";
    this.workload = workload;
    this.totalOffersConsidered = totalOffersConsidered;
  }
}

/**
 * Returns true if the offer's geolocation matches any excluded region code.
 * Excludes CN by default because hosts behind national firewalls routinely fail
 * to reach registries (ghcr.io, Hugging Face, etc.).
 */
export function isGeoExcluded(
  geolocation: string | undefined | null,
  excludeGeo: readonly string[] = ["CN"],
): boolean {
  if (!geolocation || excludeGeo.length === 0) return false;
  const upperGeo = geolocation.toUpperCase();
  return excludeGeo.some((code) => {
    const upperCode = code.trim().toUpperCase();
    if (!upperCode) return false;
    const regex = new RegExp(`\\b${upperCode}\\b`);
    return regex.test(upperGeo);
  });
}

/**
 * Filter and rank offers for a workload. Returns a list of all qualifying candidates
 * ordered by verified inet_down (> 0 before unmeasured), reliability2 desc,
 * dph_total asc, inet_down desc.
 * Throws NoEligibleOffersError if none qualify.
 */
export function selectCandidateOffers(
  workload: WorkloadSpec | WorkloadId,
  offers: readonly VastOffer[],
  options?: SelectOffersOptions,
): VastOffer[] {
  const spec = typeof workload === "string" ? getWorkload(workload) : workload;
  const maxDph = options?.maxDphTotal ?? SPEND_LIMITS.maxDphTotal;
  const excludeGeo = options?.excludeGeo ?? ["CN"];
  const minCuda = options?.minCuda !== undefined ? options.minCuda : DEFAULT_MIN_CUDA;

  const eligible = offers.filter((o) => {
    if (!o.rentable) return false;
    if (o.gpu_ram < spec.minGpuRamMb) return false;
    if (o.disk_space < spec.minDiskGb) return false;
    if (o.dph_total > maxDph) return false;
    if (isGeoExcluded(o.geolocation, excludeGeo)) return false;
    const cuda = o.cuda_max_good != null ? Number(o.cuda_max_good) : 0;
    if (cuda < minCuda) return false;
    return true;
  });

  if (eligible.length === 0) {
    throw new NoEligibleOffersError(spec, offers.length);
  }

  // Sort: prefer verified bandwidth (>0) over unmeasured (0/missing),
  // then higher reliability2, then lower dph_total, then higher inet_down
  return [...eligible].sort((a, b) => {
    const hasNetA = a.inet_down != null && a.inet_down > 0 ? 1 : 0;
    const hasNetB = b.inet_down != null && b.inet_down > 0 ? 1 : 0;
    if (hasNetA !== hasNetB) {
      return hasNetB - hasNetA; // verified first, 0/missing last resort
    }

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
}

/**
 * Filter and rank offers for a workload. Returns the single best matching offer
 * or throws NoEligibleOffersError if none qualify.
 */
export function selectOffer(
  workload: WorkloadSpec | WorkloadId,
  offers: readonly VastOffer[],
  options?: SelectOffersOptions,
): VastOffer {
  const candidates = selectCandidateOffers(workload, offers, options);
  const best = candidates[0];
  if (!best) {
    const spec = typeof workload === "string" ? getWorkload(workload) : workload;
    throw new NoEligibleOffersError(spec, offers.length);
  }
  return best;
}
