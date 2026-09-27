#!/usr/bin/env bash
# Offline smoke test of the whole Receipts path, in a throwaway GBrain and a
# temp ledger. Uses replay fixtures only: no API key, no network. Prints
# PASS/FAIL per step and exits 1 if any step failed.
#
#   scripts/demo-check.sh [--verbose] [--keep] [--no-gbrain]
#
#   --verbose    echo each command and its output (this is how out/e2e-run.txt is made)
#   --keep       keep the temp directory (it is always kept after a failure)
#   --no-gbrain  skip GBrain (also automatic when the gbrain CLI is missing)
#
# With GBrain the first sync writes ~120 rows one gbrain process at a time,
# so the whole check takes about 8 minutes; --no-gbrain takes under a minute.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERBOSE=0
KEEP=0
USE_GBRAIN=1
for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE=1 ;;
    --keep) KEEP=1 ;;
    --no-gbrain) USE_GBRAIN=0 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"
if [[ $USE_GBRAIN == 1 ]] && ! command -v "$GBRAIN_BIN" >/dev/null 2>&1; then
  echo "gbrain CLI not found: running without GBrain (install it to check the GBrain steps too)"
  USE_GBRAIN=0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/receipts-check.XXXXXX")"
LEDGER="$WORK/ledger.json"
TRANSCRIPT="$ROOT/fixtures/transcripts/synthetic-interview.txt"
PORT=$((43000 + RANDOM % 2000))
SERVER_PID=""

# Offline and isolated: replay fixtures, a fixed "today", a brain of our own.
# OPENAI_API_KEY is set to empty so neither Receipts (which would load the
# repo .env) nor gbrain child processes see a key.
export RECEIPTS_LLM=replay RECEIPTS_TODAY=2026-09-27 RECEIPTS_RECORD=0 OPENAI_API_KEY="" NO_COLOR=1
export GBRAIN_HOME="$WORK/gbrain"
cd "$WORK" || exit 1

NO_GBRAIN=()
if [[ $USE_GBRAIN == 0 ]]; then
  NO_GBRAIN=(--no-gbrain)
  export GBRAIN_BIN="$WORK/gbrain-disabled"   # the live server has no --no-gbrain flag
fi

# Narration goes to stderr so it never mixes into output a step captures or pipes.
say() { [[ $VERBOSE == 1 ]] && echo "$@" >&2; return 0; }

# `receipts ...` as the user would type it; runs the repo CLI on the temp ledger.
receipts() {
  say "\$ receipts $*"
  bun "$ROOT/src/cli.ts" --ledger "$LEDGER" --offline "$@"
}

gb() {
  say "\$ gbrain $*"
  "$GBRAIN_BIN" "$@"
}

# Assertions run as small Bun scripts. `js <code> [args...]`
js() { bun -e "$1" "${@:2}"; }

claims_for() {
  js 'const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(l.claims.filter((c) => c.personSlug === process.argv[2]).length)' "$LEDGER" "$1"
}

expect_eq() {
  if [[ "$1" != "$2" ]]; then echo "expected $3 = $2, got $1"; return 1; fi
  say "ok: $3 = $1"
}

PASSED=0
FAILED=0
SKIPPED=0
RESULTS=()

step() {
  local name="$1"; shift
  local out="$WORK/step.out" start end status
  say ""
  say "=== $name"
  start=$(date +%s)
  if [[ $VERBOSE == 1 ]]; then
    "$@" 2>&1 | tee "$out"
    status=${PIPESTATUS[0]}
  else
    "$@" >"$out" 2>&1
    status=$?
  fi
  end=$(date +%s)
  cat "$out" >>"$WORK/check.log"
  if [[ $status == 0 ]]; then
    RESULTS+=("PASS  $name ($((end - start))s)")
    PASSED=$((PASSED + 1))
    echo "PASS  $name ($((end - start))s)"
  else
    RESULTS+=("FAIL  $name ($((end - start))s)")
    FAILED=$((FAILED + 1))
    echo "FAIL  $name ($((end - start))s)"
    [[ $VERBOSE == 0 ]] && tail -n 15 "$out" | sed 's/^/      /'
  fi
}

skip() {
  RESULTS+=("SKIP  $1")
  SKIPPED=$((SKIPPED + 1))
  echo "SKIP  $1"
}

# ---- steps ----------------------------------------------------------------

gbrain_init() {
  gb init --pglite --non-interactive --no-embedding --content-root "$WORK/brain" --git >/dev/null
  gb --version
}

doctor() { receipts doctor; }

seed() {
  receipts seed ${NO_GBRAIN[@]+"${NO_GBRAIN[@]}"} || return 1
  expect_eq "$(claims_for elon-musk)" 13 "elon-musk claims in the ledger"
}

elon_takes() { "$GBRAIN_BIN" takes people/elon-musk --json | js 'console.log(JSON.parse(await Bun.stdin.text()).length)'; }

sync_idempotent() {
  local before after
  before=$(elon_takes)
  receipts sync || return 1
  after=$(elon_takes)
  expect_eq "$after" "$before" "elon-musk takes after a second sync"
}

drift() {
  receipts drift --no-llm ${NO_GBRAIN[@]+"${NO_GBRAIN[@]}"} || return 1
  js 'const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const pushed = l.claims.filter((c) => c.drift?.label === "pushed_later").length;
      if (!l.claims.every((c) => c.drift) || pushed < 5) throw new Error("drift labels missing");
      console.log(`ok: every claim has a drift label; ${pushed} deadline pushes`)' "$LEDGER"
}

score() {
  receipts score || return 1
  receipts score --person elon-musk --json | js 'const s = JSON.parse(await Bun.stdin.text());
    if (s.predictions !== 13 || s.accuracy === null) throw new Error("unexpected score");
    console.log(`ok: elon-musk accuracy ${s.accuracy.toFixed(3)}, Brier ${s.brier.toFixed(3)}`)'
}

site() {
  receipts site --out "$WORK/site" || return 1
  test -s "$WORK/site/index.html" && test -s "$WORK/site/people/elon-musk.html" && say "ok: index.html and people/elon-musk.html written"
}

ingest() {
  receipts ingest "$TRANSCRIPT" --speaker "Dana Founder" --host "Sam Host" \
    --title "Synthetic Interview (test fixture)" --date 2024-03-15 \
    --url https://example.com/synthetic-interview --no-grade ${NO_GBRAIN[@]+"${NO_GBRAIN[@]}"} || return 1
  expect_eq "$(claims_for dana-founder)" 16 "dana-founder claims in the ledger"
}

ask() {
  local answer
  answer=$(receipts ask "How much should I trust Elon Musk on robotaxi timelines?") || return 1
  echo "$answer"
  grep -q "Elon Musk: 13 predictions on record" <<<"$answer" && grep -q "INCORRECT" <<<"$answer"
}

export_river() {
  receipts export --river "$WORK/river.jsonl" || return 1
  js 'const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
      for (const line of lines) { const m = JSON.parse(line).messages; if (m.length !== 3 || m[2].role !== "assistant") throw new Error("bad line"); }
      console.log(`ok: ${lines.length} chat examples`)' "$WORK/river.jsonl"
}

demo() {
  receipts demo --out "$WORK/demo-site" ${NO_GBRAIN[@]+"${NO_GBRAIN[@]}"} || return 1
  test -s "$WORK/demo-site/index.html"
}

scorecard_parity() {
  local card mine
  card=$(gb takes scorecard people/elon-musk --json) || return 1
  echo "$card"
  mine=$(receipts score --person elon-musk --json) || return 1
  js 'const g = JSON.parse(process.argv[1]); const r = JSON.parse(process.argv[2]);
      const same = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1e-6;
      console.log(`gbrain accuracy ${g.accuracy} Brier ${g.brier}; receipts accuracy ${r.accuracy} Brier ${r.brier}`);
      if (!same(g.accuracy, r.accuracy) || !same(g.brier, r.brier)) throw new Error("scorecard mismatch");
      console.log("ok: GBrain scorecard equals receipts score (Brier within 1e-6: GBrain stores weights as float4)")' "$card" "$mine"
}

stop_server() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null
  SERVER_PID=""
}

get() {
  local path="$1" code
  code=$(curl -s -o "$WORK/resp" -w '%{http_code}' "http://127.0.0.1:$PORT$path")
  echo "GET $path -> $code ($(wc -c <"$WORK/resp" | tr -d ' ') bytes)"
  [[ $code == 200 ]]
}

serve() {
  say "\$ receipts serve --port $PORT &"
  bun "$ROOT/src/cli.ts" --ledger "$LEDGER" --offline serve --port "$PORT" >"$WORK/serve.log" 2>&1 &
  SERVER_PID=$!
  local up=0
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && { up=1; break; }
    sleep 0.2
  done
  [[ $up == 1 ]] || { cat "$WORK/serve.log"; stop_server; return 1; }
  local ok=0
  get / && grep -q "Elon Musk" "$WORK/resp" &&
    get /p/elon-musk && grep -q "Goalposts\|Deadline pushed" "$WORK/resp" &&
    get /api/ledger && js 'const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (l.claims.length < 48) throw new Error("ledger too small"); console.log(`ok: ${l.claims.length} claims`)' "$WORK/resp" &&
    get "/api/ask?q=How%20much%20should%20I%20trust%20Elon%20Musk%20on%20robotaxi%20timelines%3F" &&
    js 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!j.people.includes("elon-musk") || !j.receipts.length) throw new Error("bad answer"); console.log(`ok: ${j.receipts.length} receipts, usedModel ${j.usedModel}`)' "$WORK/resp" &&
    ingest_stream && ok=1
  stop_server
  say "--- server log"
  [[ $VERBOSE == 1 ]] && cat "$WORK/serve.log"
  [[ $ok == 1 ]]
}

ingest_stream() {
  local body
  body=$(js 'console.log(JSON.stringify({ input: process.argv[1], speaker: "Dana Founder", host: "Sam Host", title: "Synthetic Interview (test fixture)", date: "2024-03-15", url: "https://example.com/synthetic-interview" }))' "$TRANSCRIPT")
  curl -sN --max-time 600 -X POST -H 'content-type: application/json' --data "$body" "http://127.0.0.1:$PORT/api/ingest" >"$WORK/sse"
  echo "POST /api/ingest -> $(grep -c '^data:' "$WORK/sse") events"
  grep '^data:' "$WORK/sse" | js 'for (const line of (await Bun.stdin.text()).trim().split("\n")) { const e = JSON.parse(line.slice(5)); console.log(`  ${e.stage}: ${e.message.slice(0, 110)}`); }' | awk '!seen[$0]++' | head -n 40
  grep -q '"stage":"complete"' "$WORK/sse"
}

no_key_leak() {
  # Nothing the run wrote (text files: ledger, site, pages, exports) and no
  # fixture may hold something shaped like an OpenAI key: "sk-" at a word
  # start, 20+ key characters, mixed case. URL slugs such as
  # ".../elon-musk-says-..." are lowercase and do not count. Only file names
  # are printed, never the match.
  local hits
  hits=$(grep -rIoE '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}' "$WORK" "$ROOT/fixtures" 2>/dev/null |
    grep -E 'sk-[A-Za-z0-9_-]*[A-Z]' | cut -d: -f1 | sort -u)
  if [[ -n "$hits" ]]; then
    echo "$hits"
    echo "found key-shaped strings in the files above"
    return 1
  fi
  echo "ok: no key-shaped strings in the run's files or fixtures"
}

# ---- run ---------------------------------------------------------------------

echo "Receipts offline check in $WORK (today $RECEIPTS_TODAY, replay fixtures, gbrain: $([[ $USE_GBRAIN == 1 ]] && echo on || echo off))"
if [[ $USE_GBRAIN == 1 ]]; then step "gbrain init (throwaway PGLite brain)" gbrain_init; else skip "gbrain init"; fi
step "receipts doctor" doctor
step "receipts seed (ledger + GBrain pages, takes, resolutions)" seed
if [[ $USE_GBRAIN == 1 ]]; then step "receipts sync (idempotent: no new takes)" sync_idempotent; else skip "receipts sync"; fi
step "receipts drift --no-llm" drift
step "receipts score" score
step "receipts site" site
step "receipts ingest synthetic interview --no-grade" ingest
step "receipts ask (offline template)" ask
step "receipts export --river" export_river
step "receipts demo" demo
if [[ $USE_GBRAIN == 1 ]]; then step "gbrain takes scorecard == receipts score" scorecard_parity; else skip "scorecard parity"; fi
step "receipts serve: /, /p/elon-musk, /api/ledger, /api/ask, POST /api/ingest" serve
step "no API key in any output" no_key_leak
stop_server

echo
echo "$PASSED passed, $FAILED failed, $SKIPPED skipped"
if [[ $FAILED == 0 && $KEEP == 0 ]]; then
  rm -rf "$WORK"
else
  echo "Work directory kept: $WORK (log: $WORK/check.log)"
fi
[[ $FAILED == 0 ]]
