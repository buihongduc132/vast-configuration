# AGENTS.md — vast-configuration

> Vast.ai GPU rental lifecycle: search offers → rent → provision → serve → destroy, with a
> cost guard. Consumed by `noco-mesh-infra` as a git submodule at `vendor/vast-configuration`.

## Purpose

`noco-mesh` runs `qwen` (LLM) and an `embedding` producer on a local RTX 3090. That card is
unreliable (recurring Xid 79 "fallen off the bus"). This repo makes a rented Vast.ai GPU a
**switchable second site** for those two workloads.

**"Sometimes" is the whole point.** Local is the default. Vast.ai is an alternative we switch
to deliberately (or on local failure, if that policy is enabled). This is not a migration to
the cloud, and not an always-on dependency.

## Boundary — what belongs here vs noco-mesh-infra

| Concern | Repo |
|---|---|
| Vast.ai API client, offer search/selection, rent/destroy, rental state, cost guard, remote provisioning scripts | **this repo** |
| Nomad jobs, Consul KV schema owned by the mesh, Pulumi state, tier ordering, the embedding contract (`lib/embedding-contract.ts`) | `noco-mesh-infra` |
| Which site is active, and wiring consumers to it | `noco-mesh-infra` (it owns the mesh); this repo only reports what it rented |

Rule of thumb: **this repo talks to Vast.ai. It does not talk to Nomad.** If code here needs
to register a Nomad job, it belongs in `noco-mesh-infra` instead.

## ⚠️ Money is real

Vast.ai bills **per hour while the instance exists** — idle or busy, used or not. There is no
per-token billing and no free tier.

- Cheapest 1×RTX 3090 on-demand ≈ **$0.109/hr** ≈ $2.61/day ≈ $78/mo.
- Account credit is finite. At $0 credit with $0 balance, **rentals stop** — leaving no GPU at
  all if local is also dead.
- An idle rented GPU costs exactly as much as a busy one. **Teardown is not optional.**

Therefore:

1. Every rent path must have a matching destroy path that runs even on failure (`finally`/trap).
2. Live tests must destroy what they rent, and report spend.
3. Never leave an instance up "to try again later" without recording it.

## ⚠️ API footguns (verified live 2026-09-27 — do not rediscover)

Base: `https://console.vast.ai/api/v0/`, auth header `Authorization: Bearer <key>`.

| Footgun | Detail |
|---|---|
| **Trailing slash required** | `GET /bundles?q=…` → **301** and the query is **silently dropped**. `GET /bundles/?q=…` works. A dropped query means "all offers", not an error. |
| **`gpu_name` uses spaces** | `"RTX 3090"` matches; `"RTX_3090"` returns **0 offers with HTTP 200**. A silent-empty result, not an error. |
| **Wrong endpoints 404** | `POST /search/asks/` → 404. `PUT /bundles/` → 404. Offer search is `GET /bundles/?q=<url-encoded JSON>`. |
| **Official PyPI CLI is broken here** | `vastai` 1.8.2 fails at import (`requests`/`urllib3` conflict). Do **not** depend on it — the REST API is the dependable surface. |
| **Silent CPU fallback** | A rented GPU can silently serve on CPU; dimension and health checks cannot detect it; assert the backend device from container logs (`classifyBackendDevice`). |

Query shape for `/bundles/`:

```
q = {"gpu_name":{"eq":"RTX 3090"},"rentable":{"eq":true},"num_gpus":{"eq":1},
     "order":[["dph_total","asc"]],"limit":N,"type":"on-demand"}
```

Useful read-only endpoints: `GET /users/current/` (credit, can_pay), `GET /instances/`
(current rentals).

## Credentials

The API key lives in **Consul KV at `creds/vast/api_key`** — one copy, nowhere else.

```bash
consul kv get creds/vast/api_key
```

- Fallback for non-Consul contexts: env `VAST_API_KEY`.
- **NEVER** commit the key, write it to a tracked file, echo it in logs, or pass it as a
  command-line argument (argv is world-readable via `/proc`).
- `.gitignore` excludes `.env*` — keep it that way.

## The workloads

| Workload | Model | Serves | Local counterpart |
|---|---|---|---|
| **embedding** | `Qwen/Qwen3-Embedding-0.6B`, **1024-dim**, TEI `--pooling mean` | `/embed`, `/health` | Nomad job `qwen3-embed-tei` @ `:8003` |
| **qwen** | `cyankiwi/Qwen3.5-4B-AWQ-4bit`, 256K ctx, vLLM | OpenAI-compatible `/v1`, `/health` | Nomad job `bhd-vllm` @ `:8032` |

**Dimension 1024 is HARD.** The mesh's vector store already holds 1024-dim vectors. A remote
producer emitting any other dimension silently corrupts search results — assert the dimension
before an endpoint is allowed to serve.

**Permanently dead — never serve these, on any site:** `bge-*`, port `:8005`,
`bhd-tei-embed`, `bhd-ollama-cpp-embedding`, the legacy `:8004` PM2 embedding.

## Testing

```bash
npm install
npm test           # default: offline, $0, no network, no rental
npm run typecheck
npm run test:live  # OPT-IN: rents real GPUs, spends real money
```

- Default suite must pass with **no network and no credentials**. Fixtures only.
- Live tests live in `tests/live/` (excluded from the default run) and must be gated on
  `VAST_LIVE=1`. Every live test destroys what it rents in a `finally`, and asserts teardown.
- Never assert on live market prices — offers change minute to minute. Assert on *selection
  logic* against fixtures instead.

## Non-negotiables inherited from noco-mesh-infra governance

- **EMB-001** — embedding model/dimension are contract-owned upstream; this repo may change the
  *site*, never the model or dimension.
- **SEC-001** — nothing binds `0.0.0.0` on the mesh side. A rented box is a third-party
  machine; do not publish mesh services to the open internet to reach it.
- **P14** — a value that must match in several places is defined once and referenced.
- **Declared infra only** — a rental that exists but is not recorded is the exact
  "unmanaged infra is silent infra" failure this org has hit repeatedly. Record before acting.
- **GUARD-001** — the idle/budget killer is a deterministic guard: thresholds, audit log,
  bounded blast radius, cooldown, **no LLM**.

## Layout

```
vast-configuration/
├── src/
│   ├── api/          ← REST client (auth, trailing-slash, retry)
│   ├── offers/       ← search + selection (VRAM gate, price cap, reliability)
│   ├── instances/    ← rent / destroy / list / state reconcile
│   ├── provision/    ← onstart scripts + image definitions per workload
│   └── state/        ← rental state (Consul KV) + drift detection
├── bin/vast.ts       ← CLI entry
├── tests/            ← offline unit tests (fixtures)
│   └── live/         ← opt-in, costs money, VAST_LIVE=1
├── configs/          ← workload definitions (VRAM minimums, images, args)
└── flow/             ← intentions / plans / findings (repo convention)
```

## Plan of record

`noco-mesh-infra/flow/plans/vast-ai-gpu-offload.md` — declarative, 58 items, with gotcha
coverage and cost audit appendices. Intention:
`noco-mesh-infra/flow/intentions/2026-09-27_vast-ai-gpu-offload-qwen-embedding.md`.
