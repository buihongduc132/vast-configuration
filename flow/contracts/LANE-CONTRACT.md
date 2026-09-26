# LANE-CONTRACT.md — binding rules for every delegated lane

Read fully before writing code. Every rule here was learned from a real failure in this
repo, most of them costing either money or a false "done". Violating one fails review even
if your feature works.

## Acceptance criterion (this is what the verifier checks)

A lane passes only when ALL of these hold:

1. `npx vitest run` → all pass, **offline** (the suite is network-blocked by
   `src/testing/no-network.ts`; do not weaken or bypass it).
2. `npx tsc --noEmit` → exit 0.
3. `opa test policies/rego policies/data` → all pass (if you touched policy).
4. Every new test **can actually fail**. Prove it: break the production code, capture the
   red output to a file, restore, capture green. Cite both files.
5. No secret in any tracked file, any log, or any command line.
6. Your work is committed with real evidence quoted in the message.

## Hard prohibitions

- **Never put a credential on a command line.** argv is world-readable via `/proc` and is
  recorded in agent transcripts. The Vast key is read as `VAST_API_KEY="$(consul kv get
  creds/vast/api_key)"` and used only as an env var. Never echo it, never `grep` for it,
  never interpolate it into a URL.
- **Never spend money without both gates.** Renting requires `VAST_LIVE=1` AND
  `VAST_LIVE_CONFIRM=i-accept-gpu-rental-charges`. The offline suite must stay $0.
- **Never destroy an instance whose label lacks `nocomesh-offload--`.** A human's own
  rental is not ours to kill. Counting it toward a cap is fine; destroying it is not.
- **Never change the embedding model, dimension, or pooling.** `Qwen/Qwen3-Embedding-0.6B`,
  **1024** dims, **mean** pooling. The vector store already holds 1024-dim vectors made
  with mean pooling; any deviation silently corrupts search. This repo may change the
  *site*, never the contract.
- **Never resurrect a dead producer**: `bge-*`, port `:8005`, `bhd-tei-embed`,
  `bhd-ollama-cpp-embedding`, the legacy `:8004` PM2 embedding. Dead on every site.
- **No new `.hcl`.** TypeScript `jsonJobspec` only (noco-mesh-infra P10).
- **Do not weaken a test to make it pass.** If a test is wrong, say so in the commit and
  explain why; don't quietly delete the assertion.

## Established facts — do NOT re-derive these, and do not "fix" them

Measured live 2026-09-27. Treat as given:

| Fact | Consequence for you |
|---|---|
| `GET /bundles?q=…` without a trailing slash → **301, query silently dropped** | always use `/bundles/`; `src/api/url.ts` handles it |
| `gpu_name: "RTX_3090"` → **0 offers at HTTP 200**; `"RTX 3090"` works | underscores silently match nothing |
| Invalid API key → **HTTP 404** with `{"error":"auth_error"}`; missing header → 403 | classify auth on the **body**, never on status |
| TEI 1.9.3 declares `cuda>=12.9`; arch builds are only `turing`(sm_75), plain(**sm_80**), `86`, `89`, `hopper`(sm_90), `cpu` | **no Blackwell/sm_120 build exists** |
| Two boxes at `cuda_max_good` **12.2** and **12.8** silently served on **CPU** | the floor is **`cuda_max_good >= 12.9`, derived from the image** |
| Cubins are forward-compatible only within a **major** version | plain sm_80 image runs on sm_86, but **not** on sm_120 |
| `/health` 200 + `/embed` 1024 dims + correct `/info` **all pass while running on CPU** | **a dimension check is not a GPU check**; assert the backend device |
| Quoted offer price ≠ billed price (observed **+9%**) | read `dph_total` from the **instance**, not the offer |
| An offer can vanish between search and rent (`no_such_ask`) | "offer gone" is a normal path, not an error |
| Hosts fail host-level: `ghcr.io` unresolvable, `OCI runtime create failed` | destroy-and-advance across a ranked candidate list |
| `Pull complete` / `Extracting` / `Verifying Checksum` are **normal** | must not trip a fatal-status classifier |
| Image pull alone took **206s** on a good box | fail-fast and cold-start need **separate** deadlines |
| `opa eval` exits **0 with an empty result** when a document is absent | silence is never approval; fail closed |
| `not is_number(<bare ref>)` does **not** fire on an ABSENT key in Rego | use `object.get(x, [...], null)`, or a `default x := false` helper |
| mise **appends** task args instead of binding `$1`/`$2` | put logic in a committed script, not inline in `mise.toml` |
| This shell is **zsh**: unquoted `$var` does not word-split; unquoted globs abort the command | quote globs, use arrays |
| SSH to a Vast box: key must be attached via `POST /instances/<id>/ssh/`; the advertised `ssh_host:ssh_port` fails, the direct `public_ipaddr:<mapped 22>` works; `IdentitiesOnly=yes` needed | don't rediscover this |

## Repo conventions

- Single source of truth (P14): a value needed in two places is defined **once**.
  Spend ceilings live only in `policies/data/spend-limits.json`.
- Fail closed: if you cannot obtain a verdict, deny. "Could not check" is never "allowed".
- A gate the caller must remember to enable is decoration. Wire it in by default.
- The deploy graph must **own artifact production**, not just consumption. A script
  referenced by a task must be **tracked in git** (`git ls-files`, not `test -f` — the
  latter passes on untracked files). This repo has been burned by exit-127 crashloops.
- Comments explain **why**, especially where the obvious approach is wrong.

## Do not run these (they wedge a backgrounded agent)

`git log -S`, `git log --all`, blame sweeps, full builds, migrations, `pulumi up`, anything
that rents a GPU. If you think you need one, stop and say so in your final message instead.

## Commit

Quote real captured output in the message. Typed-from-memory "evidence" has been wrong
before. If a pre-commit hook rejects plain `git commit`, report that rather than bypassing it.
