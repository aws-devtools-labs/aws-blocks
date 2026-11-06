#!/usr/bin/env bash
# Step 3 (verifier): `npm run build`, then launch the dev server FRESH and run the task's Playwright
# spec against it. This step OWNS the dev server (step 2 ran with none bound): it frees the ports,
# starts `npm run dev`, discovers the port from the framework banner, and points Playwright at it.
# Writes build/dev-server/playwright/test signals to $GITHUB_OUTPUT (the judge folds them into EVIDENCE).
# Required env: WORKSPACE (bench-app path), TASK_DIR (task dir with PROMPT.md + test.spec.ts).
#
# TRUST SPLIT: this script is the trusted supervisor (runner uid, job credentials in its env). Every
# process that runs the agent's app or its dependencies — the package.json probes, npm install and its
# lifecycle scripts, the build, the dev server, Playwright (it loads the app's node_modules) — runs via
# lib/agent-exec.mjs as the isolated agent user with the scrubbed env: no credentials, no GITHUB_*
# file-command paths, no RUNNER_TEMP. The supervisor opens their log redirects (runner-owned files),
# reads agent-written files only without following links, and alone writes GITHUB_OUTPUT, from
# validated values. Under CI it refuses to run agent code without that boundary.
set -euo pipefail

: "${WORKSPACE:?WORKSPACE must be set}"
: "${TASK_DIR:?TASK_DIR must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set (run inside GitHub Actions)}"

AGENT_EXEC=(node "$(cd "$(dirname "$0")" && pwd)/lib/agent-exec.mjs")
# Run a shell command as the agent user in the workspace: agent_run [K=V …] -- '<command>'.
agent_run() { "${AGENT_EXEC[@]}" run "$WORKSPACE" "$@"; }

# Pin to the lockfile-resolved version so the browser/runner stay reproducible.
PW_VERSION="1.60.0"

# Per-cell scratch dir for the supervisor's captures (runner-owned, 0700: the agent user can't reach
# or pre-create anything in it).
CELL_TMP="$(mktemp -d "/tmp/bench-${TASK:-default}-XXXXXX")"

# Test-only mock switch, inherited by both the dev server and Playwright. Tasks
# whose grader needs a server-side test backdoor gate that surface on BLOCKS_MOCK
# and return null otherwise, so it is inert in a real deployment. Example:
# cognito-profile's api.getLastCode exposes the most-recently delivered sign-up code
# (the grader has no mailbox) only when this is set. (BLOCKS_* passes the agent env policy.)
export BLOCKS_MOCK=true

# Pessimistic defaults up front, updated on success, so a failure still yields well-formed EVIDENCE.
# build_status defaults "failed" (matches build_succeeded=false); the build step overwrites both.
{
  echo "build_succeeded=false"
  echo "build_status=failed"
  echo "dev_server_started=false"
  echo "playwright_installed=false"
  echo "tests_passed=0"
  echo "tests_failed=0"
  echo "tests_total=0"
} >> "$GITHUB_OUTPUT"

# cd into the workspace (build + dev launch run from the bench-app root).
cd "$WORKSPACE" || {
  # Missing workspace: pessimistic defaults are already recorded, so exit 0 (green-regardless).
  echo "::warning::workspace missing at $WORKSPACE — recording pessimistic build/test signals and skipping"
  exit 0
}

# Fail closed on any boundary failure: stamp `isolation_failure` (scoring → harness_error, infra) and
# stop, so agent code never runs (or keeps running) outside the agent-user boundary.
isolation_failed() {
  RESULT_PATH="${RESULT_PATH:-/tmp/result.json}" REASON="step 3: $1" node -e '
    const fs = require("fs");
    const p = process.env.RESULT_PATH;
    let r = {};
    try { r = JSON.parse(fs.readFileSync(p, "utf-8")); } catch {}
    r.isolation_failure = process.env.REASON;
    fs.writeFileSync(p, JSON.stringify(r, null, 2));
  ' || true
  echo "::error::$1; refusing to run the agent's app"
  exit 1
}
agent_reap() { "${AGENT_EXEC[@]}" reap || isolation_failed "agent-user processes survived the reap"; }

# Enter the agent-user boundary: reap anything left from step 2, (re)grant the workspace ACL, lock the
# runner temp dirs and verify the agent user can't reach them or this job's /proc environ.
"${AGENT_EXEC[@]}" preflight "$WORKSPACE" || isolation_failed "agent-user isolation preflight failed"
# Whatever exit path: no agent-user process (dev server included) outlives this step.
trap '"${AGENT_EXEC[@]}" reap >/dev/null 2>&1 || true' EXIT

# Build detection (scoring correctness): some templates ship no `build` script, so a bare
# `npm run build` exits non-zero — recording that as a failure would wrongly cap the judge. So:
#   - package.json missing/malformed → build_status=failed (a broken workspace IS a failure).
#   - no `build` script   → build_status=na, build_succeeded=true (N/A, step 4 applies no cap).
#   - `build` ok / failed → build_status=ok / failed (a real failure keeps the cap).
# The require() probe throws on a missing/malformed file (distinct from "no build script"); the
# second probe exits 0 iff scripts.build is non-empty. Guarded `if`s stay safe under `set -e`.
if ! agent_run -- 'node -e "require(\"./package.json\")"' 2>/dev/null; then
  echo "::warning::package.json missing or malformed — treating as build failure"
  {
    echo "build_status=failed"
    echo "build_succeeded=false"
  } >> "$GITHUB_OUTPUT"
elif agent_run -- 'node -e "process.exit(require(\"./package.json\").scripts?.build ? 0 : 1)"'; then
  if agent_run -- 'npm run build' > "${CELL_TMP}/build.log" 2>&1; then
    {
      echo "build_status=ok"
      echo "build_succeeded=true"
    } >> "$GITHUB_OUTPUT"
  else
    echo "::warning::\`build\` script present but \`npm run build\` failed — real build failure"
    {
      echo "build_status=failed"
      echo "build_succeeded=false"
    } >> "$GITHUB_OUTPUT"
    tail -50 "${CELL_TMP}/build.log"
  fi
else
  echo "[build] no \`build\` script in package.json — build is N/A for this template (not a failure)"
  {
    echo "build_status=na"
    echo "build_succeeded=true"
  } >> "$GITHUB_OUTPUT"
fi

# Nothing the build started may survive into the supervisor's own writes below.
agent_reap

# Stage the graded spec + Playwright config NOW, while no agent-user process is alive, so nothing can
# swap a path under these runner writes. Both live in bench-tests/ (excluded from the judge's copy):
# fresh dir, and noclobber (O_EXCL) creates so a planted symlink fails the write instead of being
# followed. The JSON report goes to bench-tests/ too (Playwright runs as the agent user); the
# supervisor reads it back without following links.
sudo -n rm -rf bench-tests 2>/dev/null || rm -rf bench-tests
mkdir bench-tests
PW_RESULTS_JSON="${WORKSPACE}/bench-tests/pw-results.json"
(
  set -C
  cat "$TASK_DIR/test.spec.ts" > bench-tests/task.spec.ts
  cat > bench-tests/playwright.config.ts <<'EOF'
import { defineConfig } from '@playwright/test';

// Serial, single-worker: cells share one dev server whose backing store persists for the run,
// so parallel tests would race on shared state. retries: 0 for an honest pass/fail signal.
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  globalTimeout: 600_000,
  expect: { timeout: 15_000 },
  use: {
    // The discovered dev-server URL (exported as APP_BASE_URL); specs also use their own
    // absolute goto() via BLOCKS_URL, but baseURL is set for any relative navigation.
    baseURL: process.env.APP_BASE_URL,
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  },
  // Report path injected via PW_RESULTS_JSON (inside bench-tests/, next to this config).
  reporter: [['json', { outputFile: process.env.PW_RESULTS_JSON || 'pw-results.json' }]],
});
EOF
)

# ── Dev server: launch fresh + discover its port two independent ways ────────
# The verifier OWNS the server. Any dev server step 2 left was reaped with the agent user's processes
# (preflight), so only its stale pidfile remains: the framework singleton guard would REFUSE our
# `npm run dev` on it, so drop it, then free the front-door ports (3000/3001 only, never :3100).
# Discovery uses TWO independent paths over a 90-iteration window (either confirms), sharing ONE
# readiness bar — the app root `/` answers non-5xx (`< 500`). They differ only in how the port is found:
# Path A parses it from the framework banner `AWS Blocks local server running on http://localhost:<port>`;
# Path B probes the candidate ports for `/.blocks-sandbox/config.json` (served by our front door the
# moment it binds), which finds the port independent of banner text/parse timing — its drift-proof win.
# config.json is a discovery signal only (it answers before the proxied app on :3100 is up), so Path B
# still confirms readiness with the same root `/` probe. If neither confirms, APP_BASE_URL stays empty
# and we proceed (the cell fails honestly rather than hanging). See the inline block at the launch site.
agent_run -- 'rm -f .blocks-sandbox/dev-server.*.pid' || true

# The front-door ports the dev server may bind (3000/3001 only, never :3100). Single source of truth:
# the free-port loop below AND the readiness probe further down both read $DEV_PORTS, so changing
# the canonical set updates both.
DEV_PORTS="3000 3001"

for p in $DEV_PORTS; do sudo -n fuser -k "${p}/tcp" 2>/dev/null || fuser -k "${p}/tcp" 2>/dev/null || true; done
for i in $(seq 1 10); do
  # Probe via sudo too: a squatter owned by another uid is invisible to an unprivileged fuser.
  { sudo -n fuser $(printf '%s/tcp ' $DEV_PORTS) >/dev/null 2>&1 || fuser $(printf '%s/tcp ' $DEV_PORTS) >/dev/null 2>&1; } || break
  # Still held — re-issue the privileged kill before waiting.
  for p in $DEV_PORTS; do sudo -n fuser -k "${p}/tcp" 2>/dev/null || fuser -k "${p}/tcp" 2>/dev/null || true; done
  sleep 1
done

# Dev-server stability: readiness is detected two INDEPENDENT ways, so a slow or
# mismatched startup banner no longer false-negatives `dev_server_started` (which hard-caps
# selector_contract + functional_completeness in scoring.mjs — a flaky miss was punishing apps that
# were actually up). Both paths use the SAME readiness bar — the app root `/` answers non-5xx (`< 500`)
# — and differ only in how they find the port. Path A: parse the port from the startup banner. Path B:
# probe the candidate ports for `/.blocks-sandbox/config.json`, which OUR front door serves the moment
# it binds; a hit identifies our port WITHOUT depending on the banner text or grep/parse timing (its
# win — it survives a banner-string change or a slow/garbled log write). config.json is a PORT-DISCOVERY
# signal, not a readiness one: it answers 200 before spawnFrontend() brings up the proxied app on :3100
# (dev-server.ts:1024-1034), so both paths still confirm on the root `/` probe before accepting a port.
# No NODE_OPTIONS heap cap: an OOM fix needs a repro (none yet), and guessing one could mask it.
# The server runs as the agent user; its log is a supervisor-opened (runner-owned) file. The EXIT trap
# reaps it.
nohup "${AGENT_EXEC[@]}" run "$WORKSPACE" -- 'npm run dev' > "${CELL_TMP}/dev.log" 2>&1 &
echo "$!" > "${CELL_TMP}/dev.pid"

APP_BASE_URL=""
# Up to 90 iterations, one per ~1s idle plus the curl time. NOT a hard 90s wall-clock bound: each
# iteration issues up to 5 `curl -m 5` probes (Path A root + per DEV_PORT: config.json then, on a hit,
# the root), and a port that ACCEPTS then hangs — the loaded scenario this targets — can stretch an
# iteration well past a few seconds, so worst-case wall clock exceeds 90s. The iteration cap, not a
# timer, is what bounds the loop.
for i in $(seq 1 90); do
  # Path A — banner-derived port (exact port, when the banner shows up). Readiness = the app ROOT `/`
  # answers non-5xx (`< 500`): `/` proxies to the frontend on :3100, so a `< 500` means the proxied app
  # is actually up (a 502 = front door bound but frontend still booting). Path B below reuses this exact
  # root check as its readiness bar, so the two paths agree on "ready" — they differ only in how the
  # port is found (banner grep vs config.json probe).
  port=$(grep -oE 'AWS Blocks local server running on http://localhost:[0-9]+' "${CELL_TMP}/dev.log" 2>/dev/null | grep -oE '[0-9]+$' | head -1 || true)
  if [ -n "${port:-}" ]; then
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:${port}") || code=000
    if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then
      APP_BASE_URL="http://localhost:${port}"
      echo "[discover] dev server ready on :${port} (HTTP $code) after ${i} iteration(s) (banner)"
      break
    fi
  fi
  # Path B — drift-proof port DISCOVERY, then the SAME readiness bar as Path A. config.json is served
  # by OUR front door synchronously (dev-server.ts), so it identifies the right port without depending
  # on the banner text or grep/parse timing (its real win). But it answers 200 the instant the front
  # door binds — BEFORE spawnFrontend() brings up the proxied app on :3100 (dev-server.ts:1024-1034),
  # during which `/` still 502s. So config.json alone is a LAXER "ready" than Path A and would let
  # dev_server_started=true fire while the app isn't serving. Fix: on a config.json hit (`< 400` =
  # our app is on this port), confirm readiness with Path A's own root probe (`/` returns `< 500`)
  # before accepting. Banner-text drift stays covered; the gate is never weaker than Path A.
  for p in $DEV_PORTS; do
    ccode=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:${p}/.blocks-sandbox/config.json") || ccode=000
    if [ "$ccode" != "000" ] && [ "$ccode" -lt 400 ]; then
      rcode=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:${p}") || rcode=000
      if [ "$rcode" != "000" ] && [ "$rcode" -lt 500 ]; then
        APP_BASE_URL="http://localhost:${p}"
        echo "[discover] dev server ready on :${p} (config.json $ccode + root $rcode) after ${i} iteration(s) (readiness probe)"
        break 2
      fi
    fi
  done
  sleep 1
done

if [ -n "$APP_BASE_URL" ]; then
  echo "dev_server_started=true" >> "$GITHUB_OUTPUT"
  echo "[discover] APP_BASE_URL=${APP_BASE_URL}"
else
  # Neither the banner NOR the config.json readiness probe confirmed within the window. Record the
  # signal + a brief diagnostic (pid liveness + log tail) onto result.json, then proceed with
  # APP_BASE_URL empty.
  echo "::warning::dev server never became ready within the readiness window (all 90 loop iterations exhausted: no banner and no config.json on :3000/:3001)"
  # Distinct dead-server / backend-crash signal so downstream can tell this apart from an agent that
  # built a genuinely broken app (mirrors how build_succeeded/dev_server_started are emitted above).
  echo "dev_server_status=dead" >> "$GITHUB_OUTPUT"
  dev_pid=""; [ -f "${CELL_TMP}/dev.pid" ] && dev_pid="$(cat "${CELL_TMP}/dev.pid" 2>/dev/null || true)"
  if [ -z "${dev_pid:-}" ]; then dev_pid_status="no-pidfile"
  elif kill -0 "$dev_pid" 2>/dev/null; then dev_pid_status="alive (pid=${dev_pid}) but not serving"
  else dev_pid_status="exited (pid=${dev_pid})"; fi
  echo "[dead-server] dev pid: ${dev_pid_status}"
  if [ -f "${CELL_TMP}/dev.log" ]; then
    dev_log_tail="$(tail -100 "${CELL_TMP}/dev.log" 2>/dev/null || true)"
    echo "[dead-server] tail -100 ${CELL_TMP}/dev.log:"; printf '%s\n' "$dev_log_tail"
  else
    dev_log_tail="(${CELL_TMP}/dev.log missing)"; echo "[dead-server] ${CELL_TMP}/dev.log missing"
  fi
  RESULT_PATH="${RESULT_PATH:-/tmp/result.json}" DEV_PID_STATUS="$dev_pid_status" DEV_LOG_TAIL="$dev_log_tail" node -e '
    const fs = require("fs");
    const p = process.env.RESULT_PATH;
    let r = {};
    try { r = JSON.parse(fs.readFileSync(p, "utf-8")); } catch {}
    r.dev_log_tail = process.env.DEV_LOG_TAIL || "";
    r.dev_pid_status = process.env.DEV_PID_STATUS || "";
    r.dev_server_status = "dead";
    fs.writeFileSync(p, JSON.stringify(r, null, 2));
  ' || echo "::warning::failed to record dev_log_tail on result.json"
fi

# Only run Playwright when the dev server actually came up. If APP_BASE_URL is empty the server is
# dead / the backend crashed (see the dead-server branch above) — launching Playwright with an empty
# BLOCKS_URL would surface as bogus "invalid URL" test failures, so skip Playwright entirely and let
# the recorded dev_server_status=dead signal drive the score instead. That signal classifies the cell
# as a real FAIL — verdict 'fail', composite 0, and INCLUDED in the mean (DEAD_SERVER_KLASS in
# lib/scoring.mjs) — so a backend crash HURTS the score rather than hiding as an excluded 'unknown',
# while the failure root-cause still attributes owner=framework. The pessimistic defaults (tests 0/0/0,
# dev_server_started=false) carry the honest signal and control still falls through to the
# stable-evidence copy below.

# Clear any stale /tmp evidence copies from a PRIOR cell BEFORE the Playwright guard below, so this
# always runs even when a Playwright-install/chromium early-exit fires inside the guard (those `exit 0`
# paths would otherwise skip the clear and leave the previous cell's pw-results.json/dev.log/build.log
# for analyze-cell to misread as this cell's). The fresh copies stay after the guard (they need
# the evidence to exist first); on an early-exit there is nothing to stage, and a cleared /tmp is the
# honest state — analyze-cell degrades to null on a missing file.
# /tmp is sticky (+t): a stale copy may be owned by the agent user, so a plain `rm` as the runner uid
# hits EPERM and — under `set -e` — would abort the step: `sudo -n rm` clears it, unprivileged `rm`
# is the fallback, and the trailing `|| true` guarantees this cleanup never aborts the step.
sudo -n rm -f /tmp/pw-results.json /tmp/dev.log /tmp/build.log 2>/dev/null || rm -f /tmp/pw-results.json /tmp/dev.log /tmp/build.log 2>/dev/null || true

if [ -n "$APP_BASE_URL" ]; then
# Record whether Playwright installed; on failure tests can't run, so emit the signal and bail.
# Both the package install AND the chromium download must succeed before the signal flips true.
if ! agent_run -- "npm install --no-save --silent @playwright/test@${PW_VERSION}"; then
  echo "::warning::playwright install failed; functional tests will not run"
  exit 0
fi
# Chromium is normally pre-provisioned before the agent phase (the "Provision
# Playwright chromium" workflow step, same job-level PLAYWRIGHT_BROWSERS_PATH), making this a
# cache-hit no-op. Kept (guarded) as a fallback so step 3 still works standalone; `playwright
# install` is idempotent, so it self-heals a rare miss.
if ! agent_run -- 'npx playwright install chromium' > "${CELL_TMP}/pw-install.log" 2>&1; then
  echo "::warning::playwright chromium download failed; functional tests will not run"
  exit 0
fi
echo "playwright_installed=true" >> "$GITHUB_OUTPUT"

# Specs read BLOCKS_URL for their absolute goto(); point it (and APP_BASE_URL) at the discovered port.
# RUN_ID is a run-stable seed the specs fold into deterministic-but-unique test data; it carries TASK
# so cells sharing a run id still seed distinct data. Passed explicitly: the agent env policy drops
# GITHUB_* and anything not allowlisted.
RUN_ID="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${TASK:-x}-$(date +%s)"
agent_run "RUN_ID=${RUN_ID}" "BLOCKS_URL=${APP_BASE_URL}" "APP_BASE_URL=${APP_BASE_URL}" "PW_RESULTS_JSON=${PW_RESULTS_JSON}" \
  -- 'npx playwright test --config bench-tests/playwright.config.ts' 2>&1 | tee "${CELL_TMP}/pw.log" || true

# Stop every agent-user process (the dev server included) before reading what they wrote.
agent_reap
# Agent-written report → runner-owned copy, never following a planted link.
if "${AGENT_EXEC[@]}" read-file "$PW_RESULTS_JSON" "${CELL_TMP}/pw-results.json" 2>/dev/null; then
  PW_RESULTS_JSON="${CELL_TMP}/pw-results.json" node -e '
    const fs = require("fs");
    const stats = JSON.parse(fs.readFileSync(process.env.PW_RESULTS_JSON, "utf-8")).stats ?? {};
    // The report was produced by agent-user code (Playwright runs the app node_modules), so
    // only bounded non-negative integers are written to GITHUB_OUTPUT. A missing "expected" is an
    // unexpected reporter shape, not zero passes: fail so the pessimistic defaults are retained.
    const n = (v, dflt) => (v === undefined ? dflt : Number.isInteger(v) && v >= 0 && v < 1e6 ? v : NaN);
    const expected = n(stats.expected, undefined);
    const flaky = n(stats.flaky, 0);
    const unexpected = n(stats.unexpected, 0);
    const skipped = n(stats.skipped, 0);
    if (expected === undefined || [expected, flaky, unexpected, skipped].some(Number.isNaN)) {
      console.error("unexpected Playwright reporter shape");
      process.exit(1);
    }
    const passed = expected + flaky;
    // NB: tests_total INCLUDES skipped (display); the scoring test_rate denominator EXCLUDES skipped.
    process.stdout.write(`tests_passed=${passed}\ntests_failed=${unexpected}\ntests_total=${passed + unexpected + skipped}\n`);
  ' >> "$GITHUB_OUTPUT" || echo "::warning::pw-results.json parse failed or unexpected shape; defaults retained"
else
  echo "::warning::Playwright produced no readable report (probably never ran); defaults retained"
fi
else
  echo "::warning::dev server never came up (dead-server/backend-crash) — skipped Playwright to avoid masking it as invalid-URL test failures; tests stay at pessimistic defaults"
fi

# The dev server must be gone before the scan below and before the evidence leaves this step.
agent_reap

# Causal data-layer scan — runs AFTER Playwright so dev.log is complete through the end of the tests.
# When a mock Database's eager migration run dies on a PGlite WASM init trap, bb-data KEEPS THE DEV
# SERVER ALIVE (the front door still serves, so the dead-server branch above never fires) but logs a
# fixed UNAVAILABLE sentinel; every DB-backed query then rejects. Without this scan such a cell would
# be `scored` with failing DB tests and counted against the agent — an INFRA memory crash blamed on
# the framework. BUT the fix that keeps the server alive also lets the data layer HEAL: ensureMigrations
# re-runs the idempotent migrations on the next query, and on success logs a RECOVERED marker. So the
# bare presence of the unavailable sentinel is NOT proof the layer was down when the tests ran — it may
# have recovered on the first request (boot-time trap), or trapped again mid-tests. We make the flag
# CAUSAL: set data_layer_unavailable ONLY when the LAST unavailable sentinel in dev.log is not followed
# by a recovery marker — i.e. the data layer was still wedged when Playwright finished. Both are fixed
# literals (not a fuzzy trap regex over arbitrary log lines), kept in sync with @aws-blocks/data-common.
DATA_LAYER_SENTINEL='[bb-data] PGlite init trap: data layer unavailable'
DATA_LAYER_RECOVERED='[bb-data] PGlite init trap: data layer recovered'
if [ -f "${CELL_TMP}/dev.log" ] && grep -qF "$DATA_LAYER_SENTINEL" "${CELL_TMP}/dev.log" 2>/dev/null; then
  DEV_LOG_PATH="${CELL_TMP}/dev.log" DL_SENTINEL="$DATA_LAYER_SENTINEL" DL_RECOVERED="$DATA_LAYER_RECOVERED" \
  RESULT_PATH="${RESULT_PATH:-/tmp/result.json}" node -e '
    const fs = require("fs");
    const log = fs.readFileSync(process.env.DEV_LOG_PATH, "utf-8");
    // Compare the LAST occurrence of each marker by byte offset. The data layer was down when the
    // tests finished iff an unavailable sentinel exists and no recovery marker came AFTER it.
    const lastDown = log.lastIndexOf(process.env.DL_SENTINEL);
    const lastUp = log.lastIndexOf(process.env.DL_RECOVERED);
    const wedged = lastDown !== -1 && lastUp < lastDown;
    if (wedged) {
      console.log("[data-layer] data layer wedged by a PGlite init trap and NOT recovered by test end (infra) — excluding cell");
      const p = process.env.RESULT_PATH;
      let r = {};
      try { r = JSON.parse(fs.readFileSync(p, "utf-8")); } catch {}
      r.data_layer_unavailable = true;
      fs.writeFileSync(p, JSON.stringify(r, null, 2));
    } else {
      console.log("[data-layer] PGlite init trap recovered before test end — data layer up, cell counts normally");
    }
  ' || echo "::warning::failed to evaluate data_layer_unavailable on result.json"
fi

# Stage the deep-failure evidence to STABLE /tmp paths for the later "analyze cell" step (CELL_TMP is
# per-run scratch) — mirror how the trace/metrics already land at /tmp. All three are runner-owned
# captures. Best-effort: a missing source or copy failure must never break the green-regardless exit
# (analyze-cell degrades to null when a file is absent). Stale copies from a PRIOR cell were already
# cleared before the Playwright guard above, so these cp's only ever add THIS cell's evidence.
cp "${CELL_TMP}/pw-results.json" /tmp/pw-results.json 2>/dev/null || true
cp "${CELL_TMP}/dev.log" /tmp/dev.log 2>/dev/null || true
cp "${CELL_TMP}/build.log" /tmp/build.log 2>/dev/null || true

# Always exit 0: real failures are already captured as $GITHUB_OUTPUT signals for the judge, and a
# non-zero exit would break green-regardless.
exit 0
