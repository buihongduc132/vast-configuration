// src/instances/blocklist.ts
// =============================================================================
// Host blocklist for Vast.ai machines.
//
// ⚠️ INCIDENT HISTORY (2026-09-27):
// Machine 14338 (host 173.163.142.110) failed with
//   "OCI runtime create failed: could not apply required modification to OCI specification"
// in two consecutive runs because it wasn't blocklisted.
//
// Machine IDs with host-level failures or CPU fallback are recorded with timestamp
// and reason so future candidate selection skips them.
// A configurable TTL ensures machines are not banned permanently.
// Store path is injectable so tests NEVER touch ~/.vast-host-blocklist.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_BLOCKLIST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface BlocklistEntry {
  readonly machineId: number;
  readonly timestamp: string;
  readonly reason: string;
}

export interface HostBlocklistOptions {
  /** Path to blocklist file. Required in test environments to prevent touching real $HOME. */
  readonly filePath?: string;
  /** Expiration duration in ms. Default: 24h. */
  readonly ttlMs?: number;
  /** Injectable clock function for deterministic tests. */
  readonly now?: () => number;
  /** Warning logger callback for unparseable / corrupt lines. */
  readonly onWarning?: (warning: string) => void;
}

export function getDefaultBlocklistPath(): string {
  return (
    process.env.VAST_BLOCKLIST_FILE ||
    process.env.BLOCKLIST_FILE ||
    path.join(os.homedir(), ".vast-host-blocklist")
  );
}

export class HostBlocklist {
  readonly filePath: string;
  readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onWarning?: (warning: string) => void;

  constructor(options?: HostBlocklistOptions) {
    if (!options?.filePath) {
      if (process.env.NODE_ENV === "test" || process.env.VITEST) {
        throw new Error(
          "HostBlocklist requires an explicit filePath in tests to avoid touching $HOME/.vast-host-blocklist",
        );
      }
    }
    this.filePath = options?.filePath ?? getDefaultBlocklistPath();
    this.ttlMs = options?.ttlMs ?? DEFAULT_BLOCKLIST_TTL_MS;
    this.now = options?.now ?? (() => Date.now());
    this.onWarning = options?.onWarning;
  }

  /**
   * Load active (non-expired) blocklist entries.
   * Tolerates missing file, empty lines, and corrupt lines (fail-safe).
   */
  loadEntries(): BlocklistEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      this.onWarning?.(`Failed to read blocklist file ${this.filePath}: ${(err as Error).message}`);
      return [];
    }

    const lines = raw.split("\n");
    const entries: BlocklistEntry[] = [];
    const nowMs = this.now();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line || line.startsWith("#")) continue;

      const tokens = line.split(/\s+/);
      const machineIdStr = tokens[0];
      const machineId = Number(machineIdStr);

      if (!Number.isFinite(machineId) || machineId <= 0) {
        this.onWarning?.(`Ignoring corrupt line ${i + 1} in blocklist: "${line}"`);
        continue;
      }

      const timestampStr = tokens[1] ?? "";
      const reason = tokens.slice(2).join(" ") || "unspecified";

      // Validate timestamp and TTL
      const parsedTime = Date.parse(timestampStr);
      if (Number.isNaN(parsedTime)) {
        this.onWarning?.(
          `Invalid timestamp on line ${i + 1} for machine ${machineId}: "${timestampStr}"`,
        );
        // Fail-safe: treat entry with unparseable timestamp as still active (fail-closed)
        entries.push({ machineId, timestamp: timestampStr, reason });
        continue;
      }

      const age = nowMs - parsedTime;
      // If within TTL (not expired)
      if (age >= 0 && age < this.ttlMs) {
        entries.push({ machineId, timestamp: timestampStr, reason });
      }
    }

    return entries;
  }

  /**
   * Returns a set of currently blocked machine IDs (only active within TTL).
   */
  getBlockedMachineIds(): Set<number> {
    const entries = this.loadEntries();
    return new Set(entries.map((e) => e.machineId));
  }

  /**
   * Returns true if the given machine_id is currently blocked.
   */
  isBlocked(machineId: number | string | null | undefined): boolean {
    if (machineId == null) return false;
    const num = Number(machineId);
    if (!Number.isFinite(num)) return false;
    const blocked = this.getBlockedMachineIds();
    return blocked.has(num);
  }

  /**
   * Persist a machine to the blocklist.
   */
  async add(machineId: number | string, reason: string): Promise<void> {
    const num = Number(machineId);
    if (!Number.isFinite(num) || num <= 0) return;

    const dir = path.dirname(this.filePath);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const iso = new Date(this.now()).toISOString();
    const cleanReason = reason.replace(/[\r\n\t]/g, " ").trim();
    const line = `${num} ${iso} ${cleanReason}\n`;

    await fs.promises.appendFile(this.filePath, line, "utf8");
  }

  /** Synchronous version of add for non-async callers. */
  addSync(machineId: number | string, reason: string): void {
    const num = Number(machineId);
    if (!Number.isFinite(num) || num <= 0) return;

    const dir = path.dirname(this.filePath);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const iso = new Date(this.now()).toISOString();
    const cleanReason = reason.replace(/[\r\n\t]/g, " ").trim();
    const line = `${num} ${iso} ${cleanReason}\n`;

    fs.appendFileSync(this.filePath, line, "utf8");
  }

  /**
   * Filter offers, removing any offer whose machine_id is currently blocked.
   */
  filterOffers<T extends { machine_id?: unknown }>(offers: readonly T[]): T[] {
    const blocked = this.getBlockedMachineIds();
    if (blocked.size === 0) return [...offers];
    return offers.filter((o) => {
      if (o.machine_id == null) return true;
      const mid = Number(o.machine_id);
      return !blocked.has(mid);
    });
  }
}

export function loadBlocklist(filePath: string, options?: HostBlocklistOptions): Set<number> {
  const blocklist = new HostBlocklist({ ...options, filePath });
  return blocklist.getBlockedMachineIds();
}

export function isHostBlocked(
  machineId: number | string,
  options?: HostBlocklistOptions,
): boolean {
  const blocklist = new HostBlocklist(options);
  return blocklist.isBlocked(machineId);
}
