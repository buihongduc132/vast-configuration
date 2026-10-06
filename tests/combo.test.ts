import { describe, it, expect, vi } from "vitest";
import {
  COMBO_WORKLOAD,
  COMBO_PORTS,
  COMBO_IMAGE,
  getWorkload,
} from "../src/workloads.js";
import {
  buildComboOnstartScript,
  buildComboProvisionConfig,
} from "../src/provision/combo.js";
import {
  selectCandidateOffers,
  NoEligibleOffersError,
  type VastOffer,
} from "../src/offers/select.js";
import {
  classifyBackendDevice,
  getHostPort,
  getHostPorts,
  type InstanceStateInput,
} from "../src/instances/status.js";
import {
  probeLlm,
  verifyComboProvisioning,
  LlmGenerationError,
} from "../src/provision/verify.js";
import { rentInstance } from "../src/instances/rent.js";
import { type VastClient } from "../src/api/client.js";

describe("Combo Workload (src/workloads.ts)", () => {
  it("defines combo workload matching live 24GB RTX 3090 requirements", () => {
    expect(COMBO_WORKLOAD.id).toBe("combo");
    expect(COMBO_WORKLOAD.minGpuRamMb).toBe(24576); // 24 GB card floor
    expect(COMBO_WORKLOAD.minDiskGb).toBe(50);
    expect(COMBO_WORKLOAD.port).toBe(8003);
    expect(COMBO_PORTS).toEqual([8003, 8032]);
    expect(getWorkload("combo")).toBe(COMBO_WORKLOAD);
  });

  it("selectCandidateOffers accepts 24GB offers and rejects 16GB offers for combo", () => {
    const offer24Gb: VastOffer = {
      id: 101,
      gpu_name: "RTX 3090",
      gpu_ram: 24576,
      disk_space: 60,
      dph_total: 0.15,
      rentable: true,
      reliability2: 0.99,
      inet_down: 500,
      cuda_max_good: 13.0,
      geolocation: "US",
    };

    const offer16Gb: VastOffer = {
      id: 102,
      gpu_name: "RTX 4080",
      gpu_ram: 16384,
      disk_space: 60,
      dph_total: 0.12,
      rentable: true,
      reliability2: 0.99,
      inet_down: 500,
      cuda_max_good: 13.0,
      geolocation: "US",
    };

    // 24 GB passes
    const selected = selectCandidateOffers(COMBO_WORKLOAD, [offer24Gb, offer16Gb]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe(101);

    // 16 GB alone throws NoEligibleOffersError
    expect(() => selectCandidateOffers(COMBO_WORKLOAD, [offer16Gb])).toThrow(
      NoEligibleOffersError,
    );
  });
});

describe("Combo Provisioning (src/provision/combo.ts)", () => {
  it("buildComboOnstartScript produces supervised multi-process script without bare exec", () => {
    const script = buildComboOnstartScript({
      embeddingPort: 8003,
      llmPort: 8032,
    });

    expect(script).toContain("text-embeddings-router");
    expect(script).toContain("--port 8003");
    expect(script).toContain("python3 -m vllm.entrypoints.openai.api_server");
    expect(script).toContain("--port 8032");
    expect(script).toContain("--gpu-memory-utilization 0.62");
    expect(script).toContain("--max-model-len 262144");
    expect(script).toContain("trap cleanup SIGTERM SIGINT");
    // Supervisor loop checks both PIDs
    expect(script).toContain("TEI_PID");
    expect(script).toContain("VLLM_PID");
    expect(script).not.toMatch(/^\s*exec\s+text-embeddings-router/m);
  });

  it("buildComboProvisionConfig propagates HF token for both services and binds dual ports", async () => {
    const config = await buildComboProvisionConfig({
      hfToken: "hf_test_token_combo",
    });

    expect(config.image).toBe(COMBO_IMAGE);
    expect(config.ports).toEqual([8003, 8032]);
    expect(config.env.HUGGING_FACE_HUB_TOKEN).toBe("hf_test_token_combo");
    expect(config.env.HF_TOKEN).toBe("hf_test_token_combo");
    expect(config.onstart).toContain("HUGGING_FACE_HUB_TOKEN");
  });
});

describe("rentInstance with combo workload (src/instances/rent.ts)", () => {
  it("rents combo instance with dual ports and correct label prefix", async () => {
    const putSpy = vi.fn().mockResolvedValue({
      success: true,
      new_contract: 55555,
    });
    const putLeaseSpy = vi.fn().mockResolvedValue(undefined);

    const mockClient = {
      get: vi.fn().mockResolvedValue({ credit: 50.0 }),
      put: putSpy,
    } as unknown as VastClient;

    const offer: VastOffer = {
      id: 301,
      gpu_name: "RTX 3090",
      gpu_ram: 24576,
      disk_space: 100,
      dph_total: 0.14,
      rentable: true,
    };

    const res = await rentInstance({
      workload: "combo",
      offer,
      owner: "lane-combo",
      client: mockClient,
      putLeaseFn: putLeaseSpy,
      assertGateFn: vi.fn().mockResolvedValue({ allowed: true, verdict: "ALLOW", limits_seen: { max_instances: 2, max_dph_per_instance: 0.20 } }),
    });

    expect(res.instanceId).toBe(55555);
    expect(res.label).toContain("nocomesh-offload--combo--lane-combo--");

    // Check rent body passed to Vast API
    expect(putSpy).toHaveBeenCalledTimes(1);
    const [path, body] = putSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/asks/301");
    // Vast API honors port mapping via `-p` flags in `env` string
    expect(body.env).toContain("-p 8003:8003 -p 8032:8032");
    expect(body.runtype).toBe("args");
    expect(body.label).toContain("nocomesh-offload--combo--");

    // Check dual-service mesh registration in Consul KV lease
    expect(putLeaseSpy).toHaveBeenCalled();
    const recordedLease = putLeaseSpy.mock.calls[putLeaseSpy.mock.calls.length - 1]?.[0];
    expect(recordedLease.ports).toEqual([8003, 8032]);
    expect(recordedLease.services).toEqual([
      { name: "embedding", containerPort: 8003 },
      { name: "qwen", containerPort: 8032 },
    ]);
  });
});

describe("vLLM CUDA Backend Classification & Ports (src/instances/status.ts)", () => {
  it("detects vLLM CUDA graph and GPU blocks markers", () => {
    const vllmLogs = `
INFO 10-06 20:00:00 [engine.py:340] # GPU blocks: 4120, # CPU blocks: 0
INFO 10-06 20:00:05 [worker.py:120] Capturing the model for CUDA graphs...
INFO 10-06 20:00:15 [worker.py:150] Graph capturing finished in 10 secs.
`;
    expect(classifyBackendDevice(vllmLogs)).toBe("cuda");
  });

  it("detects vLLM MarlinLinearKernel and device='cuda' markers", () => {
    const marlinLogs = `
INFO: Using MarlinLinearKernel for CompressedTensorsWNA16 on device='cuda:0'
`;
    expect(classifyBackendDevice(marlinLogs)).toBe("cuda");
  });

  it("extracts mapped HostPort for both 8003 and 8032", () => {
    const inst: InstanceStateInput = {
      id: 999,
      ports: {
        "8003/tcp": [{ HostIp: "0.0.0.0", HostPort: "18003" }],
        "8032/tcp": [{ HostIp: "0.0.0.0", HostPort: "18032" }],
      },
    };

    expect(getHostPort(inst, 8003)).toBe(18003);
    expect(getHostPort(inst, 8032)).toBe(18032);
    expect(getHostPorts(inst, [8003, 8032])).toEqual({
      8003: 18003,
      8032: 18032,
    });
  });
});

describe("Dual-verify LLM probe and combo verification (src/provision/verify.ts)", () => {
  it("probeLlm parses valid OpenAI chat completion response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: { role: "assistant", content: "OK generated text" },
          },
        ],
      }),
    } as unknown as Response);

    const text = await probeLlm("http://localhost:8032", {
      fetch: mockFetch,
    });

    expect(text).toBe("OK generated text");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("probeLlm throws LlmGenerationError on empty choices", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
    } as unknown as Response);

    await expect(
      probeLlm("http://localhost:8032", { fetch: mockFetch }),
    ).rejects.toThrow(LlmGenerationError);
  });

  it("verifyComboProvisioning verifies CUDA backend, 1024-dim embedding, and LLM text", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/embed")) {
        return {
          ok: true,
          status: 200,
          json: async () => [Array(1024).fill(0.01)],
        } as unknown as Response;
      }
      if (url.includes("/chat/completions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "model inference active" } }],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const result = await verifyComboProvisioning(123, {
      logText: "Capturing the model for CUDA graphs... Starting Qwen3 model on CUDA",
      embedBaseUrl: "http://remote:18003",
      llmBaseUrl: "http://remote:18032",
      fetch: mockFetch,
    });

    expect(result.backend).toBe("cuda");
    expect(result.embeddingDimension).toBe(1024);
    expect(result.llmOutput).toBe("model inference active");
  });
});
