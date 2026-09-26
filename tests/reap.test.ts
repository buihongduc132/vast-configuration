import { describe, it, expect, vi } from "vitest";
import { reapOrphans, type AuditLogger } from "../src/instances/reap.js";
import { VastClient } from "../src/api/client.js";
import { type Lease, LEASE_LABEL_PREFIX } from "../src/instances/lease.js";

describe("reapOrphans (src/instances/reap.ts)", () => {
  const ourPrefix = LEASE_LABEL_PREFIX; // "nocomesh-offload"

  it("NEVER destroys an instance whose label lacks our prefix (human's box)", async () => {
    const live = [
      { id: 100, label: "my-personal-3090-box", actual_status: "running" },
      { id: 200, label: null, actual_status: "running" },
      { id: 300, label: "someone-elses-workload", actual_status: "running" },
    ];

    const mockClient = {
      get: vi.fn().mockResolvedValue({ instances: live }),
    } as unknown as VastClient;

    const destroySpy = vi.fn();
    const auditSpy = vi.fn();

    const result = await reapOrphans({
      client: mockClient,
      listLeasesFn: async () => [],
      destroyFn: destroySpy,
      auditLogger: auditSpy,
    });

    expect(result.decisions).toHaveLength(0);
    expect(result.reaped).toHaveLength(0);
    expect(destroySpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("destroys undeclared and expired instances belonging to us and audit-logs them", async () => {
    const nowMs = 1700000000000;

    const declaredLease: Lease = {
      label: `${ourPrefix}--embedding--test--${nowMs - 3600_000}`,
      workload: "embedding",
      offerId: 10,
      dphTotal: 0.20,
      createdAtMs: nowMs - 3600_000,
      expiresAtMs: nowMs - 60_000, // expired 1 min ago
      owner: "test",
      instanceId: 501,
    };

    const live = [
      // Human box: should be untouched
      { id: 400, label: "human-dev-box", actual_status: "running" },
      // Ours, declared, expired: should be reaped
      { id: 501, label: declaredLease.label, actual_status: "running" },
      // Ours, undeclared (orphan crash window): should be reaped
      {
        id: 502,
        label: `${ourPrefix}--qwen--crashed--${nowMs - 1800_000}`,
        actual_status: "running",
        start_date: (nowMs - 1800_000) / 1000,
        dph_total: 0.30,
      },
    ];

    const mockClient = {
      get: vi.fn().mockResolvedValue({ instances: live }),
    } as unknown as VastClient;

    const destroySpy = vi.fn().mockResolvedValue({
      instanceId: 0,
      destroyed: true,
      polls: 2,
      durationMs: 100,
    });

    const auditEntries: Array<{ instanceId: number; reason: string; costUsd: number }> = [];
    const auditLogger: AuditLogger = (entry) => {
      auditEntries.push(entry);
    };

    const result = await reapOrphans({
      client: mockClient,
      listLeasesFn: async () => [declaredLease],
      destroyFn: destroySpy,
      auditLogger,
      nowMs,
    });

    expect(result.decisions).toHaveLength(2);
    expect(result.reaped).toHaveLength(2);
    expect(destroySpy).toHaveBeenCalledTimes(2);
    expect(destroySpy).toHaveBeenCalledWith(501);
    expect(destroySpy).toHaveBeenCalledWith(502);

    expect(auditEntries).toHaveLength(2);
    // Instance 501 was expired (1 hour @ $0.20/hr = $0.20)
    const audit501 = auditEntries.find((a) => a.instanceId === 501);
    expect(audit501?.reason).toBe("expired");
    expect(audit501?.costUsd).toBeCloseTo(0.20, 2);

    // Instance 502 was undeclared (0.5 hour @ $0.30/hr = $0.15)
    const audit502 = auditEntries.find((a) => a.instanceId === 502);
    expect(audit502?.reason).toBe("undeclared");
    expect(audit502?.costUsd).toBeCloseTo(0.15, 2);
  });

  it("is bounded: destroys at most 3 instances per run", async () => {
    const nowMs = 1700000000000;
    // 5 orphaned instances
    const live = [1, 2, 3, 4, 5].map((i) => ({
      id: 600 + i,
      label: `${ourPrefix}--embedding--orphan-${i}--${nowMs}`,
      actual_status: "running",
    }));

    const mockClient = {
      get: vi.fn().mockResolvedValue({ instances: live }),
    } as unknown as VastClient;

    const destroySpy = vi.fn().mockResolvedValue({
      instanceId: 0,
      destroyed: true,
      polls: 2,
      durationMs: 100,
    });

    const result = await reapOrphans({
      client: mockClient,
      listLeasesFn: async () => [],
      destroyFn: destroySpy,
      auditLogger: () => {},
      nowMs,
    });

    // 5 decisions made, but only bounded max 3 destroyed!
    expect(result.decisions).toHaveLength(5);
    expect(result.reaped).toHaveLength(3);
    expect(destroySpy).toHaveBeenCalledTimes(3);
  });

  it("never treats a non-array response from GET /instances/ as clean", async () => {
    const mockClient = {
      get: vi.fn().mockResolvedValue({ instances: "not-an-array" }),
    } as unknown as VastClient;

    await expect(
      reapOrphans({
        client: mockClient,
        listLeasesFn: async () => [],
      }),
    ).rejects.toThrow(/array/i);
  });
});
