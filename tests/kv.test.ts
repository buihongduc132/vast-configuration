import { describe, it, expect } from "vitest";
import {
  putLease,
  getLease,
  deleteLease,
  listLeases,
  deleteLeaseByInstanceId,
  type ExecFileRunner,
} from "../src/state/kv.js";
import { makeLeaseIntent, type Lease } from "../src/instances/lease.js";

describe("Consul KV lease persistence (src/state/kv.ts)", () => {
  const sampleIntent = makeLeaseIntent({
    workload: "embedding",
    offerId: 1234,
    dphTotal: 0.15,
    owner: "test-run",
    maxLifetimeMinutes: 30,
    nowMs: 1700000000000,
  });

  const sampleLease: Lease = {
    ...sampleIntent,
    label: sampleIntent.label + "-confirmed",
    instanceId: 5678,
  };

  it("writes a lease intent via consul kv put using execFile arguments (no shell interpolation)", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const mockRunner: ExecFileRunner = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "Success! Data written to: vast/leases/" + sampleIntent.label, stderr: "" };
    };

    await putLease(sampleIntent, { execRunner: mockRunner });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("consul");
    expect(calls[0]?.args[0]).toBe("kv");
    expect(calls[0]?.args[1]).toBe("put");
    expect(calls[0]?.args[2]).toBe(`vast/leases/${sampleIntent.label}`);
    expect(JSON.parse(calls[0]?.args[3] as string)).toEqual(sampleIntent);
  });

  it("reads and parses a lease from consul kv get", async () => {
    const mockRunner: ExecFileRunner = async (file, args) => {
      return { stdout: JSON.stringify(sampleLease) + "\n", stderr: "" };
    };

    const lease = await getLease(sampleLease.label, { execRunner: mockRunner });
    expect(lease).toEqual(sampleLease);
  });

  it("returns null when key does not exist in Consul KV (exit code 1)", async () => {
    const mockRunner: ExecFileRunner = async () => {
      const err = new Error("Error! No key exists at: vast/leases/missing");
      (err as { code?: number }).code = 1;
      throw err;
    };

    const lease = await getLease("missing", { execRunner: mockRunner });
    expect(lease).toBeNull();
  });

  it("deletes a lease via consul kv delete", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const mockRunner: ExecFileRunner = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "Success! Deleted key: vast/leases/some-label", stderr: "" };
    };

    await deleteLease("some-label", { execRunner: mockRunner });
    expect(calls).toEqual([
      { file: "consul", args: ["kv", "delete", "vast/leases/some-label"] },
    ]);
  });

  it("lists all leases under vast/leases/ prefix", async () => {
    const store = new Map<string, string>([
      [`vast/leases/${sampleIntent.label}`, JSON.stringify(sampleIntent)],
      [`vast/leases/${sampleLease.label}`, JSON.stringify(sampleLease)],
    ]);

    const mockRunner: ExecFileRunner = async (file, args) => {
      if (args[1] === "get" && args[2] === "-keys") {
        return {
          stdout: `${sampleIntent.label}\n${sampleLease.label}\n`,
          stderr: "",
        };
      }
      if (args[1] === "get") {
        const key = args[2] as string;
        const val = store.get(key);
        if (val) return { stdout: val, stderr: "" };
        throw new Error("No key exists");
      }
      return { stdout: "", stderr: "" };
    };

    const leases = await listLeases({ execRunner: mockRunner });
    expect(leases).toHaveLength(2);
    expect(leases).toContainEqual(sampleIntent);
    expect(leases).toContainEqual(sampleLease);
  });

  it("handles empty lease list gracefully", async () => {
    const mockRunner: ExecFileRunner = async (file, args) => {
      if (args[1] === "get" && args[2] === "-keys") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const leases = await listLeases({ execRunner: mockRunner });
    expect(leases).toEqual([]);
  });

  it("deletes lease by instance ID", async () => {
    const deletedKeys: string[] = [];
    const mockRunner: ExecFileRunner = async (file, args) => {
      if (args[1] === "get" && args[2] === "-keys") {
        return { stdout: `vast/leases/${sampleLease.label}\n`, stderr: "" };
      }
      if (args[1] === "get") {
        return { stdout: JSON.stringify(sampleLease), stderr: "" };
      }
      if (args[1] === "delete") {
        deletedKeys.push(args[2] as string);
        return { stdout: "Success", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const deleted = await deleteLeaseByInstanceId(5678, { execRunner: mockRunner });
    expect(deleted).toBe(true);
    expect(deletedKeys).toEqual([`vast/leases/${sampleLease.label}`]);
  });
});
