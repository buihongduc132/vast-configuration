import { describe, it, expect, vi } from "vitest";
import {
  VastClient,
  VastApiError,
  VastAuthError,
  resolveApiKey,
} from "../src/api/client.js";

describe("resolveApiKey", () => {
  it("prefers VAST_API_KEY from environment if present", async () => {
    const key = await resolveApiKey({
      env: { VAST_API_KEY: "env-key-123" },
      execRunner: async () => {
        throw new Error("should not call consul");
      },
    });
    expect(key).toBe("env-key-123");
  });

  it("reads from Consul KV when env is not set", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const key = await resolveApiKey({
      env: {},
      execRunner: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "consul-key-456\n", stderr: "" };
      },
    });
    expect(key).toBe("consul-key-456");
    expect(calls).toEqual([
      { file: "consul", args: ["kv", "get", "creds/vast/api_key"] },
    ]);
  });

  it("throws descriptive error when neither env nor Consul key is available", async () => {
    await expect(
      resolveApiKey({
        env: {},
        execRunner: async () => {
          throw new Error("No key exists at: creds/vast/api_key");
        },
      }),
    ).rejects.toThrow(/could not read.*Vast\.ai API key/i);
  });

  it("throws if Consul returns empty value", async () => {
    await expect(
      resolveApiKey({
        env: {},
        execRunner: async () => ({ stdout: "   \n", stderr: "" }),
      }),
    ).rejects.toThrow(/empty/i);
  });
});

describe("VastClient REST requests and footguns", () => {
  const secretKey = "very-secret-vast-key-xyz";

  it("builds correct URL, auth header, and parses JSON on GET", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ users: [1, 2, 3] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new VastClient({
      apiKey: secretKey,
      fetch: mockFetch,
    });

    const res = await client.get<{ users: number[] }>("/users/current");
    expect(res).toEqual({ users: [1, 2, 3] });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://console.vast.ai/api/v0/users/current/");
    expect(calledInit.method).toBe("GET");
    expect((calledInit.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${secretKey}`,
    );
  });

  it("sends JSON body on POST and PUT", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, new_contract: 99 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new VastClient({
      apiKey: secretKey,
      fetch: mockFetch,
    });

    const body = { client_id: "me", disk: 20 };
    const res = await client.put<{ success: boolean; new_contract: number }>(
      "/asks/12345",
      body,
    );
    expect(res).toEqual({ success: true, new_contract: 99 });

    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://console.vast.ai/api/v0/asks/12345/");
    expect(calledInit.method).toBe("PUT");
    expect((calledInit.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(calledInit.body).toBe(JSON.stringify(body));
  });

  it("FOOTGUN: HTTP 404 with error='auth_error' throws VastAuthError and NEVER retries", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return new Response(
        JSON.stringify({ success: false, error: "auth_error", msg: "Invalid API key" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    });

    const sleep = vi.fn();
    const client = new VastClient({
      apiKey: secretKey,
      fetch: mockFetch,
      sleep,
      maxRetries: 3,
    });

    await expect(client.get("/users/current")).rejects.toThrow(VastAuthError);
    expect(callCount).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("HTTP 401 and 403 throw VastAuthError without retrying", async () => {
    for (const status of [401, 403]) {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "forbidden" }), { status }),
      );
      const client = new VastClient({
        apiKey: secretKey,
        fetch: mockFetch,
        maxRetries: 3,
      });

      await expect(client.get("/instances")).rejects.toThrow(VastAuthError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  });

  it("retries 429 and 5xx up to maxRetries with backoff and succeeds", async () => {
    let count = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      count++;
      if (count === 1) return new Response("rate limit", { status: 429 });
      if (count === 2) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new VastClient({
      apiKey: secretKey,
      fetch: mockFetch,
      sleep,
      baseDelayMs: 100,
      maxRetries: 3,
    });

    const res = await client.get<{ ok: boolean }>("/bundles");
    expect(res).toEqual({ ok: true });
    expect(count).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it("exhausting retries on 5xx throws VastApiError", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("internal server error", { status: 500 }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new VastClient({
      apiKey: secretKey,
      fetch: mockFetch,
      sleep,
      maxRetries: 2,
    });

    await expect(client.get("/bundles")).rejects.toThrow(VastApiError);
    // initial + 2 retries = 3 calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx errors other than 429", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "bad input" }), { status: 400 }),
    );
    const client = new VastClient({
      apiKey: secretKey,
      fetch: mockFetch,
      maxRetries: 3,
    });

    await expect(client.get("/bundles")).rejects.toThrow(VastApiError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("NEVER leaks the API key in error messages", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "auth_error" }), { status: 404 }),
    );
    const client = new VastClient({
      apiKey: secretKey,
      fetch: mockFetch,
    });

    try {
      await client.get("/users/current");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(secretKey);
    }
  });
});
