import { describe, it, expect } from "vitest";
import { selectOffer, NoEligibleOffersError, type VastOffer } from "../src/offers/select.js";
import { EMBEDDING_WORKLOAD, QWEN_WORKLOAD } from "../src/workloads.js";
import { SPEND_LIMITS } from "../src/limits.js";

describe("selectOffer", () => {
  const baseOffer: VastOffer = {
    id: 101,
    gpu_name: "RTX 3090",
    gpu_ram: 24576, // 24 GiB
    disk_space: 50, // 50 GiB
    dph_total: 0.2, // $0.20/hr
    rentable: true,
    reliability2: 0.95,
    inet_down: 500,
  };

  it("selects a valid offer meeting all requirements", () => {
    const selected = selectOffer(EMBEDDING_WORKLOAD, [baseOffer]);
    expect(selected.id).toBe(101);
  });

  it("accepts workload by string id", () => {
    const selected = selectOffer("embedding", [baseOffer]);
    expect(selected.id).toBe(101);
  });

  it("filters out offers with insufficient VRAM", () => {
    const undersizedVram: VastOffer = {
      ...baseOffer,
      id: 102,
      gpu_ram: EMBEDDING_WORKLOAD.minGpuRamMb - 1,
    };
    expect(() => selectOffer(EMBEDDING_WORKLOAD, [undersizedVram])).toThrow(
      NoEligibleOffersError,
    );
  });

  it("filters out offers with insufficient disk space", () => {
    const smallDisk: VastOffer = {
      ...baseOffer,
      id: 103,
      disk_space: EMBEDDING_WORKLOAD.minDiskGb - 1,
    };
    expect(() => selectOffer(EMBEDDING_WORKLOAD, [smallDisk])).toThrow(
      NoEligibleOffersError,
    );
  });

  it("filters out offers exceeding maxDphTotal spend cap", () => {
    const expensive: VastOffer = {
      ...baseOffer,
      id: 104,
      dph_total: SPEND_LIMITS.maxDphTotal + 0.01,
    };
    expect(() => selectOffer(EMBEDDING_WORKLOAD, [expensive])).toThrow(
      NoEligibleOffersError,
    );
  });

  it("allows offer exactly at maxDphTotal spend cap (boundary inclusive)", () => {
    const atCap: VastOffer = {
      ...baseOffer,
      id: 105,
      dph_total: SPEND_LIMITS.maxDphTotal,
    };
    const selected = selectOffer(EMBEDDING_WORKLOAD, [atCap]);
    expect(selected.id).toBe(105);
  });

  it("filters out offers where rentable is false", () => {
    const notRentable: VastOffer = {
      ...baseOffer,
      id: 106,
      rentable: false,
    };
    expect(() => selectOffer(EMBEDDING_WORKLOAD, [notRentable])).toThrow(
      NoEligibleOffersError,
    );
  });

  it("prefers higher reliability2 over lower price", () => {
    const cheapUnreliable: VastOffer = {
      ...baseOffer,
      id: 201,
      dph_total: 0.10,
      reliability2: 0.85,
    };
    const expensiveReliable: VastOffer = {
      ...baseOffer,
      id: 202,
      dph_total: 0.25,
      reliability2: 0.98,
    };

    const selected = selectOffer(EMBEDDING_WORKLOAD, [cheapUnreliable, expensiveReliable]);
    expect(selected.id).toBe(202);
  });

  it("prefers lower dph_total when reliability2 is tied", () => {
    const offerA: VastOffer = {
      ...baseOffer,
      id: 301,
      dph_total: 0.20,
      reliability2: 0.95,
      inet_down: 100,
    };
    const offerB: VastOffer = {
      ...baseOffer,
      id: 302,
      dph_total: 0.15,
      reliability2: 0.95,
      inet_down: 100,
    };

    const selected = selectOffer(EMBEDDING_WORKLOAD, [offerA, offerB]);
    expect(selected.id).toBe(302);
  });

  it("prefers higher inet_down when reliability2 and dph_total are tied", () => {
    const slowNet: VastOffer = {
      ...baseOffer,
      id: 401,
      dph_total: 0.15,
      reliability2: 0.95,
      inet_down: 100,
    };
    const fastNet: VastOffer = {
      ...baseOffer,
      id: 402,
      dph_total: 0.15,
      reliability2: 0.95,
      inet_down: 1000,
    };

    const selected = selectOffer(EMBEDDING_WORKLOAD, [slowNet, fastNet]);
    expect(selected.id).toBe(402);
  });

  it("throws NoEligibleOffersError when given empty offers array", () => {
    expect(() => selectOffer(QWEN_WORKLOAD, [])).toThrow(NoEligibleOffersError);
  });
});
