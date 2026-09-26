// src/policy/gate.ts
// =============================================================================
// Invokes the OPA rental admission gate (policies/rego/vast_spend.rego) and
// converts its verdict into a decision the rent path can branch on.
//
// WHY SHELL OUT TO OPA AT ALL, when src/limits.ts already checks the same two
// numbers? Because a policy nobody executes is a document, not a gate. The Rego
// is authoritative; canRent() is defence in depth. Both read
// policies/data/spend-limits.json, and a test asserts they agree on every
// boundary.
//
// ⚠️ FAIL-CLOSED, EXHAUSTIVELY. Every way this can fail to produce a real
// verdict must deny, because the failure mode of a spend gate is measured in
// dollars:
//   * `opa` binary missing / not executable       -> deny
//   * non-zero exit, signal, or timeout           -> deny
//   * stdout not JSON, or unexpected shape        -> deny
//   * query returned no result (undefined)        -> deny
//   * `allow` is anything other than boolean true -> deny
//   * limits_seen carries an error, i.e. the policy evaluated against no
//     limits document at all                      -> deny
//
// That last one matters most. `opa eval` exits 0 with an EMPTY RESULT SET when a
// referenced document is absent, so "exit 0 and no violations" is exactly what a
// completely unloaded policy looks like. Proven live 2026-09-27: $9.99/hr passed
// a naive gate that way. Silence is never approval.
// =============================================================================

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Directory holding the .rego policies. */
export const POLICY_REGO_DIR = join(HERE, "..", "..", "policies", "rego");
/** Directory holding spend-limits.json. */
export const POLICY_DATA_DIR = join(HERE, "..", "..", "policies", "data");
/** The query whose verdict governs renting. */
export const RENT_DECISION_QUERY = "data.vast.spend.decision";

/** Default OPA binary; override with VAST_OPA_BIN. */
export function opaBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.VAST_OPA_BIN?.trim() || "opa";
}

export interface GateInputCandidate {
  readonly id?: number;
  readonly dph_total: number;
  readonly machine_id?: number;
}

export interface GateInput {
  readonly action: "rent";
  readonly candidate: GateInputCandidate;
  /**
   * Every instance currently on the account, foreign ones included — they bill
   * the same card. Pass the list, not a count: the policy refuses a scalar so a
   * caller cannot understate concurrency.
   */
  readonly live_instances: readonly unknown[];
}

export interface GateVerdict {
  readonly allow: boolean;
  readonly deny: readonly string[];
  /** The limits the policy actually read, echoed back as proof it saw them. */
  readonly limitsSeen: Record<string, unknown> | undefined;
  /** Raw stdout, kept for the audit log. */
  readonly raw?: string;
}

export class PolicyGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyGateError";
  }
}

export interface RunOpaOptions {
  readonly regoDir?: string;
  readonly dataDir?: string;
  readonly query?: string;
  readonly binary?: string;
  readonly timeoutMs?: number;
  /** Test seam: replace the actual process invocation. */
  readonly runner?: (args: {
    binary: string;
    argv: readonly string[];
    stdin: string;
    timeoutMs: number;
  }) => Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>;
}

async function defaultRunner(args: {
  binary: string;
  argv: readonly string[];
  stdin: string;
  timeoutMs: number;
}): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(args.binary, [...args.argv], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(new PolicyGateError(`cannot spawn ${args.binary}: ${(err as Error).message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new PolicyGateError(`${args.binary} timed out after ${args.timeoutMs}ms`));
    }, args.timeoutMs);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PolicyGateError(`cannot run ${args.binary}: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });

    child.stdin.on("error", () => {
      /* EPIPE when the binary is absent; surfaced by 'error'/'close' instead */
    });
    child.stdin.end(args.stdin);
  });
}

/**
 * Evaluate the rent gate. NEVER throws for a policy denial — a denial is a
 * verdict. Throws only when no verdict could be obtained, and every caller must
 * treat a throw as a denial too (see assertRentAllowed).
 */
export async function evaluateRentGate(
  input: GateInput,
  options: RunOpaOptions = {},
): Promise<GateVerdict> {
  const binary = options.binary ?? opaBinary();
  const regoDir = options.regoDir ?? POLICY_REGO_DIR;
  const dataDir = options.dataDir ?? POLICY_DATA_DIR;
  const query = options.query ?? RENT_DECISION_QUERY;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const runner = options.runner ?? defaultRunner;

  const argv = [
    "eval",
    "--data",
    regoDir,
    "--data",
    dataDir,
    "--stdin-input",
    "--format",
    "json",
    query,
  ];

  const res = await runner({ binary, argv, stdin: JSON.stringify(input), timeoutMs });

  if (res.signal) {
    throw new PolicyGateError(`${binary} was killed by ${res.signal} — no verdict`);
  }
  if (res.code !== 0) {
    throw new PolicyGateError(
      `${binary} exited ${res.code}: ${res.stderr.trim() || res.stdout.trim() || "(no output)"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new PolicyGateError(
      `${binary} produced output that is not JSON: ${res.stdout.slice(0, 400)}`,
    );
  }

  // opa eval --format json => { result: [ { expressions: [ { value } ] } ] }
  // An ABSENT document yields exit 0 with result omitted or empty. That is the
  // fail-open trap; it must read as a denial.
  const result = (parsed as { result?: unknown })?.result;
  if (!Array.isArray(result) || result.length === 0) {
    throw new PolicyGateError(
      `${query} was undefined — the policy did not evaluate (are ${regoDir} and ${dataDir} both loaded?). Treating as DENY.`,
    );
  }

  const expressions = (result[0] as { expressions?: unknown })?.expressions;
  if (!Array.isArray(expressions) || expressions.length === 0) {
    throw new PolicyGateError(`${query} returned no expressions — treating as DENY`);
  }

  const value = (expressions[0] as { value?: unknown })?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyGateError(
      `${query} returned ${JSON.stringify(value)} instead of a decision object — treating as DENY`,
    );
  }

  const v = value as Record<string, unknown>;
  const denyRaw = v.deny;
  const deny = Array.isArray(denyRaw) ? denyRaw.map((d) => String(d)) : [];
  const limitsSeen =
    v.limits_seen && typeof v.limits_seen === "object" && !Array.isArray(v.limits_seen)
      ? (v.limits_seen as Record<string, unknown>)
      : undefined;

  // Strict true only. A missing or truthy-but-not-true `allow` is a deny.
  let allow = v.allow === true;

  // Cross-check: the policy must have read real limits. If it evaluated against
  // nothing, refuse even if deny happens to be empty.
  if (allow) {
    if (!limitsSeen || typeof limitsSeen.error === "string") {
      allow = false;
      deny.push(
        `VAST-SPEND-000: policy reported allow but did not read a limits document (${String(limitsSeen?.error ?? "limits_seen absent")}) — treating as DENY`,
      );
    } else if (
      typeof limitsSeen.maxConcurrentInstances !== "number" ||
      typeof limitsSeen.maxDphPerInstance !== "number"
    ) {
      allow = false;
      deny.push(
        "VAST-SPEND-000: policy reported allow but the limits it read lack numeric ceilings — treating as DENY",
      );
    }
  }

  // Belt and braces: allow and a non-empty deny set must never coexist.
  if (allow && deny.length > 0) {
    allow = false;
    deny.push("VAST-SPEND-000: policy reported allow alongside violations — treating as DENY");
  }

  return { allow, deny, limitsSeen, raw: res.stdout };
}

/**
 * The chokepoint the rent path calls. Throws unless the policy affirmatively
 * allows. Any failure to obtain a verdict also throws — the caller can never
 * mistake "could not ask" for "was permitted".
 */
export async function assertRentAllowed(
  input: GateInput,
  options: RunOpaOptions = {},
): Promise<GateVerdict> {
  let verdict: GateVerdict;
  try {
    verdict = await evaluateRentGate(input, options);
  } catch (err) {
    throw new PolicyGateError(
      `rent DENIED — the OPA spend gate could not be evaluated: ${(err as Error).message}`,
    );
  }
  if (!verdict.allow) {
    const reasons = verdict.deny.length > 0 ? verdict.deny.join("; ") : "(policy returned no reason)";
    throw new PolicyGateError(`rent DENIED by OPA spend gate: ${reasons}`);
  }
  return verdict;
}
