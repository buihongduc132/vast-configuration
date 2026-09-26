import { describe, it, expect, vi } from "vitest";
import {
  buildEmbeddingProvisionConfig,
  resolveHfToken,
} from "../src/provision/embedding.js";
import {
  probeEmbedding,
  EmbeddingDimensionMismatchError,
} from "../src/provision/verify.js";
import {
  EMBEDDING_DIMENSION,
  TEI_IMAGE,
  TEI_POOLING,
  EMBEDDING_WORKLOAD,
} from "../src/workloads.js";

describe("resolveHfToken", () => {
  it("prefers environment variable if set", async () => {
    const token = await resolveHfToken({
      env: { HUGGING_FACE_HUB_TOKEN: "hf_env_token_123" },
      execRunner: async () => {
        throw new Error("should not call consul");
      },
    });
    expect(token).toBe("hf_env_token_123");
  });

  it("reads from Consul KV creds/common/huggingface/api_key", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const token = await resolveHfToken({
      env: {},
      execRunner: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "hf_consul_token_456\n", stderr: "" };
      },
    });
    expect(token).toBe("hf_consul_token_456");
    expect(calls).toEqual([
      { file: "consul", args: ["kv", "get", "creds/common/huggingface/api_key"] },
    ]);
  });
});

describe("buildEmbeddingProvisionConfig", () => {
  it("builds the exact TEI image, args, port, and env", async () => {
    const config = await buildEmbeddingProvisionConfig({
      hfToken: "test_hf_token",
    });

    expect(config.image).toBe(TEI_IMAGE);
    expect(config.image).toBe("ghcr.io/huggingface/text-embeddings-inference:1.9.3");
    expect(config.port).toBe(8003);
    expect(config.port).toBe(EMBEDDING_WORKLOAD.port);
    expect(config.args).toContain("--model-id");
    expect(config.args).toContain("Qwen/Qwen3-Embedding-0.6B");
    expect(config.args).toContain("--port");
    expect(config.args).toContain("8003");
    expect(config.args).toContain("--pooling");
    expect(config.args).toContain(TEI_POOLING); // mean
    expect(config.env["HUGGING_FACE_HUB_TOKEN"]).toBe("test_hf_token");
    expect(config.onstart).toContain("Qwen/Qwen3-Embedding-0.6B");
    expect(config.onstart).toContain("8003");
  });
});

describe("probeEmbedding", () => {
  it("succeeds when returned vector length is exactly 1024", async () => {
    const dummyVector = new Array(EMBEDDING_DIMENSION).fill(0.01);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(dummyVector), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const vector = await probeEmbedding("http://vast-box:8003", {
      fetch: mockFetch,
    });

    expect(vector).toHaveLength(1024);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://vast-box:8003/embed");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ inputs: "test" });
  });

  it("handles 2D array response [[...1024 dims...]]", async () => {
    const dummyVector = [new Array(EMBEDDING_DIMENSION).fill(0.02)];
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(dummyVector), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const vector = await probeEmbedding("http://vast-box:8003", {
      fetch: mockFetch,
    });
    expect(vector).toHaveLength(1024);
  });

  it("throws EmbeddingDimensionMismatchError when vector length is not 1024 (e.g. 768)", async () => {
    const wrongVector = new Array(768).fill(0.01);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(wrongVector), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      probeEmbedding("http://vast-box:8003", { fetch: mockFetch }),
    ).rejects.toThrow(EmbeddingDimensionMismatchError);
  });

  it("throws on HTTP error status", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("model loading failed", { status: 500 }),
    );

    await expect(
      probeEmbedding("http://vast-box:8003", { fetch: mockFetch }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
