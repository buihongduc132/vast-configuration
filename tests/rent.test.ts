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

  it("throws typed VastNoSuchAskError when rent call returns no_such_ask / invalid_args", async () => {
    const putLeaseSpy = vi.fn().mockResolvedValue(undefined);
    const deleteLeaseSpy = vi.fn().mockResolvedValue(undefined);

    // Live verbatim error response from Vast.ai:
    const putApiSpy = vi.fn().mockResolvedValue({
      success: false,
      error: "invalid_args",
      msg: "error 404/3603: no_such_ask  Instance type by id 18209627 is not available.",
      ask_id: 18209627,
    });

    const mockClient = {
      get: vi.fn(),
      put: putApiSpy,
    } as unknown as VastClient;

    await expect(
      rentInstance({
        workload: EMBEDDING_WORKLOAD,
        offer: { ...validOffer, id: 18209627 },
        creditUsd: 50.0,
        currentInstanceCount: 0,
        client: mockClient,
        putLeaseFn: putLeaseSpy,
        deleteLeaseFn: deleteLeaseSpy,
      }),
    ).rejects.toThrow(/unavailable|no_such_ask/i);

    // Pre-rent intent was written then cleaned up
    expect(putLeaseSpy).toHaveBeenCalledTimes(1);
    expect(deleteLeaseSpy).toHaveBeenCalledTimes(1);
  });
});

describe("rentFirstAvailable candidate rotation (src/instances/rent.ts)", () => {
  const candidate1: VastOffer = {
    id: 18209627,
    gpu_name: "RTX 3090",
    gpu_ram: 24576,
    disk_space: 50,
    dph_total: 0.15,
    rentable: true,
    reliability2: 0.98,
    inet_down: 500,
  };

  const candidate2: VastOffer = {
    id: 18209628,
    gpu_name: "RTX 3090",
    gpu_ram: 24576,
    disk_space: 50,
    dph_total: 0.18,
    rentable: true,
    reliability2: 0.97,
    inet_down: 400,
  };

  const candidate3: VastOffer = {
    id: 18209629,
    gpu_name: "RTX 3090",
    gpu_ram: 24576,
    disk_space: 50,
    dph_total: 0.20,
    rentable: true,
    reliability2: 0.96,
    inet_down: 300,
  };

  it("throws NoEligibleOffersError when given zero candidates", async () => {
    const { rentFirstAvailable } = await import("../src/instances/rent.js");
    const { NoEligibleOffersError } = await import("../src/offers/select.js");

    await expect(
      rentFirstAvailable({
        workload: EMBEDDING_WORKLOAD,
        candidates: [],
        creditUsd: 50.0,
        currentInstanceCount: 0,
      }),
    ).rejects.toThrow(NoEligibleOffersError);
  });

  it("advances to next candidate when first candidate returns no_such_ask", async () => {
    const { rentFirstAvailable } = await import("../src/instances/rent.js");

    const putLeaseSpy = vi.fn().mockResolvedValue(undefined);
    const deleteLeaseSpy = vi.fn().mockResolvedValue(undefined);

    const putApiSpy = vi
      .fn()
      // Candidate 1 fails with verbatim live no_such_ask
      .mockResolvedValueOnce({
        success: false,
        error: "invalid_args",
        msg: "error 404/3603: no_such_ask  Instance type by id 18209627 is not available.",
        ask_id: 18209627,
      })
      // Candidate 2 succeeds
      .mockResolvedValueOnce({
        success: true,
        new_contract: 99001,
      });

    const mockClient = {
      get: vi.fn(),
      put: putApiSpy,
    } as unknown as VastClient;

    const result = await rentFirstAvailable({
      workload: EMBEDDING_WORKLOAD,
      candidates: [candidate1, candidate2],
      creditUsd: 50.0,
      currentInstanceCount: 0,
      client: mockClient,
      putLeaseFn: putLeaseSpy,
      deleteLeaseFn: deleteLeaseSpy,
    });

    expect(result.instanceId).toBe(99001);
    expect(putApiSpy).toHaveBeenCalledTimes(2);
    expect(putApiSpy).toHaveBeenNthCalledWith(1, "/asks/18209627", expect.anything());
    expect(putApiSpy).toHaveBeenNthCalledWith(2, "/asks/18209628", expect.anything());
  });

  it("re-asserts price ceiling per candidate and refuses to rent above cap on retry", async () => {
    const { rentFirstAvailable } = await import("../src/instances/rent.js");

    const expensiveCandidate: VastOffer = {
      ...candidate2,
      id: 999999,
      dph_total: 0.50, // exceeds $0.45/hr cap
    };

    const putApiSpy = vi
      .fn()
      // Candidate 1 fails with no_such_ask
      .mockResolvedValueOnce({
        success: false,
        error: "invalid_args",
        msg: "error 404/3603: no_such_ask  Instance type by id 18209627 is not available.",
      });

    const mockClient = {
      get: vi.fn(),
      put: putApiSpy,
    } as unknown as VastClient;

    await expect(
      rentFirstAvailable({
        workload: EMBEDDING_WORKLOAD,
        candidates: [candidate1, expensiveCandidate],
        creditUsd: 50.0,
        currentInstanceCount: 0,
        client: mockClient,
        putLeaseFn: vi.fn(),
        deleteLeaseFn: vi.fn(),
      }),
    ).rejects.toThrow(VastRentRefusalError);

    // Only candidate 1 was tried via API; candidate 2 was blocked BEFORE any API call
    expect(putApiSpy).toHaveBeenCalledTimes(1);
  });

  it("bounds attempts by maxAttempts count", async () => {
    const { rentFirstAvailable } = await import("../src/instances/rent.js");

    const putApiSpy = vi.fn().mockResolvedValue({
      success: false,
      error: "invalid_args",
      msg: "no_such_ask",
    });

    const mockClient = {
      get: vi.fn(),
      put: putApiSpy,
    } as unknown as VastClient;

    await expect(
      rentFirstAvailable({
        workload: EMBEDDING_WORKLOAD,
        candidates: [candidate1, candidate2, candidate3],
        maxAttempts: 2, // stop after 2 attempts even though 3 candidates exist
        creditUsd: 50.0,
        currentInstanceCount: 0,
        client: mockClient,
        putLeaseFn: vi.fn(),
        deleteLeaseFn: vi.fn(),
      }),
    ).rejects.toThrow();

    expect(putApiSpy).toHaveBeenCalledTimes(2);
  });

  it("destroys instance and advances to next candidate on fatal-host status_msg", async () => {
    const { rentFirstAvailable } = await import("../src/instances/rent.js");

    // Candidate 1 rents successfully (id: 1111) but reports Fujian CN error
    // Candidate 2 rents successfully (id: 2222) and becomes running
    const putApiSpy = vi
      .fn()
      .mockResolvedValueOnce({ success: true, new_contract: 1111 })
      .mockResolvedValueOnce({ success: true, new_contract: 2222 });

    const fujianMsg =
      'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host';

    const getApiSpy = vi
      .fn()
      // Poll 1 for instance 1111: loading with Fujian error -> fatal-host
      .mockResolvedValueOnce({
        instances: [{ id: 1111, actual_status: "loading", status_msg: fujianMsg }],
      })
      // Poll 2 for instance 2222: running with live dph_total 0.18
      .mockResolvedValueOnce({
        instances: [
          {
            id: 2222,
            actual_status: "running",
            cur_state: "running",
            dph_total: 0.18,
          },
        ],
      });

    const destroySpy = vi.fn().mockResolvedValue(undefined);

    const mockClient = {
      get: getApiSpy,
      put: putApiSpy,
    } as unknown as VastClient;

    const result = await rentFirstAvailable({
      workload: EMBEDDING_WORKLOAD,
      candidates: [candidate1, candidate2],
      creditUsd: 50.0,
      currentInstanceCount: 0,
      client: mockClient,
      putLeaseFn: vi.fn(),
      deleteLeaseFn: vi.fn(),
      destroyFn: destroySpy,
      waitForReady: true,
      pollIntervalMs: 1,
      candidateDeadlineMs: 10_000,
    });

    expect(result.instanceId).toBe(2222);
    // Destroyed the fatally broken instance 1111!
    expect(destroySpy).toHaveBeenCalledWith(1111);
    expect(putApiSpy).toHaveBeenCalledTimes(2);
  });

  it("destroys instance and advances to next candidate on terminal state (exited)", async () => {
    const { rentFirstAvailable } = await import("../src/instances/rent.js");

    const putApiSpy = vi
      .fn()
      .mockResolvedValueOnce({ success: true, new_contract: 3333 })
      .mockResolvedValueOnce({ success: true, new_contract: 4444 });

    const getApiSpy = vi
      .fn()
      // Poll 1 for instance 3333: exited -> terminal
      .mockResolvedValueOnce({
        instances: [{ id: 3333, actual_status: "exited" }],
      })
      // Poll 2 for instance 4444: running
      .mockResolvedValueOnce({
        instances: [
          {
            id: 4444,
            actual_status: "running",
            dph_total: 0.18,
          },
        ],
      });

    const destroySpy = vi.fn().mockResolvedValue(undefined);

    const mockClient = {
      get: getApiSpy,
      put: putApiSpy,
    } as unknown as VastClient;

    const result = await rentFirstAvailable({
      workload: EMBEDDING_WORKLOAD,
      candidates: [candidate1, candidate2],
      creditUsd: 50.0,
      currentInstanceCount: 0,
      client: mockClient,
      putLeaseFn: vi.fn(),
      deleteLeaseFn: vi.fn(),
      destroyFn: destroySpy,
      waitForReady: true,
      pollIntervalMs: 1,
      candidateDeadlineMs: 10_000,
    });

    expect(result.instanceId).toBe(4444);
    expect(destroySpy).toHaveBeenCalledWith(3333);
  });

  it("destroys instance and advances to next candidate on terminal state (offline)", async () => {
    const { rentFirstAvailable } = await import("../src/instances/rent.js");

    const putApiSpy = vi
      .fn()
      .mockResolvedValueOnce({ success: true, new_contract: 5555 })
      .mockResolvedValueOnce({ success: true, new_contract: 6666 });

    const getApiSpy = vi
      .fn()
      // Poll 1 for instance 5555: offline -> terminal
      .mockResolvedValueOnce({
        instances: [{ id: 5555, actual_status: "offline" }],
      })
      // Poll 2 for instance 6666: running
      .mockResolvedValueOnce({
        instances: [
          {
            id: 6666,
            actual_status: "running",
            dph_total: 0.18,
          },
        ],
      });

    const destroySpy = vi.fn().mockResolvedValue(undefined);

    const mockClient = {
      get: getApiSpy,
      put: putApiSpy,
    } as unknown as VastClient;

    const result = await rentFirstAvailable({
      workload: EMBEDDING_WORKLOAD,
      candidates: [candidate1, candidate2],
      creditUsd: 50.0,
      currentInstanceCount: 0,
      client: mockClient,
      putLeaseFn: vi.fn(),
      deleteLeaseFn: vi.fn(),
      destroyFn: destroySpy,
      waitForReady: true,
      pollIntervalMs: 1,
      candidateDeadlineMs: 10_000,
    });

    expect(result.instanceId).toBe(6666);
    expect(destroySpy).toHaveBeenCalledWith(5555);
  });

  it("destroys instance and advances to next candidate when verifyBackend detects CPU fallback", async () => {
    const { rentFirstAvailable } = await import("../src/instances/rent.js");

    // Candidate 1 rents (id: 7777), enters running state, but logs CPU fallback
    // Candidate 2 rents (id: 8888), enters running state, logs CUDA
    const putApiSpy = vi
      .fn()
      .mockResolvedValueOnce({ success: true, new_contract: 7777 })
      .mockResolvedValueOnce({ success: true, new_contract: 8888 });

    const getApiSpy = vi
      .fn()
      // Poll 1 for instance 7777: running
      .mockResolvedValueOnce({
        instances: [{ id: 7777, actual_status: "running" }],
      })
      // Poll 2 for instance 8888: running
      .mockResolvedValueOnce({
        instances: [
          {
            id: 8888,
            actual_status: "running",
            dph_total: 0.18,
          },
        ],
      });

    const destroySpy = vi.fn().mockResolvedValue(undefined);

    const cpuLog = `
WARN text_embeddings_backend_candle: Could not find a compatible CUDA device on host: CUDA is not available
Caused by:
    DriverError(CUDA_ERROR_COMPAT_NOT_SUPPORTED_ON_DEVICE, "forward compatibility was attempted on non supported HW")
WARN text_embeddings_backend_candle: Using CPU instead
INFO text_embeddings_backend_candle: Starting Qwen3 model on Cpu
`;
    const cudaLog = `
INFO text_embeddings_backend_candle: Starting Qwen3 model on Cuda
`;

    const fetchLogsSpy = vi.fn().mockImplementation(async (id: number) => {
      if (id === 7777) return cpuLog;
      return cudaLog;
    });

    const mockClient = {
      get: getApiSpy,
      put: putApiSpy,
    } as unknown as VastClient;

    const result = await rentFirstAvailable({
      workload: EMBEDDING_WORKLOAD,
      candidates: [candidate1, candidate2],
      creditUsd: 50.0,
      currentInstanceCount: 0,
      client: mockClient,
      putLeaseFn: vi.fn(),
      deleteLeaseFn: vi.fn(),
      destroyFn: destroySpy,
      waitForReady: true,
      verifyBackend: true,
      fetchLogsFn: fetchLogsSpy,
      pollIntervalMs: 1,
      candidateDeadlineMs: 10_000,
    });

    expect(result.instanceId).toBe(8888);
    // Destroyed instance 7777 on CPU fallback host failure
    expect(destroySpy).toHaveBeenCalledWith(7777);
    expect(putApiSpy).toHaveBeenCalledTimes(2);
    expect(fetchLogsSpy).toHaveBeenCalledWith(7777);
    expect(fetchLogsSpy).toHaveBeenCalledWith(8888);
  });
});

