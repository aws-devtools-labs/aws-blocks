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

# ── Dev server: launch fresh + discover its port from the framework banner ───
# The verifier OWNS the server. Step 2 may have left a `tsx watch` supervisor alive, so first reap
# that tree and free the front-door ports (3000/3001 only, never :3100). Under shell isolation the
# agent's procs are benchagent-owned, so reap/free/probe go through sudo (unprivileged fallback).
# Discovery anchors on the exact banner `AWS Blocks local server running on http://localhost:<port>`,
# then a readiness gate waits (~60s) for it to answer HTTP <500; if it never does, APP_BASE_URL stays
# empty and we proceed (the cell fails honestly rather than hanging).

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

for p in 3000 3001; do sudo -n fuser -k "${p}/tcp" 2>/dev/null || fuser -k "${p}/tcp" 2>/dev/null || true; done
for i in $(seq 1 10); do
  # Probe via sudo too: an isolated squatter is benchagent-owned and invisible to an unprivileged fuser.
  { sudo -n fuser 3000/tcp 3001/tcp >/dev/null 2>&1 || fuser 3000/tcp 3001/tcp >/dev/null 2>&1; } || break
  # Still held — re-issue the privileged kill before waiting.
  for p in 3000 3001; do sudo -n fuser -k "${p}/tcp" 2>/dev/null || fuser -k "${p}/tcp" 2>/dev/null || true; done
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

nohup npm run dev > "${CELL_TMP}/dev.log" 2>&1 &
echo "$!" > "${CELL_TMP}/dev.pid"

APP_BASE_URL=""
for i in $(seq 1 60); do
  port=$(grep -oE 'AWS Blocks local server running on http://localhost:[0-9]+' "${CELL_TMP}/dev.log" 2>/dev/null | grep -oE '[0-9]+$' | head -1 || true)
  if [ -n "${port:-}" ]; then
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:${port}") || code=000
    if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then
      APP_BASE_URL="http://localhost:${port}"
      echo "[discover] dev server ready on :${port} (HTTP $code) after ${i}s"
      break
    fi
  fi
  sleep 1
done

if [ -n "$APP_BASE_URL" ]; then
  echo "dev_server_started=true" >> "$GITHUB_OUTPUT"
  echo "[discover] APP_BASE_URL=${APP_BASE_URL}"
else
  # Banner never appeared / port never became ready within the window. Record the signal + a brief
  # diagnostic (pid liveness + log tail) onto result.json, then proceed with APP_BASE_URL empty.
  echo "::warning::dev server banner never appeared / port never became ready within ~60s"
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
if [ -n "$APP_BASE_URL" ]; then
# Record whether Playwright installed; on failure tests can't run, so emit the signal and bail.
# Both the package install AND the chromium download must succeed before the signal flips true.
if ! npm install --no-save --silent "@playwright/test@${PW_VERSION}"; then
  echo "::warning::playwright install failed; functional tests will not run"
  exit 0
fi
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
# the green-regardless exit (analyze-cell degrades to null when a file is absent). Clear any stale
# copies from a PRIOR cell first (runner-agnostic) so a skipped / again-missing source can't leave the
# previous cell's evidence in place for analyze-cell to misread.
# /tmp is sticky (+t): a stale copy from a PRIOR cell may be benchagent-owned (the agent's isolated
# phase wrote it), so a plain `rm` as the runner uid hits EPERM and — under `set -e` — would abort the
# step BEFORE the green-regardless `exit 0` below, mis-recording a cell that actually built + passed.
# Mirror the reap/fuser lines above: `sudo -n rm` clears benchagent-owned files, unprivileged `rm` is
# the fallback, and the trailing `|| true` guarantees this cleanup never aborts the step.
sudo -n rm -f /tmp/pw-results.json /tmp/dev.log /tmp/build.log 2>/dev/null || rm -f /tmp/pw-results.json /tmp/dev.log /tmp/build.log 2>/dev/null || true
cp "$PW_RESULTS_JSON" /tmp/pw-results.json 2>/dev/null || true
cp "${CELL_TMP}/dev.log" /tmp/dev.log 2>/dev/null || true
cp "${CELL_TMP}/build.log" /tmp/build.log 2>/dev/null || true

# Always exit 0: real failures are already captured as $GITHUB_OUTPUT signals for the judge, and a
# non-zero exit would break green-regardless.
exit 0
