import { describe, it, expect, vi } from "vitest";
import {
  destroyInstance,
  VastTeardownError,
  VastTeardownTimeoutError,
} from "../src/instances/destroy.js";
import { VastClient } from "../src/api/client.js";

describe("destroyInstance (src/instances/destroy.ts)", () => {
  it("calls DELETE /instances/<id>/ and verifies positive teardown with 2 consecutive clean polls", async () => {
    const deleteSpy = vi.fn().mockResolvedValue({ success: true });
    let getCount = 0;
    const getSpy = vi.fn().mockImplementation(async () => {
      getCount++;
      if (getCount === 1) {
        // First poll: still visible in list
        return { instances: [{ id: 42, actual_status: "running" }] };
      }
      // Poll 2 and 3: absent from list
      return { instances: [{ id: 99, actual_status: "running" }] };
    });

    const mockClient = {
      delete: deleteSpy,
      get: getSpy,
    } as unknown as VastClient;

    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const deleteLeaseFn = vi.fn().mockResolvedValue(true);

    const result = await destroyInstance(42, {
      client: mockClient,
      pollIntervalMs: 15_000,
      minConsecutiveCleanPolls: 2,
      timeoutMs: 60_000,
      sleep: sleepSpy,
      deleteLeaseFn,
    });

    expect(result.destroyed).toBe(true);
    expect(result.instanceId).toBe(42);
    expect(deleteSpy).toHaveBeenCalledWith("/instances/42");
    // 1st poll (present), 2nd poll (absent -> 1), 3rd poll (absent -> 2)
    expect(getSpy).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledWith(15_000);
    expect(deleteLeaseFn).toHaveBeenCalledWith(42);
  });

  it("distinguishes 'stopped' from 'destroyed' — stopped instance resets clean poll count", async () => {
    let getCount = 0;
    const getSpy = vi.fn().mockImplementation(async () => {
      getCount++;
      if (getCount === 1) {
        // Poll 1: absent
        return { instances: [] };
      }
      if (getCount === 2) {
        // Poll 2: appears as 'stopped' (still billed for storage!)
        return { instances: [{ id: 42, actual_status: "stopped" }] };
      }
      // Poll 3 and 4: completely absent
      return { instances: [] };
    });

    const mockClient = {
      delete: vi.fn().mockResolvedValue({ success: true }),
      get: getSpy,
    } as unknown as VastClient;

    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const deleteLeaseFn = vi.fn().mockResolvedValue(true);

    const result = await destroyInstance(42, {
      client: mockClient,
      pollIntervalMs: 100,
      minConsecutiveCleanPolls: 2,
      timeoutMs: 5000,
      sleep: sleepSpy,
      deleteLeaseFn,
    });

    expect(result.destroyed).toBe(true);
    // Needs 4 polls because poll 2 reset the consecutive clean count
    expect(getSpy).toHaveBeenCalledTimes(4);
  });

  it("never treats a non-list / unparseable response as clean — asserts Array.isArray", async () => {
    const mockClient = {
      delete: vi.fn().mockResolvedValue({ success: true }),
      get: vi.fn().mockResolvedValue({ instances: null }), // invalid shape
    } as unknown as VastClient;

    await expect(
      destroyInstance(42, {
        client: mockClient,
        pollIntervalMs: 100,
        timeoutMs: 5000,
        sleep: vi.fn(),
      }),
    ).rejects.toThrow(VastTeardownError);
  });

  it("throws VastTeardownTimeoutError if instance remains after timeout", async () => {
    const mockClient = {
      delete: vi.fn().mockResolvedValue({ success: true }),
      get: vi.fn().mockResolvedValue({
        instances: [{ id: 42, actual_status: "running" }],
      }),
    } as unknown as VastClient;

    let currentTime = 1000;
    const sleepSpy = vi.fn().mockImplementation(async (ms: number) => {
      currentTime += ms;
    });

    await expect(
      destroyInstance(42, {
        client: mockClient,
        pollIntervalMs: 1000,
        timeoutMs: 3000,
        now: () => currentTime,
        sleep: sleepSpy,
      }),
    ).rejects.toThrow(VastTeardownTimeoutError);
  });
});
