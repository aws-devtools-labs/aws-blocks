#!/usr/bin/env bash
# Step 3 (verifier): `npm run build`, then launch the dev server FRESH and run the task's Playwright
# spec against it. This step OWNS the dev server (step 2 ran with none bound): it frees the ports,
# starts `npm run dev`, discovers the port from the framework banner, and points Playwright at it.
# Writes build/dev-server/playwright/test signals to $GITHUB_OUTPUT (the judge folds them into EVIDENCE).
# Required env: WORKSPACE (bench-app path), TASK_DIR (task dir with PROMPT.md + test.spec.ts).
set -euo pipefail

: "${WORKSPACE:?WORKSPACE must be set}"
: "${TASK_DIR:?TASK_DIR must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set (run inside GitHub Actions)}"

# Pin to the lockfile-resolved version so the browser/runner stay reproducible.
PW_VERSION="1.60.0"

# Per-run, per-cell scratch prefix so a re-run on a reused runner can't collide on fixed /tmp paths.
# PW_RESULTS_JSON is exported so the generated playwright.config.ts heredoc can read the report path.
CELL_TMP="/tmp/bench-${TASK:-default}-$$"
mkdir -p "$CELL_TMP"
export PW_RESULTS_JSON="${CELL_TMP}/pw-results.json"

# Test-only mock switch, inherited by both the dev server and Playwright. Tasks
# whose grader needs a server-side test backdoor gate that surface on BLOCKS_MOCK
# and return null otherwise, so it is inert in a real deployment. Example:
# cognito-profile's api.getLastCode exposes the most-recently delivered OTP
# (the grader has no mailbox) only when this is set.
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

# Build detection (scoring correctness): some templates ship no `build` script, so a bare
# `npm run build` exits non-zero — recording that as a failure would wrongly cap the judge. So:
#   - package.json missing/malformed → build_status=failed (a broken workspace IS a failure).
#   - no `build` script   → build_status=na, build_succeeded=true (N/A, step 4 applies no cap).
#   - `build` ok / failed → build_status=ok / failed (a real failure keeps the cap).
# The require() probe throws on a missing/malformed file (distinct from "no build script"); the
# second node -e exits 0 iff scripts.build is non-empty. Guarded `if`s stay safe under `set -e`.
if ! node -e 'require("./package.json")' 2>/dev/null; then
  echo "::warning::package.json missing or malformed — treating as build failure"
  {
    echo "build_status=failed"
    echo "build_succeeded=false"
  } >> "$GITHUB_OUTPUT"
elif node -e 'process.exit(require("./package.json").scripts?.build ? 0 : 1)'; then
  if npm run build > "${CELL_TMP}/build.log" 2>&1; then
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

# ── Dev server: launch fresh + discover its port two independent ways ────────
# The verifier OWNS the server. Step 2 may have left a `tsx watch` supervisor alive, so first reap
# that tree and free the front-door ports (3000/3001 only, never :3100). Under shell isolation the
# agent's procs are benchagent-owned, so reap/free/probe go through sudo (unprivileged fallback).
# Discovery uses TWO independent readiness paths over a 90-attempt window (either confirms): Path A
# parses the port from the framework banner `AWS Blocks local server running on http://localhost:<port>`
# and HTTP-probes it; Path B (deterministic) probes the candidate ports directly for the app's readiness
# artifact `/.blocks-sandbox/config.json`, which the app serves only once it is genuinely listening —
# independent of the banner text and grep/parse timing (a redundant, drift-proof path, not a faster
# one; both go live at the same onListening). If neither confirms, APP_BASE_URL stays empty and we
# proceed (the cell fails honestly rather than hanging). See the inline block at the launch site for detail.

# Reap any dev server the agent left running. The framework records each in
# .blocks-sandbox/dev-server.<port>.pid as {pid, ppid, port}; `ppid` is the `tsx watch` supervisor
# that respawns `pid` on change. A plain `fuser -k` only kills the child, the supervisor respawns it,
# and the stale pidfile makes the framework singleton guard REFUSE our own `npm run dev`. So kill the
# supervisor tree first (ppid before pid; TERM then KILL) and delete the pidfile before freeing ports.
# Only node/tsx/npm procs are signalled (pid-reuse guard); sudo covers the cross-uid isolated case.
reap_stale_dev_servers() {
  local sandbox="${WORKSPACE}/.blocks-sandbox"
  [ -d "$sandbox" ] || return 0
  local pf ids ppid pid sig target
  for pf in "$sandbox"/dev-server.*.pid; do
    [ -f "$pf" ] || continue
    ids="$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(`${Number.isInteger(r.ppid)?r.ppid:""} ${Number.isInteger(r.pid)?r.pid:""}`)}catch{}' "$pf" 2>/dev/null || true)"
    read -r ppid pid <<< "$ids" || true
    for sig in TERM KILL; do
      for target in "$ppid" "$pid"; do
        [ -n "${target:-}" ] || continue
        # pid-reuse guard: only signal a live node/tsx/npm process (/proc/<pid>/comm).
        # This is a comm-CLASS heuristic (matches any node/tsx/npm), not process IDENTITY — a
        # recycled pid now running an UNRELATED node/tsx/npm would still match. Acceptable here:
        # the window is tiny and the sole workload on this ephemeral runner is our own dev server.
        case "$(cat "/proc/${target}/comm" 2>/dev/null || true)" in
          node|tsx|npm*) sudo -n kill "-${sig}" "$target" 2>/dev/null || kill "-${sig}" "$target" 2>/dev/null || true ;;
        esac
      done
      [ "$sig" = TERM ] && sleep 1
    done
    # Drop the stale pidfile so the framework singleton guard won't refuse our start.
    sudo -n rm -f "$pf" 2>/dev/null || rm -f "$pf" 2>/dev/null || true
  done
}
reap_stale_dev_servers

# The front-door ports the dev server may bind (3000/3001 only, never :3100). Single source of truth:
# the reap/free-port loop below AND the readiness probe further down both read $DEV_PORTS, so changing
# the canonical set updates both.
DEV_PORTS="3000 3001"

for p in $DEV_PORTS; do sudo -n fuser -k "${p}/tcp" 2>/dev/null || fuser -k "${p}/tcp" 2>/dev/null || true; done
for i in $(seq 1 10); do
  # Probe via sudo too: an isolated squatter is benchagent-owned and invisible to an unprivileged fuser.
  { sudo -n fuser $(printf '%s/tcp ' $DEV_PORTS) >/dev/null 2>&1 || fuser $(printf '%s/tcp ' $DEV_PORTS) >/dev/null 2>&1; } || break
  # Still held — re-issue the privileged kill before waiting.
  for p in $DEV_PORTS; do sudo -n fuser -k "${p}/tcp" 2>/dev/null || fuser -k "${p}/tcp" 2>/dev/null || true; done
  sleep 1
done

# Reap the dev server on EXIT (it stays alive through the Playwright run; no later step needs it).
# Trapped before launch so an interrupt is still reaped; guarded to no-op before the server started.
cleanup_dev_server() {
  [ -f "${CELL_TMP}/dev.pid" ] || return 0
  local dev_pid
  dev_pid="$(cat "${CELL_TMP}/dev.pid" 2>/dev/null || true)"
  if [ -n "${dev_pid:-}" ]; then kill "$dev_pid" 2>/dev/null || true; fi
}
trap cleanup_dev_server EXIT

# Dev-server stability: readiness is detected two INDEPENDENT ways, so a slow or
# mismatched startup banner no longer false-negatives `dev_server_started` (which hard-caps
# selector_contract + functional_completeness in scoring.mjs — a flaky miss was punishing apps that
# were actually up). Path A: parse the port from the startup banner, then HTTP-probe it. Path B (the
# deterministic gate): probe the candidate ports directly for the app's real readiness artifact
# `/.blocks-sandbox/config.json`, which the app serves only once it is genuinely listening. Path B does
# not depend on the banner TEXT or on grep/parse timing — that is its win (it survives a banner-string
# change or a slow/garbled log write). It does NOT beat the banner in wall-clock time: in
# packages/core/src/scripts/dev-server.ts the config.json HTTP route only answers after
# server.listen(port, onListening) fires, and that same onListening logs the banner as its first line,
# so both paths become live at the same instant. Path B is a redundant, drift-proof readiness path, not
# a faster one. Either path confirming marks the server ready.
# No NODE_OPTIONS heap cap: an OOM fix needs a repro (none yet), and guessing one could mask it.
nohup npm run dev > "${CELL_TMP}/dev.log" 2>&1 &
echo "$!" > "${CELL_TMP}/dev.pid"

# Candidate ports for the readiness probe: $DEV_PORTS, defined once above with the reap/free-port loop.

APP_BASE_URL=""
# Up to 90 attempts, one per ~1s idle plus the curl time. NOT a hard 90s wall-clock bound: each
# attempt issues up to 3 `curl -m 5` probes (Path A + one per DEV_PORT), and a port that ACCEPTS then
# hangs — the loaded scenario this targets — can stretch an attempt toward ~15s, so worst-case wall
# clock exceeds 90s. The attempt cap, not a timer, is what bounds the loop.
for i in $(seq 1 90); do
  # Path A — banner-derived port (exact port, when the banner shows up). Accepts any non-5xx (`< 500`):
  # this probes the app ROOT, where a 2xx/3xx/4xx all mean "the server is up and answering" (a 404 root
  # is still a live server). Path B below is stricter (`< 400`) because it probes a SPECIFIC artifact
  # that must exist — do not unify the two thresholds.
  port=$(grep -oE 'AWS Blocks local server running on http://localhost:[0-9]+' "${CELL_TMP}/dev.log" 2>/dev/null | grep -oE '[0-9]+$' | head -1 || true)
  if [ -n "${port:-}" ]; then
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:${port}") || code=000
    if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then
      APP_BASE_URL="http://localhost:${port}"
      echo "[discover] dev server ready on :${port} (HTTP $code) after ${i}s (banner)"
      break
    fi
  fi
  # Path B — deterministic readiness: OUR dev server serves /.blocks-sandbox/config.json (a reserved
  # front-door route, dev-server.ts) with a 200 the moment it accepts connections — the route is
  # registered synchronously and gated on no "ready" flag. So we require 2xx/3xx (`< 400`): a 404 means
  # whatever answered on this port is NOT our app (a different/stale server, or a framework dev server
  # that proxies and can't serve this reserved path), so we must not attach to it.
  # (Aware: if the reap above failed and a stale copy of OUR app still served config.json on a DEV_PORT,
  # this — like Path A — could attach to it; the thorough reap + fuser-kill loop makes that unlikely, not a regression.)
  for p in $DEV_PORTS; do
    ccode=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:${p}/.blocks-sandbox/config.json") || ccode=000
    if [ "$ccode" != "000" ] && [ "$ccode" -lt 400 ]; then
      APP_BASE_URL="http://localhost:${p}"
      echo "[discover] dev server ready on :${p} (config.json HTTP $ccode) after ${i}s (readiness probe)"
      break 2
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
export APP_BASE_URL

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
# for analyze-cell to misread as this cell's). The fresh `cp` staging stays after the guard (it needs
# the evidence to exist first); on an early-exit there is nothing to stage, and a cleared /tmp is the
# honest state — analyze-cell degrades to null on a missing file.
# /tmp is sticky (+t): a stale copy may be benchagent-owned (the agent's isolated phase wrote it), so a
# plain `rm` as the runner uid hits EPERM and — under `set -e` — would abort the step. Mirror the
# reap/fuser lines above: `sudo -n rm` clears benchagent-owned files, unprivileged `rm` is the fallback,
# and the trailing `|| true` guarantees this cleanup never aborts the step.
sudo -n rm -f /tmp/pw-results.json /tmp/dev.log /tmp/build.log 2>/dev/null || rm -f /tmp/pw-results.json /tmp/dev.log /tmp/build.log 2>/dev/null || true

if [ -n "$APP_BASE_URL" ]; then
# Record whether Playwright installed; on failure tests can't run, so emit the signal and bail.
# Both the package install AND the chromium download must succeed before the signal flips true.
if ! npm install --no-save --silent "@playwright/test@${PW_VERSION}"; then
  echo "::warning::playwright install failed; functional tests will not run"
  exit 0
fi
# Chromium is normally pre-provisioned before the agent phase (the "Provision
# Playwright chromium" workflow step, same job-level PLAYWRIGHT_BROWSERS_PATH), making this a
# cache-hit no-op. Kept (guarded) as a fallback so step 3 still works standalone; `playwright
# install` is idempotent, so it self-heals a rare miss.
if ! npx playwright install chromium > "${CELL_TMP}/pw-install.log" 2>&1; then
  echo "::warning::playwright chromium download failed; functional tests will not run"
  exit 0
fi
echo "playwright_installed=true" >> "$GITHUB_OUTPUT"

rm -rf bench-tests && mkdir -p bench-tests
cp "$TASK_DIR/test.spec.ts" bench-tests/task.spec.ts
cat > playwright.config.ts <<'EOF'
import { defineConfig } from '@playwright/test';

// Serial, single-worker: cells share one dev server whose backing store persists for the run,
// so parallel tests would race on shared state. retries: 0 for an honest pass/fail signal.
export default defineConfig({
  testDir: './bench-tests',
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
  // Report path injected via PW_RESULTS_JSON; literal fallback keeps a local run working.
  reporter: [['json', { outputFile: process.env.PW_RESULTS_JSON || '/tmp/pw-results.json' }]],
});
EOF

# Specs read BLOCKS_URL for their absolute goto(); point it (and APP_BASE_URL) at the discovered port.
# RUN_ID is a run-stable seed the specs fold into deterministic-but-unique test data; it carries TASK
# so cells sharing a run id still seed distinct data. Exported once so it's stable across navigation.
export RUN_ID="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${TASK:-x}-$(date +%s)"
BLOCKS_URL="$APP_BASE_URL" APP_BASE_URL="$APP_BASE_URL" npx playwright test 2>&1 | tee "${CELL_TMP}/pw.log" || true

if [ -f "$PW_RESULTS_JSON" ]; then
  PW_RESULTS_JSON="$PW_RESULTS_JSON" node -e '
    const fs = require("fs");
    const stats = JSON.parse(fs.readFileSync(process.env.PW_RESULTS_JSON, "utf-8")).stats ?? {};
    // Assert the field exists before the ?? fallback — a missing "expected" is an unexpected
    // reporter shape, not zero passes. Fail loudly so the pessimistic defaults are retained.
    if (stats.expected === undefined) {
      console.error("stats.expected missing — unexpected Playwright reporter shape");
      process.exit(1);
    }
    const passed = stats.expected + (stats.flaky ?? 0);
    const failed = stats.unexpected ?? 0;
    // NB: tests_total INCLUDES skipped (display); the scoring test_rate denominator EXCLUDES skipped.
    const total = passed + failed + (stats.skipped ?? 0);
    console.log("tests_passed="+passed);
    console.log("tests_failed="+failed);
    console.log("tests_total="+total);
  ' >> "$GITHUB_OUTPUT" || echo "::warning::pw-results.json parse failed or unexpected shape; defaults retained"
else
  echo "::warning::Playwright produced no ${PW_RESULTS_JSON} (probably never ran); defaults retained"
fi
else
  echo "::warning::dev server never came up (dead-server/backend-crash) — skipped Playwright to avoid masking it as invalid-URL test failures; tests stay at pessimistic defaults"
fi

# Stage the deep-failure evidence to STABLE /tmp paths for the later "analyze cell" step. CELL_TMP is
# keyed on this script's PID, so it's gone by the time analyze-cell.mjs runs — mirror how the
# trace/metrics already land at /tmp. Best-effort: a missing source or copy failure must never break
# the green-regardless exit (analyze-cell degrades to null when a file is absent). Stale copies from a
# PRIOR cell were already cleared before the Playwright guard above, so these cp's only ever add THIS
# cell's evidence.
cp "$PW_RESULTS_JSON" /tmp/pw-results.json 2>/dev/null || true
cp "${CELL_TMP}/dev.log" /tmp/dev.log 2>/dev/null || true
cp "${CELL_TMP}/build.log" /tmp/build.log 2>/dev/null || true

# Always exit 0: real failures are already captured as $GITHUB_OUTPUT signals for the judge, and a
# non-zero exit would break green-regardless.
exit 0
