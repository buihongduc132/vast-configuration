import { describe, it, expect } from "vitest";
import {
  isFatalHostStatusMsg,
  classifyStatusMsg,
  classifyInstanceState,
} from "../src/instances/status.js";

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
});
