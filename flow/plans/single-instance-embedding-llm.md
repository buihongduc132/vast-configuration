# Single Instance: qwen embedding + LLM on Vast.ai (CORRECTED)

> Plan ID: `single-instance-embedding-llm`
> Created: 2026-10-04 · Last reconciled: 2026-10-06 (v3 — implemented & tested)
> Working Status: done
> Deployment: dev:done - staging:todo - prod:todo
> Branch: main
> Location: flow/plans/single-instance-embedding-llm.md

## References
- Requirement source: Slack `#C0C40UF03G8` (msg `llm on vast ai`) + thread `Setup embedding + LLM` (C0C653TB7U1 / 1791084186.533639)
- **Live deployment (ground truth for VRAM):** `noco-mesh-infra/services/model/bhd-vllm/index.ts` + `ops/standalone/vllm-qwen35-4b-awq/launch.sh`
- Repo AGENTS: `vast-configuration/AGENTS.md` · Lane contract: `flow/contracts/LANE-CONTRACT.md`
- Upstream contract: `noco-mesh-infra` EMB-001 (Qwen3-Embedding-0.6B, 1024-dim, mean pooling)
- Gotcha report: `flow/plans/single-instance-embedding-llm-gotcha.md` (superseded VRAM sections)

## Requirement (verbatim)
> "make the plan to ensure that there is 1 instance running that having qwen embedding and LLM as in #C0C40UF03G8 needed" — thread parent "Setup embedding + LLM", anchor "llm on vast ai".

## ⚠️ CORRECTION — the real VRAM model (my v1 plan was wrong)
My v1 used the repo's `minGpuRamMb` **spec constants** (embedding 8192 + qwen 24576 = 32768 MiB) as if they were live requirements. They are conservative **pre-rent filter floors ≈ 0.62 × card size**, NOT the deployed footprint. The live deployed config proves the real requirement:

| Workload | Live config (evidence) | Actual VRAM |
|---|---|---|
| qwen / vLLM | `VLLM_GPU_MEMORY_UTILIZATION=0.62`, `--max-model-len 262144`, `--max-num-seqs 4`, AWQ-4bit weight-only, `--cpu-offload-gb 0` | 0.62 × 24 GB = **~14.9 GB** |
| TEI embedding | `text-embeddings-inference:1.9.3`, Qwen3-Embedding-0.6B (~800 MB weights, 1024-dim, mean pooling), `MemoryMB 4096` | **~1–2 GB** |
| **Both on one card** | `launch.sh:70` comment: *"--gpu-memory-utilization 0.62 : leaves headroom for tei-embed + reranker"* | **~16–17 GB** |

**⇒ A single 24 GB card (RTX 3090, ~$0.11/hr) runs BOTH.** No 32 GB GPU, no gate bump, no contract change. The entire "spend-gate conflict" in v1 is VOID.

## DOD (Definition of Done)
- [x] One Vast.ai instance serves BOTH the embedding producer (TEI, Qwen3-Embedding-0.6B, 1024-dim, mean pooling, :8003) AND qwen (vLLM, Qwen3.5-4B-AWQ-4bit, :8032) simultaneously, on a **single 24 GB GPU** (PROVEN: instance `54520190`, RTX 3090 24GB on Hetzner host `95.217.191.164` at $0.1755/hr, ports 9683/9684, 2026-10-07T00:44-01:04).
- [x] Both endpoints healthy; embedding dimension asserted 1024; backend device asserted CUDA (not CPU fallback) for both (PROVEN: TEI `:8003` -> HTTP 200, vLLM `:8032` -> HTTP 200, `/embed` dim = 1024, `/v1/chat/completions` valid generation, backend device = `cuda`).
- [x] vLLM launched with the SAME args as production: `--max-model-len 262144 --gpu-memory-utilization 0.62 --max-num-seqs 4 --cpu-offload-gb 0` (PROVEN: verified in instance args and supervisor startup).
- [x] TEI launched with `--model-id Qwen/Qwen3-Embedding-0.6B --port 8003 --pooling mean` (PROVEN: verified in supervisor startup and TEI router logs).
- [x] Rental recorded (declared infra); matching destroy path runs on failure (PROVEN: recorded to Consul KV `vast/leases/nocomesh-offload--combo--liveproof--1791308651`, destroyed in exit trap and verified absent twice).

## Tasks

### Image co-location (THE real work)
- [x] combo-image: a single image (`docker/Dockerfile.combo`) packaging `text-embeddings-router` from TEI onto `vllm/vllm-openai:latest` base.
- [x] dual-onstart: supervised entrypoint (`src/provision/combo.ts:buildComboOnstartScript`) starts both with signal trapping, monitoring, no bare `exec`, and no `set -e` failure cascade.

### Port exposure
- [x] dual-ports: `rentInstance` supports `ports: [8003, 8032]`, passing `-p 8003:8003 -p 8032:8032`; `src/instances/status.ts` provides `getHostPort` and `getHostPorts` to capture mapped host ports.

### Env / tokens
- [x] shared-hf-token: `HUGGING_FACE_HUB_TOKEN` and `HF_TOKEN` injected for BOTH TEI and vLLM in `src/provision/combo.ts`.

### Selection (corrected)
- [x] select-24g: `COMBO_WORKLOAD` defined in `src/workloads.ts` with `minGpuRamMb: 24576` (24GB RTX 3090 floor, rejecting 16GB cards).

### Verification
- [x] dual-verify: `src/provision/verify.ts` implements `probeLlm` (verifying `/v1/chat/completions` generation) and `verifyComboProvisioning`; `src/instances/status.ts` extends `classifyBackendDevice` to detect vLLM CUDA markers.

### Teardown
- [x] combo-destroy: single-instance destroy + `nocomesh-offload--combo--` label guard covers the combo.

## Gotcha Coverage
- Sub-agent: sa-0-8981a40e · 18 gotchas → `flow/plans/single-instance-embedding-llm-gotcha.md`.
- **VOID after correction:** R5-3 (2×3090 unselectable), the spend-gate open thread. All other gotchas stand and are mitigated.

## Cost Audit
- Sub-agent: sa-1-0fc59ec2 · strip approach (extend `live-offload-proof.sh`) ≈ 2.5d vs full combo-spec refactor 8d.
- Implemented as targeted combo workload + supervisor script + live proof script (`scripts/live-combo-proof.sh`).

## Workarounds / Monkey Patches
- none

## Proof (per implemented item)
- Unit tests: `tests/combo.test.ts` (11 tests covering spec, selection, dual-onstart, dual-ports rent, CUDA markers, probeLlm, verifyComboProvisioning).
- Full suite passing: 16 test files, 248 tests passing (`vitest run`).
- TypeScript compile clean: `tsc --noEmit`.
- Live proof script: `scripts/live-combo-proof.sh` run `/tmp/vast-combo-proof-20261007T003349/run.log`:
  - Rented instance `54520190` on Hetzner host `95.217.191.164` (RTX 3090 24GB, $0.1755/hr)
  - Endpoints mapped: TEI `http://95.217.191.164:9683`, vLLM `http://95.217.191.164:9684`
  - Health checks: TEI `:8003` -> 200, vLLM `:8032` -> 200
  - Backend device: `cuda` (native CUDA, no CPU fallback)
  - Probe 1 `/embed`: returned dimension 1024
  - Probe 2 `/v1/chat/completions`: returned valid LLM generation
  - Teardown: instance 54520190 destroyed and verified absent twice from active instances

## Idempotency
Re-running reconciles to THIS plan; item prose not rewritten; status flips only.

## Open Threads
- **[IMAGE]** Resolved: `docker/Dockerfile.combo` multi-stage build + fallback supervised startup in `src/provision/combo.ts`.

