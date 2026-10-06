# Gotcha Coverage — single-instance-embedding-llm

> Source: flow/plans/single-instance-embedding-llm.md
> Mode: plan
> Sub-agent: sa-0-8981a40e
> Units reviewed: combo-spec, qwen-provision, dual-onstart, combo-select, dual-verify, combo-reconcile, spend-decision

## Findings (ranked — 18 total)

### Rank 5 (Sophisticated — reshape the plan)
- **R5-1 One image, two incompatible images.** Vast rents ONE `image` per instance (`rent.ts:223-231`). TEI = `ghcr.io/huggingface/text-embeddings-inference:1.9.3`; vLLM = `vllm/vllm-openai`. Neither image contains the other's binary. `dual-onstart` has no container to run in. Mitigation: build/publish a combined image, use a supervisor image that pulls both at runtime, OR rescope to two instances.
- **R5-2 TS rent path has NO port mapping.** `rent.ts` rentBody has no `ports`/`-p` args; only `scripts/live-offload-proof.sh` (runtype `args`, `-p 8003:8003`) exposes ports. Combo needs BOTH 8003 and 8032 mapped. Mitigation: add dual port mapping + capture both `HostPort` from `instance.ports`.
- **R5-3 2×3090 structurally unselectable.** `select.ts` filters per-GPU `gpu_ram` (24576 < 32768) and never multiplies by `num_gpus`; `bin/vast.ts:97,174` hardcode `num_gpus eq 1`. The plan's "Option A 2×3090" cannot be selected by the code it claims to extend. Mitigation: aggregate `gpu_ram*num_gpus` + lift `num_gpus eq 1`, or drop 2×3090 and commit to a single ≥32 GiB card.

### Rank 4 (Significant)
- **R4-1 `embedding+qwen` breaks `WorkloadId` union** (`workloads.ts:17`), `getWorkload` throws, CLI usage breaks.
- **R4-2 backend-device assertion is TEI-specific** (`status.ts:241-258` matches `model on cuda`); a healthy vLLM logs differently → `UnknownBackendError` → instance destroyed.
- **R4-3 health gate 12 min < qwen cold-start 15 min**, and `coldStartBudgetSec` is dead code (never read).
- **R4-4 `maxLifetimeMinutes=45`** (`spend-limits.json:15`) leaves ~25 min of serve life after a two-model cold start.
- **R4-5 no `CUDA_VISIBLE_DEVICES` plan** — both models default to GPU0, OOM on multi-GPU.
- **R4-6 single-container all-or-nothing** — one process crash kills both; `exec` + `set -e` onstart can't host two.
- **R4-7 lease/Consul schema can't record two host-port mappings** for the mesh to route both producers.

### Rank 3 (Moderate)
- **R3-1 qwen provision is a floating-tag stub** — `rent.ts:210-218` fabricates `vllm/vllm-openai:latest`, empty args/env, echo-only onstart; never launches vLLM. AWQ support is build-dependent.
- **R3-2 qwen verify is health-only** — no functional generation probe (vLLM /health 200 ≠ can generate).
- **R3-3 HF token only injected for embedding** — vLLM needs it for gated `cyankiwi/...` AWQ weights.
- **R3-4 `exec`+`set -e` onstart template** cannot host two processes; copying it drops one service.

### Rank 2 (Minor)
- **R2-1 disk over-billing** — `rent.ts:226` rents the offer's full `disk_space`, ignoring combo minDiskGb (~50 GiB suffices).
- **R2-2 label `embedding+qwen`** — `+` breaks workload-keyed matching downstream.
- **R2-3 no shared-volume/double-download plan** for two weightsets.

### Rank 1 (YAGNI)
- **R1-1 gpu_name defaults to RTX 3090** — combo needs A6000/A100/5090 search.
- **R1-2 32 GiB single-card = Blackwell (5090)** which TEI 1.9.3 has no sm_120 build for → CPU fallback likely.

## Cross-references
- R5-1 (image) + R4-6 (onstart) + R3-4 (exec/set -e) all resolve together: the dual-service process+image model must be designed as one decision.
- R5-2 (ports) + R4-7 (lease schema) resolve together: port mapping AND its Consul record are one contract.
- R5-3 (selection) + R1-1/R1-2 (gpu_name/Blackwell) resolve together: GPU-class choice drives both selection and TEI-build compatibility.
