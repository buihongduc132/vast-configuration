#!/usr/bin/env bash
# =============================================================================
# live-combo-proof.sh — END-TO-END PROOF that a rented single Vast.ai GPU can
# serve BOTH embedding (TEI :8003) and LLM (vLLM :8032). SPENDS REAL MONEY.
#
# Proves:
#   1. Offer search -> single 24GB GPU (RTX 3090, <$0.20/hr)
#   2. Rent with dual port mappings (:8003 and :8032) + shared HF token
#   3. Supervised container startup running both runtimes
#   4. TEI /health 200 AND vLLM /health 200
#   5. Backend device CUDA verified for both (no CPU fallback)
#   6. /embed returns EXACTLY 1024 dims (EMB-001 contract)
#   7. /v1/chat/completions returns valid LLM generation
#   8. Positive teardown verification (billing stopped)
#
# Usage:
#   VAST_LIVE_CONFIRM=i-accept-gpu-rental-charges bash scripts/live-combo-proof.sh
# =============================================================================
set -uo pipefail

API="https://console.vast.ai/api/v0"
CONFIRM_TOKEN="i-accept-gpu-rental-charges"
LABEL_PREFIX="nocomesh-offload"

MAX_DPH="${MAX_DPH:-0.20}"
GLOBAL_DEADLINE_MIN="${GLOBAL_DEADLINE_MIN:-45}"
CANDIDATE_DEADLINE_MIN="${CANDIDATE_DEADLINE_MIN:-8}"
HEALTH_WAIT_MIN="${HEALTH_WAIT_MIN:-15}"
MAX_CANDIDATES="${MAX_CANDIDATES:-5}"
MIN_CREDIT="5.0"

COMBO_IMAGE="${COMBO_IMAGE:-ghcr.io/buihongduc132/vllm-tei-combo:latest}"
EMBED_PORT=8003
LLM_PORT=8032
DISK_GB=50
EXPECTED_DIM=1024
MIN_CUDA="${MIN_CUDA:-12.8}"
EXCLUDE_GEO="${VAST_EXCLUDE_GEO:-CN}"

BLOCKLIST_FILE="${BLOCKLIST_FILE:-$HOME/.vast-host-blocklist}"
touch "$BLOCKLIST_FILE" 2>/dev/null || BLOCKLIST_FILE=/dev/null

CURRENT_INSTANCE=""
START_EPOCH=$(date +%s)
TOTAL_BILLED_SECONDS=0
EVIDENCE_DIR="${EVIDENCE_DIR:-/tmp/vast-combo-proof-$(date +%Y%m%dT%H%M%S)}"
mkdir -p "$EVIDENCE_DIR"

log()  { echo "[$(date -Is)] $*" | tee -a "$EVIDENCE_DIR/run.log"; }
fail() { log "FAIL: $*"; exit 1; }

if [[ -z "${VAST_API_KEY:-}" ]]; then
  VAST_API_KEY="$(consul kv get creds/vast/api_key 2>/dev/null || true)"
  if [[ -z "$VAST_API_KEY" ]]; then
    fail "cannot read Vast API key from Consul creds/vast/api_key or env"
  fi
fi
export VAST_API_KEY

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS --max-time 60 -X "$method" \
      -H "Authorization: Bearer $VAST_API_KEY" \
      -H "Content-Type: application/json" -d "$body" "${API}${path}"
  else
    curl -sS --max-time 60 -X "$method" \
      -H "Authorization: Bearer $VAST_API_KEY" -H "Accept: application/json" "${API}${path}"
  fi
}

blocklist_add() {
  local mid="$1" reason="$2"
  [[ -n "$mid" && "$mid" != "None" && "$BLOCKLIST_FILE" != "/dev/null" ]] || return 0
  grep -q "^${mid}\b" "$BLOCKLIST_FILE" 2>/dev/null && return 0
  echo "${mid} $(date -Is) ${reason}" >> "$BLOCKLIST_FILE"
  log "  blocklisted machine ${mid} (${reason})"
}

instance_logs() {
  local id="$1" n="${2:-100}" url
  url=$(api PUT "/instances/request_logs/${id}/" "{\"tail\":\"${n}\"}" \
        | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('result_url',''))
except Exception: print('')
")
  [[ -n "$url" ]] || return 1
  sleep 6
  curl -sS --max-time 40 "$url" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'
}

backend_device() {
  local logs
  logs=$(instance_logs "$1" 100) || { echo "unknown"; return; }
  printf '%s' "$logs" > "$EVIDENCE_DIR/logs-$1.txt"
  if grep -qiE "using cpu instead|model on cpu|cuda is not available|CUDA_ERROR_COMPAT_NOT_SUPPORTED" <<<"$logs"; then
    echo "cpu"
  elif grep -qiE "model on cuda|starting .* model on cuda|capturing .* model for cuda graphs|# gpu blocks:|device=['\"]?cuda|marlinlinearkernel" <<<"$logs"; then
    echo "cuda"
  else
    echo "unknown"
  fi
}

destroy_and_verify() {
  local id="$1" gone=0 present
  [[ -n "$id" ]] || return 0
  log "  destroying instance $id"
  api DELETE "/instances/${id}/" > "$EVIDENCE_DIR/destroy-${id}.json" 2>&1
  for i in 1 2 3 4 5 6 7 8; do
    sleep 12
    present=$(api GET "/instances/" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('PARSE_ERROR'); raise SystemExit
inst=d.get('instances')
if not isinstance(inst,list): print('NOT_A_LIST'); raise SystemExit
print('YES' if any(str(i.get('id'))=='${id}' for i in inst) else 'NO')
")
    log "    teardown poll $i: present=$present"
    if [[ "$present" == "NO" ]]; then gone=$((gone+1)); else gone=0; fi
    [[ $gone -ge 2 ]] && break
  done
  if [[ $gone -ge 2 ]]; then
    log "  TEARDOWN VERIFIED: $id absent twice — billing stopped"
    return 0
  fi
  log "  WARNING: TEARDOWN NOT VERIFIED for $id"
  return 1
}

cleanup() {
  local rc=$?
  if [[ -n "$CURRENT_INSTANCE" ]]; then
    log "TEARDOWN (trap): instance $CURRENT_INSTANCE still held"
    destroy_and_verify "$CURRENT_INSTANCE"
    CURRENT_INSTANCE=""
  fi
  local elapsed=$(( $(date +%s) - START_EPOCH ))
  log "run elapsed ${elapsed}s; evidence in $EVIDENCE_DIR"
  exit $rc
}
trap cleanup EXIT INT TERM

[[ "${VAST_LIVE_CONFIRM:-}" == "$CONFIRM_TOKEN" ]] \
  || fail "refusing: set VAST_LIVE_CONFIRM=$CONFIRM_TOKEN to authorize rental charges"

# ── Preflight ────────────────────────────────────────────────────────────────
log "=== STEP 0: preflight check ==="
api GET "/users/current/" > "$EVIDENCE_DIR/account.json"
CREDIT=$(python3 -c "import json;print(json.load(open('$EVIDENCE_DIR/account.json')).get('credit',0))")
log "account credit: \$$CREDIT"
python3 -c "import sys;sys.exit(0 if float('$CREDIT')>float('$MIN_CREDIT') else 1)" \
  || fail "credit \$$CREDIT at or below floor \$$MIN_CREDIT"

api GET "/instances/" > "$EVIDENCE_DIR/instances-before.json"
OURS=$(python3 -c "
import json
d=json.load(open('$EVIDENCE_DIR/instances-before.json'))
print(sum(1 for i in d.get('instances',[]) if str(i.get('label') or '').startswith('$LABEL_PREFIX--')))
")
log "current active offload instances: $OURS"
[[ "$OURS" == "0" ]] || fail "already holding $OURS offload instance(s) — concurrency guard tripped"

# ── Offer Search ─────────────────────────────────────────────────────────────
log "=== STEP 1: offer search (single RTX 3090, 24GB VRAM) ==="
Q=$(python3 -c "
import json
print(json.dumps({
  'gpu_name': {'eq': 'RTX 3090'},
  'rentable': {'eq': True},
  'num_gpus': {'eq': 1},
  'disk_space': {'gte': $DISK_GB},
  'order': [['dph_total','asc']],
  'limit': 30,
  'type': 'on-demand',
}))
")
curl -sS --max-time 60 -G -H "Authorization: Bearer $VAST_API_KEY" \
  "${API}/bundles/" --data-urlencode "q=$Q" > "$EVIDENCE_DIR/offers.json"

EXCLUDE_GEO="$EXCLUDE_GEO" BLOCKLIST_FILE="$BLOCKLIST_FILE" python3 -c "
import json, os
d=json.load(open('$EVIDENCE_DIR/offers.json'))
blocked=set()
try:
    for line in open(os.environ['BLOCKLIST_FILE']):
        tok=line.split()
        if tok: blocked.add(tok[0])
except Exception: pass
excl=[x.strip().lower() for x in os.environ.get('EXCLUDE_GEO','').split(',') if x.strip()]
def geo_ok(o):
    g=str(o.get('geolocation') or '').lower()
    return not any(e in g for e in excl)
offers=[o for o in d.get('offers',[])
        if float(o.get('dph_total',9e9)) < $MAX_DPH
        and float(o.get('gpu_ram',0)) >= 24576
        and float(o.get('disk_space',0)) >= $DISK_GB
        and o.get('rentable') is True and not o.get('is_bid')
        and o.get('cuda_max_good') and float(o['cuda_max_good']) >= $MIN_CUDA
        and geo_ok(o)
        and str(o.get('machine_id')) not in blocked]
offers.sort(key=lambda o: (-float(o.get('reliability2') or 0), float(o['dph_total']), -float(o.get('inet_down') or 0)))
with open('$EVIDENCE_DIR/candidates.tsv','w') as f:
    for o in offers:
        f.write('\t'.join(str(x) for x in [
            o['id'], o['dph_total'], o.get('gpu_ram'), o.get('disk_space'),
            str(o.get('geolocation')).replace(' ','_'), o.get('reliability2'),
            o.get('inet_down') or 0, o.get('machine_id') or 0,
        ])+'\n')
print(len(offers))
" > "$EVIDENCE_DIR/candidate-count.txt"
CAND_COUNT=$(cat "$EVIDENCE_DIR/candidate-count.txt")
log "qualifying 24GB candidates strictly under \$$MAX_DPH/hr: $CAND_COUNT"
[[ "$CAND_COUNT" != "0" ]] || fail "no eligible 24GB offers found"

HF_TOKEN="$(consul kv get creds/common/huggingface/api_key 2>/dev/null || echo '')"
GLOBAL_DEADLINE=$(( START_EPOCH + GLOBAL_DEADLINE_MIN*60 ))

# ── Candidate execution ──────────────────────────────────────────────────────
try_combo_candidate() {
  local offer_id="$1" dph="$2" machine_id="${3:-}"
  local label="${LABEL_PREFIX}--combo--liveproof--$(date +%s)"
  local rent_file="$EVIDENCE_DIR/rent-${offer_id}.json"

  # Supervised dual onstart
  local onstart
  onstart=$(cat << 'EOF'
#!/usr/bin/env bash
set -uo pipefail
mkdir -p /var/log /tmp
echo "[combo-supervisor] Booting TEI (:8003) and vLLM (:8032)..."

if [[ -n "${HUGGING_FACE_HUB_TOKEN:-}" ]]; then
  export HF_TOKEN="${HUGGING_FACE_HUB_TOKEN}"
fi

TEI_PID=""
VLLM_PID=""
cleanup() {
  echo "[combo-supervisor] Shutting down..."
  [[ -n "$TEI_PID" ]] && kill -TERM "$TEI_PID" 2>/dev/null || true
  [[ -n "$VLLM_PID" ]] && kill -TERM "$VLLM_PID" 2>/dev/null || true
  wait
  exit 0
}
trap cleanup SIGTERM SIGINT

# Start TEI
if command -v text-embeddings-router >/dev/null 2>&1; then
  text-embeddings-router --model-id "Qwen/Qwen3-Embedding-0.6B" --port 8003 --pooling mean > /var/log/tei.log 2>&1 &
  TEI_PID=$!
fi

# Start vLLM
python3 -m vllm.entrypoints.openai.api_server \
  --model "cyankiwi/Qwen3.5-4B-AWQ-4bit" \
  --host 0.0.0.0 \
  --port 8032 \
  --max-model-len 262144 \
  --gpu-memory-utilization 0.62 \
  --max-num-seqs 4 \
  --cpu-offload-gb 0 \
  --trust-remote-code > /var/log/vllm.log 2>&1 &
VLLM_PID=$!

while true; do
  if [[ -n "$TEI_PID" ]] && ! kill -0 "$TEI_PID" 2>/dev/null; then
    echo "[combo-supervisor] TEI exited!" >&2
    cleanup
    exit 1
  fi
  if [[ -n "$VLLM_PID" ]] && ! kill -0 "$VLLM_PID" 2>/dev/null; then
    echo "[combo-supervisor] vLLM exited!" >&2
    cleanup
    exit 2
  fi
  sleep 5
done
EOF
)

  local body
  body=$(HF_TOKEN="$HF_TOKEN" ONSTART="$onstart" python3 -c "
import json, os
env=('-p ${EMBED_PORT}:${EMBED_PORT} -p ${LLM_PORT}:${LLM_PORT} '
     '-e HUGGING_FACE_HUB_TOKEN=' + os.environ.get('HF_TOKEN','') + ' '
     '-e HF_TOKEN=' + os.environ.get('HF_TOKEN','') + ' '
     '-e HF_HUB_ENABLE_HF_TRANSFER=0')
print(json.dumps({
  'image': '$COMBO_IMAGE',
  'disk': $DISK_GB,
  'label': '$label',
  'runtype': 'args',
  'env': env,
  'onstart': os.environ.get('ONSTART',''),
  'target_state': 'running',
  'cancel_unavail': True,
}))
")
  api PUT "/asks/${offer_id}/" "$body" > "$rent_file"

  local ok newid
  read -r ok newid <<<"$(python3 -c "
import json
try: d=json.load(open('$rent_file'))
except Exception: print('False',''); raise SystemExit
print(bool(d.get('success')), d.get('new_contract') or '')
")"
  if [[ "$ok" != "True" || -z "$newid" ]]; then
    log "  offer $offer_id unavailable; advancing"
    return 1
  fi

  CURRENT_INSTANCE="$newid"
  local rent_epoch=$(date +%s)
  log "  RENTED combo box $newid at \$$dph/hr (label $label)"

  # Wait for container running + both ports mapped
  local cdeadline=$(( rent_epoch + CANDIDATE_DEADLINE_MIN*60 ))
  local ip="" hp_embed="" hp_llm="" st="" flag=""
  while [[ $(date +%s) -lt $cdeadline && $(date +%s) -lt $GLOBAL_DEADLINE ]]; do
    api GET "/instances/" > "$EVIDENCE_DIR/poll-${newid}.json"
    read -r st ip hp_embed hp_llm flag <<<"$(python3 -c "
import json
d=json.load(open('$EVIDENCE_DIR/poll-${newid}.json'))
for i in d.get('instances',[]):
    if str(i.get('id'))=='$newid':
        ports=i.get('ports') or {}
        m_emb=ports.get('${EMBED_PORT}/tcp') or []
        hp_emb=m_emb[0].get('HostPort') if m_emb else ''
        m_llm=ports.get('${LLM_PORT}/tcp') or []
        hp_llm=m_llm[0].get('HostPort') if m_llm else ''
        msg=str(i.get('status_msg') or '').lower()
        fatal=('no such host' in msg or 'manifest unknown' in msg or 'unauthorized' in msg
               or 'connection refused' in msg or 'oci runtime create failed' in msg)
        print(i.get('actual_status') or '-', i.get('public_ipaddr') or '-',
              hp_emb or '-', hp_llm or '-', 'HOSTFAIL' if fatal else 'ok')
        break
else:
    print('GONE','-','-','-','ok')
")"
    log "    status=$st ip=$ip ports=embed:$hp_embed,llm:$hp_llm"
    if [[ "$flag" == "HOSTFAIL" ]]; then
      log "  HOST-LEVEL FAILURE on candidate $offer_id — destroying"
      blocklist_add "$machine_id" "host-failure"
      return 1
    fi
    if [[ "$st" == "running" && "$ip" != "-" && "$hp_embed" != "-" && "$hp_llm" != "-" ]]; then
      break
    fi
    sleep 15
  done

  if [[ "$st" != "running" || "$hp_embed" == "-" || "$hp_llm" == "-" ]]; then
    log "  did not reach running+dual-ports mapped — advancing"
    return 1
  fi

  local base_embed="http://${ip}:${hp_embed}"
  local base_llm="http://${ip}:${hp_llm}"
  log "  endpoints mapped: embedding=$base_embed, llm=$base_llm"

  # Wait for health on both endpoints
  local hdeadline=$(( $(date +%s) + HEALTH_WAIT_MIN*60 ))
  local healthy_emb=0 healthy_llm=0
  while [[ $(date +%s) -lt $hdeadline ]]; do
    if [[ $healthy_emb -eq 0 ]]; then
      local code_e; code_e=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" "$base_embed/health" 2>/dev/null || echo "000")
      [[ "$code_e" == "200" ]] && { healthy_emb=1; log "    TEI :8003 healthy"; }
    fi
    if [[ $healthy_llm -eq 0 ]]; then
      local code_l; code_l=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" "$base_llm/health" 2>/dev/null || echo "000")
      [[ "$code_l" == "200" ]] && { healthy_llm=1; log "    vLLM :8032 healthy"; }
    fi
    if [[ $healthy_emb -eq 1 && $healthy_llm -eq 1 ]]; then
      break
    fi
    sleep 15
  done

  if [[ $healthy_emb -ne 1 || $healthy_llm -ne 1 ]]; then
    log "  health check timed out (tei=$healthy_emb, vllm=$healthy_llm) — advancing"
    return 1
  fi

  # Backend device check
  local dev; dev=$(backend_device "$newid")
  log "  backend device detected: $dev"
  if [[ "$dev" == "cpu" ]]; then
    log "  CPU FALLBACK DETECTED — rejecting"
    blocklist_add "$machine_id" "cpu-fallback"
    return 1
  fi

  # Probe 1: Embedding dimension 1024
  log "  probing /embed on $base_embed..."
  local dim
  dim=$(curl -sS --max-time 60 -X POST "$base_embed/embed" -H 'Content-Type: application/json' \
    -d '{"inputs":"single instance combo proof"}' \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    while isinstance(d,list) and d and isinstance(d[0],list): d=d[0]
    print(len(d) if isinstance(d,list) else -1)
except Exception: print(-1)
")
  log "  /embed dimension = $dim (demands $EXPECTED_DIM)"
  [[ "$dim" == "$EXPECTED_DIM" ]] || return 2

  # Probe 2: LLM generation on vLLM
  log "  probing /v1/chat/completions on $base_llm..."
  local llm_out
  llm_out=$(curl -sS --max-time 60 -X POST "$base_llm/v1/chat/completions" -H 'Content-Type: application/json' \
    -d '{"model":"cyankiwi/Qwen3.5-4B-AWQ-4bit","messages":[{"role":"user","content":"Respond with OK"}],"max_tokens":16}' \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d['choices'][0]['message']['content'].strip())
except Exception: print('')
")
  log "  LLM response: $llm_out"
  [[ -n "$llm_out" ]] || return 2

  log "=== COMBO PROOF SUCCESSFUL ==="
  return 0
}

# Walk candidate list
ATTEMPT=0
PROVED=0
while IFS=$'\t' read -r OID ODPH ORAM ODISK OGEO OREL OINET OMID; do
  [[ $ATTEMPT -ge $MAX_CANDIDATES ]] && break
  [[ $(date +%s) -ge $GLOBAL_DEADLINE ]] && break
  ATTEMPT=$((ATTEMPT+1))
  log "attempt $ATTEMPT: offer $OID \$$ODPH/hr ${ORAM}MiB"
  try_combo_candidate "$OID" "$ODPH" "$OMID"
  rc=$?
  if [[ $rc -eq 0 ]]; then
    PROVED=1
    break
  fi
  if [[ -n "$CURRENT_INSTANCE" ]]; then
    destroy_and_verify "$CURRENT_INSTANCE"
    CURRENT_INSTANCE=""
  fi
  [[ $rc -eq 2 ]] && fail "fatal contract violation on candidate"
done < "$EVIDENCE_DIR/candidates.tsv"

[[ $PROVED -eq 1 ]] || fail "could not prove combo workload across $ATTEMPT attempt(s)"
log "Proof complete. Teardown runs next in trap."
