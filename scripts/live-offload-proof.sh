#!/usr/bin/env bash
# =============================================================================
# live-offload-proof.sh — END-TO-END PROOF that a rented Vast.ai GPU can serve
# our embedding contract. SPENDS REAL MONEY.
#
# Proves: offer search -> rent -> container starts -> TEI /health 200 ->
#         /embed returns EXACTLY 1024 dims -> model identity matches ->
#         destroy verified by absence (billing stopped).
#
# DESIGN NOTE (learned the hard way, 2026-09-27): individual Vast.ai hosts fail
# for host-level reasons that no amount of pre-filtering predicts. Two observed
# in consecutive attempts:
#   - Fujian CN box: `lookup ghcr.io: no such host` (registry unreachable)
#   - Pennsylvania US box: `OCI runtime create failed: could not apply required
#     modification to OCI specification` (broken nvidia container toolkit)
# Renting ONE box and giving up is therefore wrong. This script walks a ranked
# candidate list: on a host-level failure it DESTROYS that instance and advances
# to the next candidate, under a global deadline and a hard price cap.
#
# SAFETY
#   - EXIT/INT/TERM trap destroys whatever is currently rented
#   - every instance carries a greppable label so a reaper finds it after SIGKILL
#   - per-candidate deadline (fail fast) + global deadline (bounded total spend)
#   - refuses to start if we already hold a labelled instance
#   - never touches an instance whose label is not ours
#
# Usage:
#   VAST_LIVE_CONFIRM=i-accept-gpu-rental-charges bash scripts/live-offload-proof.sh
# =============================================================================
set -uo pipefail

API="https://console.vast.ai/api/v0"
CONFIRM_TOKEN="i-accept-gpu-rental-charges"
LABEL_PREFIX="nocomesh-offload"

MAX_DPH="${MAX_DPH:-0.45}"
GLOBAL_DEADLINE_MIN="${GLOBAL_DEADLINE_MIN:-40}"
CANDIDATE_DEADLINE_MIN="${CANDIDATE_DEADLINE_MIN:-7}"   # pre-container: catch broken hosts fast
HEALTH_WAIT_MIN="${HEALTH_WAIT_MIN:-12}"                # post-container: weights download + warmup
MAX_CANDIDATES="${MAX_CANDIDATES:-8}"
MIN_CREDIT="5.0"

TEI_IMAGE="ghcr.io/huggingface/text-embeddings-inference:1.9.3"
MODEL="Qwen/Qwen3-Embedding-0.6B"
EXPECTED_DIM=1024
PORT=8003
DISK_GB=40
# MIN_CUDA: proven necessary 2026-09-27. A box advertising cuda_max_good 12.2
# (driver 535.113.01) accepted the rental, pulled the image, started TEI — and
# TEI then logged:
#   WARN Could not find a compatible CUDA device on host: CUDA is not available
#   Caused by: DriverError(CUDA_ERROR_COMPAT_NOT_SUPPORTED_ON_DEVICE,
#              "forward compatibility was attempted on non supported HW")
#   WARN Using CPU instead ... Starting Qwen3 model on Cpu
# i.e. it SILENTLY DEGRADED TO CPU on a GPU we were paying for. 29 of 40
# candidates in that same search reported >= 13.0, so this costs almost nothing
# in selection breadth.
MIN_CUDA="${MIN_CUDA:-13.0}"   # 12.2 AND 12.8 both fell back to CPU; 13.2 worked
# Hosts behind national firewalls commonly cannot resolve ghcr.io (proven live).
EXCLUDE_GEO="${VAST_EXCLUDE_GEO:-CN}"
# OT13: hosts that failed for a host-level reason, persisted ACROSS runs. Without
# this, the same broken machine gets re-rented (host 173.163.142.110 / machine
# 14338 failed with `OCI runtime create failed` in two separate runs).
BLOCKLIST_FILE="${BLOCKLIST_FILE:-$HOME/.vast-host-blocklist}"
touch "$BLOCKLIST_FILE" 2>/dev/null || BLOCKLIST_FILE=/dev/null

CURRENT_INSTANCE=""          # destroyed by the trap if set
START_EPOCH=$(date +%s)
TOTAL_BILLED_SECONDS=0
EVIDENCE_DIR="${EVIDENCE_DIR:-/tmp/vast-proof-$(date +%Y%m%dT%H%M%S)}"
mkdir -p "$EVIDENCE_DIR"

log()  { echo "[$(date -Is)] $*" | tee -a "$EVIDENCE_DIR/run.log"; }
fail() { log "FAIL: $*"; exit 1; }

if [[ -z "${VAST_API_KEY:-}" ]]; then
  VAST_API_KEY="$(consul kv get creds/vast/api_key)" || fail "cannot read key from Consul"
fi
export VAST_API_KEY

api() { # api <METHOD> <path> [json-body]
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

# Record a host as known-bad so later runs skip it (machine_id + reason + when).
blocklist_add() { # blocklist_add <machine_id> <reason>
  local mid="$1" reason="$2"
  [[ -n "$mid" && "$mid" != "None" && "$BLOCKLIST_FILE" != "/dev/null" ]] || return 0
  grep -q "^${mid}\b" "$BLOCKLIST_FILE" 2>/dev/null && return 0
  echo "${mid} $(date -Is) ${reason}" >> "$BLOCKLIST_FILE"
  log "  blocklisted machine ${mid} (${reason})"
}

# Fetch the container's own logs. This is the ONLY place a silent CPU fallback is
# visible: /health, /embed dimension and /info model_id all look perfectly
# correct while the model runs on CPU. Returns the log text on stdout.
instance_logs() { # instance_logs <id> <tail-lines>
  local id="$1" n="${2:-40}" url
  url=$(api PUT "/instances/request_logs/${id}/" "{\"tail\":\"${n}\"}" \
        | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('result_url',''))
except Exception: print('')
")
  [[ -n "$url" ]] || return 1
  # The log is uploaded to S3 a moment after the request.
  sleep 6
  curl -sS --max-time 40 "$url" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'
}

# Classify the backend device from the logs. Echoes cuda | cpu | unknown.
backend_device() { # backend_device <id>
  local logs
  logs=$(instance_logs "$1" 60) || { echo "unknown"; return; }
  printf '%s' "$logs" > "$EVIDENCE_DIR/tei-logs-$1.txt"
  if grep -qiE "using cpu instead|model on cpu|cuda is not available|CUDA_ERROR_COMPAT_NOT_SUPPORTED" <<<"$logs"; then
    echo "cpu"
  elif grep -qiE "model on cuda|starting .* model on cuda" <<<"$logs"; then
    echo "cuda"
  else
    echo "unknown"
  fi
}

# Positive teardown verification: absent in 2 consecutive polls. Never treats a
# non-list or unparseable body as "clean" — that is how a leak hides.
destroy_and_verify() {
  local id="$1" gone=0 present
  [[ -n "$id" ]] || return 0
  log "  destroying instance $id"
  api DELETE "/instances/${id}/" > "$EVIDENCE_DIR/destroy-${id}.json" 2>&1
  head -c 200 "$EVIDENCE_DIR/destroy-${id}.json" | tee -a "$EVIDENCE_DIR/run.log" >/dev/null
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
  log "  ⚠️  TEARDOWN NOT VERIFIED for $id — MAY STILL BE BILLING, CHECK MANUALLY"
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
  log "run elapsed ${elapsed}s; billed instance-seconds ~${TOTAL_BILLED_SECONDS}s; evidence $EVIDENCE_DIR"
  exit $rc
}
trap cleanup EXIT INT TERM

[[ "${VAST_LIVE_CONFIRM:-}" == "$CONFIRM_TOKEN" ]] \
  || fail "refusing: set VAST_LIVE_CONFIRM=$CONFIRM_TOKEN (this RENTS a GPU and BILLS)"

# ---------------------------------------------------------------- preflight ---
log "=== STEP 0: credit + concurrency preflight ==="
api GET "/users/current/" > "$EVIDENCE_DIR/account.json"
CREDIT=$(python3 -c "import json;print(json.load(open('$EVIDENCE_DIR/account.json')).get('credit',0))")
log "credit \$$CREDIT"
python3 -c "import sys;sys.exit(0 if float('$CREDIT')>float('$MIN_CREDIT') else 1)" \
  || fail "credit \$$CREDIT at or below floor \$$MIN_CREDIT"

api GET "/instances/" > "$EVIDENCE_DIR/instances-before.json"
OURS=$(python3 -c "
import json
d=json.load(open('$EVIDENCE_DIR/instances-before.json'))
print(sum(1 for i in d.get('instances',[]) if str(i.get('label') or '').startswith('$LABEL_PREFIX--')))
")
FOREIGN=$(python3 -c "
import json
d=json.load(open('$EVIDENCE_DIR/instances-before.json'))
print(sum(1 for i in d.get('instances',[]) if not str(i.get('label') or '').startswith('$LABEL_PREFIX--')))
")
log "instances: ours=$OURS foreign=$FOREIGN (foreign are NEVER touched)"
[[ "$OURS" == "0" ]] || fail "already holding $OURS of our instances — refusing (concurrency cap)"

# ------------------------------------------------------------ offer search ---
log "=== STEP 1: offer search (gpu_name uses SPACES; excluding geo: $EXCLUDE_GEO) ==="
Q=$(python3 -c "
import json
print(json.dumps({
  'gpu_name': {'eq': 'RTX 3090'},
  'rentable': {'eq': True},
  'num_gpus': {'eq': 1},
  'disk_space': {'gte': $DISK_GB},
  'order': [['dph_total','asc']],
  'limit': 40,
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
except Exception:
    pass
excl=[x.strip().lower() for x in os.environ.get('EXCLUDE_GEO','').split(',') if x.strip()]
def geo_ok(o):
    g=str(o.get('geolocation') or '').lower()
    return not any(e in g for e in excl)
offers=[o for o in d.get('offers',[])
        if float(o.get('dph_total',9e9)) <= $MAX_DPH
        and float(o.get('gpu_ram',0)) >= 8192
        and float(o.get('disk_space',0)) >= $DISK_GB
        and o.get('rentable') is True and not o.get('is_bid')
        and o.get('cuda_max_good') and float(o['cuda_max_good']) >= $MIN_CUDA
        and geo_ok(o)
        and str(o.get('machine_id')) not in blocked]
# reliability, then price, then download bandwidth (a slow box bills while it pulls)
offers.sort(key=lambda o: (-float(o.get('reliability2') or 0), float(o['dph_total']),
                           -float(o.get('inet_down') or 0)))
with open('$EVIDENCE_DIR/candidates.tsv','w') as f:
    for o in offers:
        f.write('\t'.join(str(x) for x in [
            o['id'], o['dph_total'], o.get('gpu_ram'), o.get('disk_space'),
            str(o.get('geolocation')).replace(' ','_'), o.get('reliability2'),
            o.get('inet_down') or 0, o.get('machine_id') or 0,
        ])+'\n')
import sys
print(len(offers), file=sys.stderr) if False else None
print(len(offers))
" > "$EVIDENCE_DIR/candidate-count.txt"
CAND_COUNT=$(cat "$EVIDENCE_DIR/candidate-count.txt")
log "eligible candidates: $CAND_COUNT"
[[ "$CAND_COUNT" != "0" ]] || fail "no eligible offers (explicit error, never a silent no-op)"

HF_TOKEN="$(consul kv get creds/common/huggingface/api_key 2>/dev/null || echo '')"
GLOBAL_DEADLINE=$(( START_EPOCH + GLOBAL_DEADLINE_MIN*60 ))

# Result globals set by try_candidate on success
PROOF_BASE=""; PROOF_DIM=""; PROOF_MODEL=""; PROOF_DPH=""; PROOF_INSTANCE=""; PROOF_QUOTED=""
PROOF_COLD_START=""; PROOF_DEVICE=""

# try_candidate <offer_id> <dph>
#   0 = proved  1 = host-level failure (advance)  2 = fatal (stop everything)
try_candidate() {
  local offer_id="$1" dph="$2" machine_id="${3:-}"
  local label="${LABEL_PREFIX}--embedding--liveproof--$(date +%s)"
  local rent_file="$EVIDENCE_DIR/rent-${offer_id}.json"

  local body
  body=$(HF_TOKEN="$HF_TOKEN" python3 -c "
import json, os
env=('-p ${PORT}:${PORT} '
     '-e HUGGING_FACE_HUB_TOKEN=' + os.environ.get('HF_TOKEN','') + ' '
     '-e HF_HUB_ENABLE_HF_TRANSFER=0')
print(json.dumps({
  'image': '$TEI_IMAGE',
  'disk': $DISK_GB,
  'label': '$label',
  'runtype': 'args',
  'env': env,
  'args': ['--model-id','$MODEL','--port','$PORT','--pooling','mean','--max-client-batch-size','32'],
  'target_state': 'running',
  'cancel_unavail': True,
}))
")
  api PUT "/asks/${offer_id}/" "$body" > "$rent_file"

  local ok newid err
  read -r ok newid err <<<"$(python3 -c "
import json
try: d=json.load(open('$rent_file'))
except Exception: print('False','','unparseable'); raise SystemExit
print(bool(d.get('success')), d.get('new_contract') or '', (d.get('error') or 'none'))
")"
  if [[ "$ok" != "True" || -z "$newid" ]]; then
    log "  rent refused (error=$err) — offer gone or unavailable; advancing"
    return 1
  fi

  CURRENT_INSTANCE="$newid"
  local rent_epoch=$(date +%s)
  log "  RENTED $newid at \$${dph}/hr (label $label)"

  # -- wait for container up + port mapped ------------------------------------
  local cdeadline=$(( rent_epoch + CANDIDATE_DEADLINE_MIN*60 ))
  local ip="" hp="" st="" flag=""
  while [[ $(date +%s) -lt $cdeadline && $(date +%s) -lt $GLOBAL_DEADLINE ]]; do
    api GET "/instances/" > "$EVIDENCE_DIR/poll-${newid}.json"
    read -r st ip hp flag <<<"$(python3 -c "
import json
d=json.load(open('$EVIDENCE_DIR/poll-${newid}.json'))
for i in d.get('instances',[]):
    if str(i.get('id'))=='$newid':
        ports=i.get('ports') or {}
        m=ports.get('${PORT}/tcp') or []
        hp=m[0].get('HostPort') if m else ''
        msg=str(i.get('status_msg') or '')
        low=msg.lower()
        # 'Pull complete'/'Extracting'/'Downloading' are NORMAL progress.
        fatal=('no such host' in low or 'manifest unknown' in low
               or 'unauthorized' in low or 'connection refused' in low
               or 'oci runtime create failed' in low
               or 'failed to create task' in low
               or ('error response from daemon' in low and 'complete' not in low))
        # Emit '-' placeholders: bash read collapses empty fields and would
        # shift the flag into the wrong variable (this bug cost a real rental).
        print(i.get('actual_status') or '-', i.get('public_ipaddr') or '-',
              hp or '-', 'HOSTFAIL' if fatal else 'ok')
        open('$EVIDENCE_DIR/msg-${newid}.txt','w').write(msg)
        break
else:
    print('GONE','-','-','ok')
")"
    local m; m=$(head -c 160 "$EVIDENCE_DIR/msg-${newid}.txt" 2>/dev/null | tr '\n' ' ')
    log "    status=$st ip=$ip port=$hp ${m:+| $m}"

    if [[ "$flag" == "HOSTFAIL" ]]; then
      log "  HOST-LEVEL FAILURE on this box (see msg above) — destroying, advancing"
      blocklist_add "$machine_id" "host-fail:$(head -c 60 "$EVIDENCE_DIR/msg-${newid}.txt" | tr -d '\n' | tr ' ' '_')"
      return 1
    fi
    if [[ "$st" == "GONE" ]]; then
      # ⚠️ TRANSIENT ABSENCE IS NOT DELETION. An earlier version cleared
      # CURRENT_INSTANCE here on a single missing poll, concluding "preempted".
      # The instance came BACK on a later poll — so the trap had nothing to
      # destroy and instance 52796316 LEAKED and kept billing until a manual
      # DELETE. Fail-safe direction: never stop tracking on one observation, and
      # let the trap destroy it (DELETE on an already-gone instance is harmless).
      log "  instance absent from this poll — NOT assuming deletion (transient absence != gone)"
      log "  keeping it tracked so teardown still runs"
      return 1
    fi
    if [[ "$st" == "exited" || "$st" == "offline" ]]; then
      log "  terminal state '$st' — destroying, advancing"
      blocklist_add "$machine_id" "terminal:$st"
      return 1
    fi
    if [[ "$st" == "running" && "$ip" != "-" && "$hp" != "-" ]]; then
      break
    fi
    sleep 15
  done

  if [[ "$st" != "running" || "$ip" == "-" || "$hp" == "-" ]]; then
    log "  did not reach running+mapped within ${CANDIDATE_DEADLINE_MIN}m — destroying, advancing"
    return 1
  fi

  local base="http://${ip}:${hp}"
  log "  serving at $base (container :$PORT -> host :$hp)"

  # -- wait for TEI health ----------------------------------------------------
  # The host has now PROVEN it can pull an image and start a GPU container, so the
  # short fail-fast window is over. Weight download + warmup gets its own,
  # generous budget (OT11: conflating the two kills healthy boxes mid-cold-start).
  local hdeadline=$(( $(date +%s) + HEALTH_WAIT_MIN*60 ))
  [[ $hdeadline -gt $GLOBAL_DEADLINE ]] && hdeadline=$GLOBAL_DEADLINE
  local healthy=0 code device checked_device=0
  while [[ $(date +%s) -lt $hdeadline ]]; do
    code=$(curl -sS --max-time 12 -o "$EVIDENCE_DIR/health-${newid}.txt" \
           -w "%{http_code}" "$base/health" 2>/dev/null) || code="000"
    log "    /health -> $code"
    [[ "$code" == "200" ]] && { healthy=1; break; }

    # Check the backend ONCE while waiting. A CPU fallback is decided at model
    # load — long before /health ever answers — so catching it here avoids
    # sitting through a multi-minute CPU warmup we are going to reject anyway.
    if [[ $checked_device -eq 0 ]]; then
      device=$(backend_device "$newid")
      if [[ "$device" == "cpu" ]]; then
        log "  CPU FALLBACK DETECTED (host CUDA runtime older than the image's CUDA build)"
        blocklist_add "$machine_id" "cpu-fallback"
        log "  → a GPU we are paying for is not being used; destroying, advancing"
        return 1
      fi
      [[ "$device" == "cuda" ]] && { checked_device=1; log "    backend confirmed: cuda"; }
    fi
    sleep 15
  done
  if [[ $healthy -ne 1 ]]; then
    log "  TEI never healthy within ${HEALTH_WAIT_MIN}m — destroying, advancing"
    return 1
  fi
  local cold=$(( $(date +%s) - rent_epoch ))
  log "  TEI HEALTHY ${cold}s after rent (cold start measured)"

  # -- GPU assertion (health + dimension + model id ALL pass on CPU) ----------
  device=$(backend_device "$newid")
  log "  backend device: $device"
  if [[ "$device" == "cpu" ]]; then
    log "  CPU FALLBACK — rejecting: this proves nothing about GPU offload"
    return 1
  fi
  if [[ "$device" == "unknown" ]]; then
    log "  ⚠️  could not determine backend device from logs — recording as UNVERIFIED"
  fi
  PROOF_DEVICE="$device"

  # -- the contract assertion -------------------------------------------------
  curl -sS --max-time 90 -X POST "$base/embed" -H 'Content-Type: application/json' \
    -d '{"inputs":"noco-mesh vast offload proof"}' > "$EVIDENCE_DIR/embed-${newid}.json" 2>&1
  local dim
  dim=$(python3 -c "
import json
try: d=json.load(open('$EVIDENCE_DIR/embed-${newid}.json'))
except Exception: print(-1); raise SystemExit
v=d
while isinstance(v,list) and v and isinstance(v[0],list): v=v[0]
print(len(v) if isinstance(v,list) else -1)
")
  log "  /embed dimension = $dim (contract demands $EXPECTED_DIM)"
  # A wrong dimension is NOT a host problem — it is a contract violation. Stop.
  [[ "$dim" == "$EXPECTED_DIM" ]] || { log "  DIMENSION MISMATCH — fatal"; return 2; }

  curl -sS --max-time 20 "$base/info" > "$EVIDENCE_DIR/info-${newid}.json" 2>&1 || true
  local served
  served=$(python3 -c "
import json
try: print(json.load(open('$EVIDENCE_DIR/info-${newid}.json')).get('model_id',''))
except Exception: print('')
")
  log "  served model_id = ${served:-<unavailable>}"
  if [[ -n "$served" && "$served" != "$MODEL" ]]; then
    log "  MODEL IDENTITY MISMATCH (dim match alone is not proof) — fatal"
    return 2
  fi

  PROOF_BASE="$base"; PROOF_DIM="$dim"; PROOF_MODEL="${served:-$MODEL}"
  # OT10: billed price != quoted price. Read the authoritative figure from the
  # INSTANCE object; keep the search quote alongside it for the drift record.
  local billed
  billed=$(api GET "/instances/" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); raise SystemExit
for i in d.get('instances',[]):
    if str(i.get('id'))=='$newid':
        print(i.get('dph_total') or ''); break
else: print('')
")
  PROOF_QUOTED="$dph"
  PROOF_DPH="${billed:-$dph}"
  PROOF_INSTANCE="$newid"; PROOF_COLD_START="$cold"
  return 0
}

# ------------------------------------------------------------------ attempts --
log "=== STEP 2: rent + provision, destroy-and-advance across candidates ==="
ATTEMPT=0
PROVED=0
while IFS=$'\t' read -r OID ODPH ORAM ODISK OGEO OREL OINET OMID; do
  [[ $ATTEMPT -ge $MAX_CANDIDATES ]] && { log "candidate budget exhausted ($MAX_CANDIDATES)"; break; }
  [[ $(date +%s) -ge $GLOBAL_DEADLINE ]] && { log "global deadline reached"; break; }
  if ! python3 -c "import sys;sys.exit(0 if float('$ODPH')<=float('$MAX_DPH') else 1)"; then
    continue
  fi
  ATTEMPT=$((ATTEMPT+1))
  log "attempt $ATTEMPT/$MAX_CANDIDATES: offer $OID \$$ODPH/hr ${ORAM}MiB ${ODISK}GB $OGEO rel=$OREL inet=${OINET}Mbps machine=$OMID"

  try_candidate "$OID" "$ODPH" "$OMID"; rc=$?

  if [[ $rc -eq 0 ]]; then
    PROVED=1
    break
  fi

  # Host-level failure or fatal: tear this one down before doing anything else.
  if [[ -n "$CURRENT_INSTANCE" ]]; then
    local_billed=$(( $(date +%s) - START_EPOCH ))
    destroy_and_verify "$CURRENT_INSTANCE"
    CURRENT_INSTANCE=""
  fi
  [[ $rc -eq 2 ]] && fail "fatal contract violation — stopping (not a host problem)"
done < "$EVIDENCE_DIR/candidates.tsv"

[[ $PROVED -eq 1 ]] || fail "no candidate could serve the contract in $ATTEMPT attempts"

ELAPSED=$(( $(date +%s) - START_EPOCH ))
COST=$(python3 -c "print(f'{float('$PROOF_DPH')*$PROOF_COLD_START/3600:.4f}')")
log "=== PROOF COMPLETE ==="
log "  instance     : $PROOF_INSTANCE"
log "  endpoint     : $PROOF_BASE"
log "  model        : $PROOF_MODEL"
log "  backend      : $PROOF_DEVICE (must be cuda — CPU fallback proves nothing)"
log "  dimension    : $PROOF_DIM (contract $EXPECTED_DIM)"
log "  cold start   : ${PROOF_COLD_START}s from rent to healthy"
log "  price        : \$$PROOF_DPH/hr billed (search quoted \$$PROOF_QUOTED) → accrued ~\$$COST"
log "  attempts     : $ATTEMPT candidate(s)"
log "teardown runs next (trap)"
