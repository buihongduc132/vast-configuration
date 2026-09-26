// src/state/kv.ts
// =============================================================================
// Durable rental state stored in Consul KV under `vast/leases/`.
//
// ⚠️ Every command uses execFile with an argv array — NEVER shell string
// interpolation. This prevents shell injection and quoting bugs.
//
// A rental intent is written to Consul KV BEFORE the rent call, so that an
// independent reaper can find and destroy the instance if the renting process
// dies in the window between instance creation and state recording.
// =============================================================================

import type { Lease, LeaseIntent } from "../instances/lease.js";

export const VAST_LEASES_PREFIX = "vast/leases/";

export type ExecFileRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecRunner: ExecFileRunner = async (file, args) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile)(file, args as string[], { encoding: "utf8" });
};

export interface KvOptions {
  readonly execRunner?: ExecFileRunner;
  readonly prefix?: string;
}

function resolveKey(label: string, prefix: string = VAST_LEASES_PREFIX): string {
  if (label.startsWith(prefix)) return label;
  return `${prefix}${label}`;
}

/**
 * Record a lease intent or confirmed lease in Consul KV.
 */
export async function putLease(
  lease: Lease | LeaseIntent,
  options?: KvOptions,
): Promise<void> {
  const runner = options?.execRunner ?? defaultExecRunner;
  const key = resolveKey(lease.label, options?.prefix);
  const data = JSON.stringify(lease);
  await runner("consul", ["kv", "put", key, data]);
}

/**
 * Read a lease by label from Consul KV. Returns null if not found.
 */
export async function getLease(
  label: string,
  options?: KvOptions,
): Promise<Lease | LeaseIntent | null> {
  const runner = options?.execRunner ?? defaultExecRunner;
  const key = resolveKey(label, options?.prefix);
  try {
    const { stdout } = await runner("consul", ["kv", "get", key]);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as Lease | LeaseIntent;
  } catch (err) {
    const msg = (err as Error).message || "";
    // Consul CLI exits 1 with "No key exists" when key is absent
    if (msg.includes("No key exists") || (err as { code?: number }).code === 1) {
      return null;
    }
    throw err;
  }
}

/**
 * Delete a lease by label from Consul KV.
 */
export async function deleteLease(
  label: string,
  options?: KvOptions,
): Promise<void> {
  const runner = options?.execRunner ?? defaultExecRunner;
  const key = resolveKey(label, options?.prefix);
  await runner("consul", ["kv", "delete", key]);
}

/**
 * List all leases stored under the `vast/leases/` prefix.
 */
export async function listLeases(
  options?: KvOptions,
): Promise<Array<Lease | LeaseIntent>> {
  const runner = options?.execRunner ?? defaultExecRunner;
  const prefix = options?.prefix ?? VAST_LEASES_PREFIX;

  try {
    const { stdout } = await runner("consul", ["kv", "get", "-keys", prefix]);
    const rawLines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (rawLines.length === 0) return [];

    const leases: Array<Lease | LeaseIntent> = [];
    for (const line of rawLines) {
      const lease = await getLease(line, options);
      if (lease) {
        leases.push(lease);
      }
    }
    return leases;
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.includes("No key exists") || (err as { code?: number }).code === 1) {
      return [];
    }
    throw err;
  }
}

/**
 * Delete a lease matching a specific instance ID.
 */
export async function deleteLeaseByInstanceId(
  instanceId: number,
  options?: KvOptions,
): Promise<boolean> {
  const leases = await listLeases(options);
  const found = leases.find((l) => (l as Lease).instanceId === instanceId);
  if (!found) return false;
  await deleteLease(found.label, options);
  return true;
}
