import { describe, it, expect } from "vitest";
import {
  isFatalHostStatusMsg,
  classifyStatusMsg,
  classifyInstanceState,
  classifyBackendDevice,
  stripAnsi,
  fetchInstanceLogs,
  CpuBackendError,
  FatalHostError,
  waitForInstanceReady,
  TerminalInstanceStateError,
} from "../src/instances/status.js";
import { VastClient } from "../src/api/client.js";

describe("status_msg classifier (src/instances/status.ts)", () => {
  const fujianMsg =
    'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host';
  const pennsylvaniaMsg =
    "Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: could not apply required modification to OCI specification";

  it("classifies real live Fujian CN box status_msg as fatal-host", () => {
    expect(isFatalHostStatusMsg(fujianMsg)).toBe(true);
    expect(classifyStatusMsg(fujianMsg)).toBe("fatal-host");
  });

  it("classifies real live Pennsylvania US box status_msg as fatal-host", () => {
    expect(isFatalHostStatusMsg(pennsylvaniaMsg)).toBe(true);
    expect(classifyStatusMsg(pennsylvaniaMsg)).toBe("fatal-host");
  });

  it("classifies all required fatal strings as fatal-host", () => {
    const fatalCases = [
      "no such host",
      "Get https://registry: no such host",
      "manifest unknown",
      "unauthorized",
      "connection refused",
      "oci runtime create failed",
      "failed to create task",
      "Error response from daemon: broken driver",
    ];

    for (const msg of fatalCases) {
      expect(isFatalHostStatusMsg(msg), `expected fatal for: "${msg}"`).toBe(true);
      expect(classifyStatusMsg(msg), `expected fatal-host for: "${msg}"`).toBe("fatal-host");
    }
  });

  it("matches 'error response from daemon' as fatal ONLY when line does not contain 'complete'", () => {
    const withoutComplete = "Error response from daemon: internal system error";
    const withComplete = "Error response from daemon: layer download complete";

    expect(isFatalHostStatusMsg(withoutComplete)).toBe(true);
    expect(isFatalHostStatusMsg(withComplete)).toBe(false);
  });

  it("does NOT classify normal progress as fatal", () => {
    const normalCases = [
      "Pull complete",
      "35805541604a: Pull complete",
      "Extracting",
      "Extracting [===>                                           ]  10MB/100MB",
      "Downloading",
      "Downloading [=======>                                       ]  20MB/100MB",
      "Verifying Checksum",
      "f2389d0e123: Verifying Checksum",
      "Download complete",
      null,
      undefined,
      "",
    ];

    for (const msg of normalCases) {
      expect(isFatalHostStatusMsg(msg), `expected non-fatal for: "${msg}"`).toBe(false);
      expect(classifyStatusMsg(msg)).not.toBe("fatal-host");
    }
  });
});

describe("instance state vocabulary & conflict resolution (src/instances/status.ts)", () => {
  it("trusts actual_status over cur_state when cur_state is running but actual_status is loading", () => {
    const state = classifyInstanceState({
      actual_status: "loading",
      cur_state: "running",
      status_msg: "Downloading 45%",
    });
    expect(state).toBe("pending");
  });

  it("classifies actual_status: null as pending (immediately after rent)", () => {
    const state = classifyInstanceState({
      actual_status: null,
      cur_state: null,
    });
    expect(state).toBe("pending");
  });

  it("classifies actual_status: created as pending", () => {
    const state = classifyInstanceState({
      actual_status: "created",
      cur_state: "created",
    });
    expect(state).toBe("pending");
  });

  it("classifies actual_status: running as running", () => {
    const state = classifyInstanceState({
      actual_status: "running",
      cur_state: "running",
    });
    expect(state).toBe("running");
  });

  it("classifies exited, offline, and unknown as terminal", () => {
    for (const status of ["exited", "offline", "unknown"]) {
      const state = classifyInstanceState({
        actual_status: status,
      });
      expect(state, `expected terminal for status "${status}"`).toBe("terminal");
    }
  });

  it("fatal status_msg overrides pending actual_status and returns fatal-host", () => {
    const state = classifyInstanceState({
      actual_status: "loading",
      cur_state: "running",
      status_msg: 'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host',
    });
    expect(state).toBe("fatal-host");
  });

  it("waitForInstanceReady throws TerminalInstanceStateError when actual_status becomes offline", async () => {
    const mockClient = {
      get: async () => ({
        instances: [{ id: 4567, actual_status: "offline" }],
      }),
    } as unknown as VastClient;

    await expect(
      waitForInstanceReady(4567, {
        client: mockClient,
        pollIntervalMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(TerminalInstanceStateError);
  });
});

describe("backend-device classifier (src/instances/status.ts)", () => {
  const verbatimCpuLog = `
WARN text_embeddings_backend_candle: Could not find a compatible CUDA device on host: CUDA is not available
Caused by:
    DriverError(CUDA_ERROR_COMPAT_NOT_SUPPORTED_ON_DEVICE, "forward compatibility was attempted on non supported HW")
WARN text_embeddings_backend_candle: Using CPU instead
INFO text_embeddings_backend_candle: Starting Qwen3 model on Cpu
INFO text_embeddings_router: Warming up model
`;

  const cudaLog = `
2026-09-27T01:00:00Z INFO text_embeddings_backend_candle: Starting Qwen3 model on Cuda
2026-09-27T01:00:05Z INFO text_embeddings_router: Warming up model
2026-09-27T01:00:10Z INFO text_embeddings_router: Model loaded and ready to serve
`;

  it("classifies VERBATIM live failure log excerpt as cpu", () => {
    expect(classifyBackendDevice(verbatimCpuLog)).toBe("cpu");
  });

  it("classifies all individual cpu fallback patterns as cpu", () => {
    const patterns = [
      "WARN text_embeddings: using cpu instead",
      "INFO: model on cpu",
      "error: cuda is not available on host",
      "DriverError(CUDA_ERROR_COMPAT_NOT_SUPPORTED, ...)",
      "cuda_error_compat_not_supported_on_device",
    ];

    for (const p of patterns) {
      expect(classifyBackendDevice(p), `expected cpu for "${p}"`).toBe("cpu");
    }
  });

  it("classifies cuda variants as cuda", () => {
    expect(classifyBackendDevice(cudaLog)).toBe("cuda");
    expect(classifyBackendDevice("INFO: model on cuda")).toBe("cuda");
    expect(classifyBackendDevice("Starting embedding model on cuda")).toBe("cuda");
    expect(classifyBackendDevice("starting Qwen3 model on Cuda")).toBe("cuda");
  });

  it("classifies unknown/garbage as unknown (must NOT default to cuda)", () => {
    expect(classifyBackendDevice("Container started. Listening on :8003")).toBe("unknown");
    expect(classifyBackendDevice("")).toBe("unknown");
    expect(classifyBackendDevice("   \n  ")).toBe("unknown");
    expect(classifyBackendDevice(null)).toBe("unknown");
    expect(classifyBackendDevice(undefined)).toBe("unknown");
  });

  it("strips ANSI color escapes before classification", () => {
    const colorizedCpu =
      "\x1b[33mWARN\x1b[0m \x1b[1;31musing cpu instead\x1b[0m of gpu";
    expect(classifyBackendDevice(colorizedCpu)).toBe("cpu");

    const colorizedCuda =
      "\x1b[32mINFO\x1b[0m Starting Qwen3 \x1b[1mmodel on cuda\x1b[0m";
    expect(classifyBackendDevice(colorizedCuda)).toBe("cuda");
  });

  it("stripAnsi removes all ANSI escape sequences", () => {
    const raw = "\x1b[31mRed text\x1b[0m and \x1b[1;34mBold Blue\x1b[0m";
    expect(stripAnsi(raw)).toBe("Red text and Bold Blue");
  });

  it("CpuBackendError extends FatalHostError", () => {
    const err = new CpuBackendError(999, "degraded to cpu");
    expect(err).toBeInstanceOf(FatalHostError);
    expect(err.name).toBe("CpuBackendError");
    expect(err.instanceId).toBe(999);
    expect(err.message).toContain("CPU fallback");
  });
});

describe("fetchInstanceLogs (src/instances/status.ts)", () => {
  it("requests logs via PUT /instances/request_logs/<id>/ and fetches from S3", async () => {
    const mockClient = {
      put: async (path: string, body: unknown) => {
        expect(path).toBe("/instances/request_logs/789/");
        expect(body).toEqual({ tail: "60" });
        return {
          success: true,
          result_url: "https://s3.amazonaws.com/public.vast.ai/instance_logs/xyz.log",
        };
      },
    } as unknown as VastClient;

    const mockFetch = async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://s3.amazonaws.com/public.vast.ai/instance_logs/xyz.log");
      return new Response("\x1b[32mINFO\x1b[0m Starting Qwen3 model on Cuda\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    };

    const logs = await fetchInstanceLogs(789, {
      client: mockClient,
      fetch: mockFetch as typeof fetch,
    });

    expect(logs).toBe("INFO Starting Qwen3 model on Cuda\n");
  });

  it("retries when S3 returns 404 initially before log appears", async () => {
    const mockClient = {
      put: async () => ({
        success: true,
        result_url: "https://s3.amazonaws.com/public.vast.ai/instance_logs/retry.log",
      }),
    } as unknown as VastClient;

    let calls = 0;
    const mockFetch = async () => {
      calls++;
      if (calls === 1) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response("INFO: model on cuda\n", { status: 200 });
    };

    const sleepCalls: number[] = [];
    const mockSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const logs = await fetchInstanceLogs(123, {
      client: mockClient,
      fetch: mockFetch as typeof fetch,
      sleep: mockSleep,
      retryDelayMs: 50,
      maxAttempts: 3,
    });

    expect(calls).toBe(2);
    expect(sleepCalls).toEqual([50]);
    expect(logs).toContain("model on cuda");
  });

  it("throws when Vast API rejects log request", async () => {
    const mockClient = {
      put: async () => ({
        success: false,
        error: "instance_not_found",
      }),
    } as unknown as VastClient;

    await expect(
      fetchInstanceLogs(999, {
        client: mockClient,
      }),
    ).rejects.toThrow(/Failed to request logs/);
  });
});
