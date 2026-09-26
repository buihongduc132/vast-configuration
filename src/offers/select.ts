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
import { HostBlocklist, loadBlocklist } from "../instances/blocklist.js";

export const DEFAULT_MIN_CUDA = 12.8;

export interface VastOffer {
  readonly id: number;
  readonly machine_id?: number | string;
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
  /**
   * Hourly price ceiling in USD, per instance. STRICTLY under: an offer at
   * exactly this price is filtered out (VAST-SPEND-002).
   * Default: SPEND_LIMITS.maxDphPerInstance.
   */
  readonly maxDphPerInstance?: number;
  /** Minimum CUDA version required (from cuda_max_good). Default: DEFAULT_MIN_CUDA (12.8). */
  readonly minCuda?: number;
  /** Host blocklist instance, Set of blocked machine IDs, or array of blocked machine IDs. */
  readonly blocklist?: HostBlocklist | ReadonlySet<number | string> | readonly (number | string)[];
  /** Path to blocklist file to load dynamically. */
  readonly blocklistPath?: string;
  /** Blocklist TTL in milliseconds. */
  readonly blocklistTtlMs?: number;
  /** Clock override for blocklist expiry checks. */
  readonly now?: () => number;
}

export class NoEligibleOffersError extends Error {
  readonly workload: WorkloadSpec;
  readonly totalOffersConsidered: number;

  constructor(workload: WorkloadSpec, totalOffersConsidered: number) {
    super(
      `No eligible offers found for workload "${workload.id}": ` +
        `required >=${workload.minGpuRamMb}MB VRAM, >=${workload.minDiskGb}GB disk, ` +
        `>=CUDA ${DEFAULT_MIN_CUDA}, ` +
        `<$${SPEND_LIMITS.maxDphPerInstance}/hr (evaluated ${totalOffersConsidered} offers)`,
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
  const maxDph = options?.maxDphPerInstance ?? SPEND_LIMITS.maxDphPerInstance;
  const excludeGeo = options?.excludeGeo ?? ["CN"];
  const minCuda = options?.minCuda !== undefined ? options.minCuda : DEFAULT_MIN_CUDA;

  let blockedSet: ReadonlySet<number | string> | undefined;
  if (options?.blocklist) {
    if (typeof options.blocklist === "object" && "getBlockedMachineIds" in options.blocklist) {
      blockedSet = options.blocklist.getBlockedMachineIds();
    } else if (options.blocklist instanceof Set) {
      blockedSet = options.blocklist;
    } else if (Array.isArray(options.blocklist)) {
      blockedSet = new Set(options.blocklist);
    }
  } else if (options?.blocklistPath) {
    try {
      blockedSet = loadBlocklist(options.blocklistPath, {
        ttlMs: options.blocklistTtlMs,
        now: options.now,
      });
    } catch {
      // Fail safe: unreadable blocklist must not crash selection
    }
  }

  const eligible = offers.filter((o) => {
    if (!o.rentable) return false;
    if (o.gpu_ram < spec.minGpuRamMb) return false;
    if (o.disk_space < spec.minDiskGb) return false;
    // STRICTLY under the cap, matching VAST-SPEND-002. An offer at exactly the
    // cap is filtered here so it never reaches the OPA gate and gets refused
    // later — the filter and the gate must agree on the boundary.
    if (o.dph_total >= maxDph) return false;
    if (isGeoExcluded(o.geolocation, excludeGeo)) return false;
    const cuda = o.cuda_max_good != null ? Number(o.cuda_max_good) : 0;
    if (cuda < minCuda) return false;
    if (o.machine_id != null && blockedSet) {
      const midNum = Number(o.machine_id);
      const midStr = String(o.machine_id);
      if (blockedSet.has(midNum) || (blockedSet as ReadonlySet<unknown>).has(midStr)) {
        return false;
      }
    }
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
