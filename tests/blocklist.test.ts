// tests/blocklist.test.ts
// =============================================================================
// Unit tests for HostBlocklist (src/instances/blocklist.ts) & integration with
// offer selection (src/offers/select.ts).
//
// ⚠️ ANTI-PATTERN GUARDS:
// 1. Never touch $HOME/.vast-host-blocklist in tests. All paths are injected into
//    a temporary directory (os.tmpdir()).
// 2. HostBlocklist throws in test environment if filePath is omitted.
// 3. Corrupt/partial blocklist files must never crash selection (fail-safe).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  HostBlocklist,
  loadBlocklist,
  isHostBlocked,
  DEFAULT_BLOCKLIST_TTL_MS,
} from "../src/instances/blocklist.js";
import { selectOffer, selectCandidateOffers, type VastOffer } from "../src/offers/select.js";
import { EMBEDDING_WORKLOAD } from "../src/workloads.js";

describe("HostBlocklist (src/instances/blocklist.ts)", () => {
  let tmpDir: string;
  let testBlocklistPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vast-blocklist-test-"));
    testBlocklistPath = path.join(tmpDir, "host-blocklist.txt");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const baseOffer: VastOffer = {
    id: 101,
    machine_id: 14338, // The real machine that broke twice live
    gpu_name: "RTX 3090",
    gpu_ram: 24576,
    disk_space: 50,
    dph_total: 0.12,
    rentable: true,
    reliability2: 0.98,
    inet_down: 500,
    cuda_max_good: 13.0,
  };

  const cleanOffer: VastOffer = {
    ...baseOffer,
    id: 102,
    machine_id: 14339,
  };

  it("blocklist writes go to an injected temp path, never $HOME", async () => {
    const homeBlocklist = path.join(os.homedir(), ".vast-host-blocklist");
    const mtimeBefore = fs.existsSync(homeBlocklist)
      ? fs.statSync(homeBlocklist).mtimeMs
      : null;

    const blocklist = new HostBlocklist({ filePath: testBlocklistPath });
    await blocklist.add(14338, "broken nvidia container toolkit");

    // Proves file was written to the injected temp path
    expect(fs.existsSync(testBlocklistPath)).toBe(true);
    const content = fs.readFileSync(testBlocklistPath, "utf8");
    expect(content).toContain("14338");
    expect(content).toContain("broken nvidia container toolkit");

    // Proves $HOME was NEVER touched
    if (mtimeBefore !== null) {
      expect(fs.statSync(homeBlocklist).mtimeMs).toBe(mtimeBefore);
    } else {
      expect(fs.existsSync(homeBlocklist)).toBe(false);
    }
  });

  it("guards against instantiating HostBlocklist without explicit filePath in test mode", () => {
    expect(() => new HostBlocklist()).toThrow(
      /HostBlocklist requires an explicit filePath in tests to avoid touching \$HOME/,
    );
  });

  it("blocklist: add → excluded from candidate selection; TTL expiry → eligible again", async () => {
    let testTime = 1_700_000_000_000;
    const nowFn = () => testTime;

    const blocklist = new HostBlocklist({
      filePath: testBlocklistPath,
      ttlMs: DEFAULT_BLOCKLIST_TTL_MS, // 24h
      now: nowFn,
    });

    // Before blocklisting: machine 14338 is eligible
    const candidatesBefore = selectCandidateOffers(EMBEDDING_WORKLOAD, [baseOffer, cleanOffer], {
      blocklist,
    });
    expect(candidatesBefore.map((c) => c.id)).toContain(101);

    // Add machine 14338 to blocklist with reason
    await blocklist.add(14338, "oci-runtime-create-failed");
    expect(blocklist.isBlocked(14338)).toBe(true);
    expect(blocklist.isBlocked(14339)).toBe(false);

    // After blocklisting: machine 14338 is EXCLUDED from candidate selection
    const candidatesAfter = selectCandidateOffers(EMBEDDING_WORKLOAD, [baseOffer, cleanOffer], {
      blocklist,
    });
    expect(candidatesAfter.map((c) => c.id)).not.toContain(101);
    expect(candidatesAfter.map((c) => c.id)).toEqual([102]);

    const selected = selectOffer(EMBEDDING_WORKLOAD, [baseOffer, cleanOffer], { blocklist });
    expect(selected.id).toBe(102);

    // TTL Expiry: advance clock by 25 hours (beyond 24h TTL)
    testTime += 25 * 60 * 60 * 1000;

    // After TTL expiry: machine 14338 is ELIGIBLE AGAIN
    expect(blocklist.isBlocked(14338)).toBe(false);
    const candidatesExpired = selectCandidateOffers(EMBEDDING_WORKLOAD, [baseOffer, cleanOffer], {
      blocklist,
    });
    expect(candidatesExpired.map((c) => c.id)).toContain(101);
  });

  it("a corrupt/partial blocklist file does not crash selection (fail safe, log and continue)", () => {
    // Write corrupt content: garbage text, unparseable dates, partial lines, negative numbers
    const corruptContent = `
# Comment line
invalid_machine_id 2026-09-27T00:00:00Z reason
14338
14338 NOT_A_DATE reason_here
-9999 2026-09-27T00:00:00Z negative_id
14340 2026-09-27T00:00:00Z valid_blocked_box
{"json":"not_expected_here"}
`;
    fs.writeFileSync(testBlocklistPath, corruptContent, "utf8");

    const warnings: string[] = [];
    const blocklist = new HostBlocklist({
      filePath: testBlocklistPath,
      now: () => Date.parse("2026-09-27T01:00:00Z"),
      onWarning: (w) => warnings.push(w),
    });

    // Must NOT throw when reading corrupt file
    expect(() => blocklist.getBlockedMachineIds()).not.toThrow();

    // Warnings were logged for corrupt lines
    expect(warnings.length).toBeGreaterThan(0);

    // Valid entry 14340 is still properly identified as blocked
    expect(blocklist.isBlocked(14340)).toBe(true);

    // Selection does NOT crash when given corrupt file path
    const offer14340: VastOffer = { ...cleanOffer, id: 103, machine_id: 14340 };
    const candidates = selectCandidateOffers(EMBEDDING_WORKLOAD, [cleanOffer, offer14340], {
      blocklistPath: testBlocklistPath,
      now: () => Date.parse("2026-09-27T01:00:00Z"),
    });

    // 14340 was excluded, cleanOffer 102 was selected without crash
    expect(candidates.map((c) => c.id)).toEqual([102]);
  });

  it("loadBlocklist helper reads file and returns Set of active blocked machine IDs", async () => {
    const blocklist = new HostBlocklist({
      filePath: testBlocklistPath,
      now: () => 1_000_000,
    });
    await blocklist.add(777, "host failure");
    await blocklist.add(888, "cpu fallback");

    const blocked = loadBlocklist(testBlocklistPath, { now: () => 1_000_000 });
    expect(blocked.has(777)).toBe(true);
    expect(blocked.has(888)).toBe(true);
    expect(blocked.has(999)).toBe(false);

    expect(isHostBlocked(777, { filePath: testBlocklistPath, now: () => 1_000_000 })).toBe(true);
    expect(isHostBlocked(999, { filePath: testBlocklistPath, now: () => 1_000_000 })).toBe(false);
  });
});
