import { describe, it, expect } from "vitest";
import {
  isFatalHostStatusMsg,
  classifyStatusMsg,
  classifyInstanceState,
  classifyBackendDevice,
  stripAnsi,
  fetchInstanceLogs,
  CpuBackendError,
  UnknownBackendError,
  FatalHostError,
  waitForInstanceReady,
  TerminalInstanceStateError,
  isBackendVerified,
  assertBackendVerified,
  PRE_CONTAINER_START_DEADLINE_MS,
  POST_CONTAINER_HEALTH_DEADLINE_MS,
  CANDIDATE_DEADLINE_MS,
  HEALTH_WAIT_DEADLINE_MS,
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

  it("classifies real live incident on 2026-09-27 (cuda 12.2 / 12.8 silent CPU fallback) as cpu", () => {
    expect(classifyBackendDevice(verbatimCpuLog)).toBe("cpu");
  });

  it("classifies the exact same incident log excerpt ANSI-colorised as cpu (regression guard)", () => {
    // Real tracing-subscriber ANSI escape sequences from Rust TEI container logs
    const ansiColorisedIncident =
      "\x1b[2m2026-09-27T00:46:17.319089Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2mtext_embeddings_backend_candle\x1b[0m\x1b[2m:\x1b[0m Could not find a compatible CUDA device on host: CUDA is not available\n" +
      "Caused by:\n" +
      "    DriverError(CUDA_ERROR_COMPAT_NOT_SUPPORTED_ON_DEVICE, \"forward compatibility was attempted on non supported HW\")\n" +
      "\x1b[2m2026-09-27T00:46:17.319120Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2mtext_embeddings_backend_candle\x1b[0m\x1b[2m:\x1b[0m Using CPU instead\n" +
      "\x1b[2m2026-09-27T00:46:17.319150Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mtext_embeddings_backend_candle\x1b[0m\x1b[2m:\x1b[0m Starting Qwen3 model on Cpu\n" +
      "\x1b[2m2026-09-27T00:46:17.319200Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mtext_embeddings_router\x1b[0m\x1b[2m:\x1b[0m Warming up model\n";

    expect(classifyBackendDevice(ansiColorisedIncident)).toBe("cpu");
  });

  it("classifies healthy CUDA startup log as cuda", () => {
    expect(classifyBackendDevice(cudaLog)).toBe("cuda");
    const ansiCuda =
      "\x1b[2m2026-09-27T01:00:00Z\x1b[0m \x1b[32m INFO\x1b[0m text_embeddings_backend_candle: Starting Qwen3 model on Cuda\n" +
      "\x1b[2m2026-09-27T01:00:05Z\x1b[0m \x1b[32m INFO\x1b[0m text_embeddings_router: Warming up model\n";
    expect(classifyBackendDevice(ansiCuda)).toBe("cuda");
  });

  it("classifies empty log, truncated log, and log with no device line as unknown, and caller helpers treat unknown as NOT verified", () => {
    const emptyLogs = ["", "   \n  \t", null, undefined];
    for (const empty of emptyLogs) {
      expect(classifyBackendDevice(empty)).toBe("unknown");
    }

    const truncatedLog = "2026-09-27T01:00:00Z INFO text_embeddings_backend_candle: St";
    expect(classifyBackendDevice(truncatedLog)).toBe("unknown");

    const noDeviceLineLog =
      "2026-09-27T01:00:00Z INFO text_embeddings_router: Listening on port 8003\n" +
      "2026-09-27T01:00:01Z INFO text_embeddings_router: Ready for queries\n";
    expect(classifyBackendDevice(noDeviceLineLog)).toBe("unknown");

    // Caller helper isBackendVerified explicitly treats unknown as NOT verified (false)
    expect(isBackendVerified("unknown")).toBe(false);
    expect(isBackendVerified("cpu")).toBe(false);
    expect(isBackendVerified(null)).toBe(false);
    expect(isBackendVerified(undefined)).toBe(false);
    expect(isBackendVerified({ device: "unknown" })).toBe(false);
    expect(isBackendVerified({ backend: "unknown" })).toBe(false);
    expect(isBackendVerified({ device: "cpu" })).toBe(false);

    // Only 'cuda' is verified
    expect(isBackendVerified("cuda")).toBe(true);
    expect(isBackendVerified({ device: "cuda" })).toBe(true);
    expect(isBackendVerified({ backend: "cuda" })).toBe(true);

    // Caller helper assertBackendVerified throws UnknownBackendError on unknown
    expect(() => assertBackendVerified("unknown", 404)).toThrow(UnknownBackendError);
    expect(() => assertBackendVerified({ device: "unknown" }, 404)).toThrow(UnknownBackendError);
    expect(() => assertBackendVerified("cpu", 404)).toThrow(CpuBackendError);
    expect(() => assertBackendVerified("cuda", 404)).not.toThrow();
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

  it("CpuBackendError and UnknownBackendError extend FatalHostError", () => {
    const cpuErr = new CpuBackendError(999, "degraded to cpu");
    expect(cpuErr).toBeInstanceOf(FatalHostError);
    expect(cpuErr.name).toBe("CpuBackendError");
    expect(cpuErr.instanceId).toBe(999);
    expect(cpuErr.message).toContain("CPU fallback");

    const unknownErr = new UnknownBackendError(888, "unverified device");
    expect(unknownErr).toBeInstanceOf(FatalHostError);
    expect(unknownErr.name).toBe("UnknownBackendError");
    expect(unknownErr.instanceId).toBe(888);
    expect(unknownErr.message).toContain("could not be verified");
  });

  it("each of the three real fatal host strings is classified fatal and NOT confused with cpu", () => {
    const realFatalStrings = [
      "dial tcp: lookup ghcr.io: no such host",
      "OCI runtime create failed: could not apply required modification to OCI specification",
      "failed to create task for container",
    ];

    for (const msg of realFatalStrings) {
      // Must be classified as fatal-host
      expect(isFatalHostStatusMsg(msg), `expected isFatalHostStatusMsg for "${msg}"`).toBe(true);
      expect(classifyStatusMsg(msg), `expected fatal-host for "${msg}"`).toBe("fatal-host");

      // Must NEVER be confused with CPU fallback
      const deviceClassification = classifyBackendDevice(msg);
      expect(deviceClassification, `expected not cpu for "${msg}"`).not.toBe("cpu");
      expect(deviceClassification).toBe("unknown");
    }
  });

  it("normal progress lines (Pull complete, Extracting, Verifying Checksum, Download complete) are NOT fatal", () => {
    const progressLines = [
      "Pull complete",
      "Extracting",
      "Verifying Checksum",
      "Download complete",
    ];

    for (const line of progressLines) {
      expect(isFatalHostStatusMsg(line), `expected non-fatal for "${line}"`).toBe(false);
      expect(classifyStatusMsg(line)).toBe("progress");
    }
  });

  it("the two deadlines are independent: a 206s pull does not trip the pre-container deadline if the container has already started", async () => {
    // 1. Verify named values
    expect(PRE_CONTAINER_START_DEADLINE_MS).toBe(7 * 60_000); // 7m = 420s
    expect(POST_CONTAINER_HEALTH_DEADLINE_MS).toBe(12 * 60_000); // 12m = 720s
    expect(CANDIDATE_DEADLINE_MS).toBe(PRE_CONTAINER_START_DEADLINE_MS);
    expect(HEALTH_WAIT_DEADLINE_MS).toBe(POST_CONTAINER_HEALTH_DEADLINE_MS);

    // 2. Simulate image pull alone taking 206s on a good box
    let simulatedTime = 1_000_000;
    const nowFn = () => simulatedTime;

    const pullDurationMs = 206_000; // 206s measured image pull
    let polls = 0;

    const mockClient = {
      get: async () => {
        polls++;
        if (polls === 1) {
          // Poll 1: still pulling
          simulatedTime += 100_000;
          return { instances: [{ id: 1001, actual_status: "loading", status_msg: "Extracting" }] };
        }
        if (polls === 2) {
          // Poll 2: finished 206s pull, container now started
          simulatedTime += 106_000;
          return { instances: [{ id: 1001, actual_status: "running", cur_state: "running" }] };
        }
        return { instances: [{ id: 1001, actual_status: "running" }] };
      },
    } as unknown as VastClient;

    const sleepCalls: number[] = [];
    const mockSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    // waitForInstanceReady completes in 206s, well under PRE_CONTAINER_START_DEADLINE_MS (420s)
    const inst = await waitForInstanceReady(1001, {
      client: mockClient,
      timeoutMs: PRE_CONTAINER_START_DEADLINE_MS,
      pollIntervalMs: 15_000,
      sleep: mockSleep,
      now: nowFn,
    });

    expect(inst.actual_status).toBe("running");
    expect(simulatedTime - 1_000_000).toBe(pullDurationMs);
    // Did NOT trip the pre-container deadline!
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
