import { describe, it, expect, vi } from "vitest";
import {
  rentInstance,
  VastRentRefusalError,
  RENT_CONFIRM_TOKEN,
} from "../src/instances/rent.js";
import { EMBEDDING_WORKLOAD } from "../src/workloads.js";
import { type VastOffer } from "../src/offers/select.js";
import { VastClient } from "../src/api/client.js";
import { type Lease, type LeaseIntent } from "../src/instances/lease.js";

describe("rentInstance (src/instances/rent.ts)", () => {
  const validOffer: VastOffer = {
    id: 987,
    gpu_name: "RTX 3090",
    gpu_ram: 24576,
    disk_space: 50,
    dph_total: 0.15,
    rentable: true,
    reliability2: 0.98,
    inet_down: 500,
  };

  it("RENT_CONFIRM_TOKEN matches expected confirmation string", () => {
    expect(RENT_CONFIRM_TOKEN).toBe("i-accept-gpu-rental-charges");
  });

  it("calls canRent() and refuses BEFORE any API call if spend ceiling fails", async () => {
    const putSpy = vi.fn();
    const mockClient = {
      get: vi.fn(),
      put: vi.fn(),
    } as unknown as VastClient;

    // Credit $2.00 is below $5.00 floor
    await expect(
      rentInstance({
        workload: EMBEDDING_WORKLOAD,
        offer: validOffer,
        creditUsd: 2.0,
        currentInstanceCount: 0,
        client: mockClient,
        putLeaseFn: putSpy,
      }),
    ).rejects.toThrow(VastRentRefusalError);

    // ZERO API calls and ZERO KV writes
    expect(mockClient.put).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("writes lease intent to Consul KV BEFORE the rent call, then records instanceId on success", async () => {
    const kvWrites: Array<Lease | LeaseIntent> = [];
    const putLeaseSpy = vi.fn().mockImplementation(async (lease: Lease | LeaseIntent) => {
      kvWrites.push(lease);
    });

    const putApiSpy = vi.fn().mockResolvedValue({
      success: true,
      new_contract: 12345,
    });

    const mockClient = {
      get: vi.fn(),
      put: putApiSpy,
    } as unknown as VastClient;

    const result = await rentInstance({
      workload: EMBEDDING_WORKLOAD,
      offer: validOffer,
      owner: "test-runner",
      creditUsd: 50.0,
      currentInstanceCount: 0,
      client: mockClient,
      putLeaseFn: putLeaseSpy,
      provisionConfig: {
        image: "ghcr.io/huggingface/text-embeddings-inference:1.9.3",
        args: ["--model-id", "Qwen/Qwen3-Embedding-0.6B", "--port", "8003"],
        port: 8003,
        env: { HUGGING_FACE_HUB_TOKEN: "dummy" },
        onstart: "test onstart",
      },
    });

    expect(result).toEqual({
      instanceId: 12345,
      label: expect.stringContaining("nocomesh-offload--embedding--test-runner--"),
      dphTotal: 0.15,
    });

    // 1st KV write was LeaseIntent (NO instanceId)
    expect(kvWrites).toHaveLength(2);
    expect(kvWrites[0]).not.toHaveProperty("instanceId");
    expect(kvWrites[0]?.offerId).toBe(987);

    // API call was made with expected body
    expect(putApiSpy).toHaveBeenCalledTimes(1);
    const [path, body] = putApiSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/asks/987");
    expect(body.client_id).toBe("me");
    expect(body.image).toBe("ghcr.io/huggingface/text-embeddings-inference:1.9.3");
    expect(body.disk).toBe(50);
    expect(body.label).toBe(kvWrites[0]?.label);
    expect(body.onstart).toBe("test onstart");
    expect(body.env).toEqual({ HUGGING_FACE_HUB_TOKEN: "dummy" });
    expect(body.runtype).toBe("ssh");

    // 2nd KV write was confirmed Lease (WITH instanceId)
    expect(kvWrites[1]).toHaveProperty("instanceId", 12345);
    expect(kvWrites[1]?.label).toBe(kvWrites[0]?.label);
  });

  it("cleans up intent from KV if rent API call fails", async () => {
    const putLeaseSpy = vi.fn().mockResolvedValue(undefined);
    const deleteLeaseSpy = vi.fn().mockResolvedValue(undefined);

    const putApiSpy = vi.fn().mockRejectedValue(new Error("API 500 error"));

    const mockClient = {
      get: vi.fn(),
      put: putApiSpy,
    } as unknown as VastClient;

    await expect(
      rentInstance({
        workload: EMBEDDING_WORKLOAD,
        offer: validOffer,
        owner: "test-runner",
        creditUsd: 50.0,
        currentInstanceCount: 0,
        client: mockClient,
        putLeaseFn: putLeaseSpy,
        deleteLeaseFn: deleteLeaseSpy,
      }),
    ).rejects.toThrow("API 500 error");

    // Intent was written
    expect(putLeaseSpy).toHaveBeenCalledTimes(1);
    // And on failure, intent was deleted
    expect(deleteLeaseSpy).toHaveBeenCalledTimes(1);
  });
});
