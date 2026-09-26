import { describe, it, expect } from "vitest";
import {
  selectOffer,
  selectCandidateOffers,
  isGeoExcluded,
  NoEligibleOffersError,
  DEFAULT_MIN_CUDA,
  type VastOffer,
} from "../src/offers/select.js";
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
    cuda_max_good: 13.0,
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

  it("excludes CN geolocation offers by default", () => {
    const cnOffer: VastOffer = {
      ...baseOffer,
      id: 501,
      geolocation: "Fujian, CN",
    };
    const usOffer: VastOffer = {
      ...baseOffer,
      id: 502,
      geolocation: "Pennsylvania, US",
    };

    const selected = selectOffer(EMBEDDING_WORKLOAD, [cnOffer, usOffer]);
    expect(selected.id).toBe(502);

    // If only CN offers exist, throws NoEligibleOffersError by default
    expect(() => selectOffer(EMBEDDING_WORKLOAD, [cnOffer])).toThrow(NoEligibleOffersError);
  });

  it("allows overriding geo-exclusion via options", () => {
    const cnOffer: VastOffer = {
      ...baseOffer,
      id: 501,
      geolocation: "CN",
    };

    // Disabling geo-exclusion allows CN offer
    const selected = selectOffer(EMBEDDING_WORKLOAD, [cnOffer], { excludeGeo: [] });
    expect(selected.id).toBe(501);

    // Excluding US excludes US offer
    const usOffer: VastOffer = {
      ...baseOffer,
      id: 502,
      geolocation: "US",
    };
    expect(() => selectOffer(EMBEDDING_WORKLOAD, [usOffer], { excludeGeo: ["US"] })).toThrow(
      NoEligibleOffersError,
    );
  });

  it("selectCandidateOffers returns ranked list of all eligible candidates", () => {
    const offer1: VastOffer = {
      ...baseOffer,
      id: 601,
      reliability2: 0.90,
      dph_total: 0.20,
      geolocation: "US",
    };
    const offer2: VastOffer = {
      ...baseOffer,
      id: 602,
      reliability2: 0.98,
      dph_total: 0.30,
      geolocation: "DE",
    };
    const offer3: VastOffer = {
      ...baseOffer,
      id: 603,
      reliability2: 0.95,
      dph_total: 0.15,
      geolocation: "CA",
    };
    const cnOffer: VastOffer = {
      ...baseOffer,
      id: 604,
      reliability2: 0.99,
      dph_total: 0.10,
      geolocation: "CN", // excluded by default
    };

    const candidates = selectCandidateOffers(EMBEDDING_WORKLOAD, [
      offer1,
      offer2,
      offer3,
      cnOffer,
    ]);

    // CN is excluded; order is reliability2 desc: offer2 (0.98), offer3 (0.95), offer1 (0.90)
    expect(candidates.map((c) => c.id)).toEqual([602, 603, 601]);
  });

  it("isGeoExcluded correctly identifies country codes with word boundaries", () => {
    expect(isGeoExcluded("Fujian, CN")).toBe(true);
    expect(isGeoExcluded("CN")).toBe(true);
    expect(isGeoExcluded("cn")).toBe(true);
    expect(isGeoExcluded("Pennsylvania, US")).toBe(false);
    expect(isGeoExcluded("US")).toBe(false);
    expect(isGeoExcluded(undefined)).toBe(false);
    expect(isGeoExcluded(null)).toBe(false);
    expect(isGeoExcluded("CN", [])).toBe(false);
  });

  describe("minimum CUDA gate (minCuda, default 12.8)", () => {
    it("rejects offer with cuda_max_good: 12.2 and accepts offer with cuda_max_good: 13.0", () => {
      const failingBox: VastOffer = {
        ...baseOffer,
        id: 701,
        cuda_max_good: 12.2, // failing live box (driver 535.113.01)
      };
      const passingBox: VastOffer = {
        ...baseOffer,
        id: 702,
        cuda_max_good: 13.0,
      };

      // When only 12.2 offer is available, selectOffer throws NoEligibleOffersError
      expect(() => selectOffer(EMBEDDING_WORKLOAD, [failingBox])).toThrow(
        NoEligibleOffersError,
      );

      // When 13.0 offer is available, selectOffer accepts it
      const selected = selectOffer(EMBEDDING_WORKLOAD, [failingBox, passingBox]);
      expect(selected.id).toBe(702);
    });

    it("allows configuring minCuda via SelectOffersOptions", () => {
      const box122: VastOffer = {
        ...baseOffer,
        id: 703,
        cuda_max_good: 12.2,
      };

      // With default (12.8), rejects 12.2
      expect(() => selectOffer(EMBEDDING_WORKLOAD, [box122])).toThrow(NoEligibleOffersError);

      // With custom minCuda: 12.0, accepts 12.2
      const selected = selectOffer(EMBEDDING_WORKLOAD, [box122], { minCuda: 12.0 });
      expect(selected.id).toBe(703);
    });

    it("rejects offers missing cuda_max_good", () => {
      const noCudaOffer: VastOffer = {
        ...baseOffer,
        id: 704,
        cuda_max_good: undefined,
      };
      expect(() => selectOffer(EMBEDDING_WORKLOAD, [noCudaOffer])).toThrow(
        NoEligibleOffersError,
      );
    });
  });

  describe("bandwidth ranking (inet_down: 0 as last resort)", () => {
    it("never prefers a box with inet_down: 0 over a box with measured bandwidth", () => {
      const boxWithZeroNet: VastOffer = {
        ...baseOffer,
        id: 801,
        reliability2: 0.99, // higher reliability
        dph_total: 0.10,     // lower price
        inet_down: 0,        // unmeasured / broken network
      };

      const boxWithMeasuredNet: VastOffer = {
        ...baseOffer,
        id: 802,
        reliability2: 0.95, // lower reliability
        dph_total: 0.20,     // higher price
        inet_down: 500,      // verified download speed
      };

      const selected = selectOffer(EMBEDDING_WORKLOAD, [boxWithZeroNet, boxWithMeasuredNet]);
      expect(selected.id).toBe(802);

      const candidates = selectCandidateOffers(EMBEDDING_WORKLOAD, [
        boxWithZeroNet,
        boxWithMeasuredNet,
      ]);
      expect(candidates[0]?.id).toBe(802);
      expect(candidates[1]?.id).toBe(801);
    });

    it("accepts a box with inet_down: 0 as last resort when it is the only candidate", () => {
      const onlyBox: VastOffer = {
        ...baseOffer,
        id: 803,
        inet_down: 0,
      };

      const selected = selectOffer(EMBEDDING_WORKLOAD, [onlyBox]);
      expect(selected.id).toBe(803);
    });

    it("treats missing / undefined inet_down as last resort alongside 0", () => {
      const missingNetBox: VastOffer = {
        ...baseOffer,
        id: 804,
        inet_down: undefined,
        reliability2: 0.99,
      };

      const measuredNetBox: VastOffer = {
        ...baseOffer,
        id: 805,
        inet_down: 100,
        reliability2: 0.95,
      };

      const selected = selectOffer(EMBEDDING_WORKLOAD, [missingNetBox, measuredNetBox]);
      expect(selected.id).toBe(805);
    });
  });
});

