#!/usr/bin/env bash
# Step 3 (verifier): run `npm run build`, then launch the dev server FRESH and
# run the task's Playwright spec against it. This step OWNS the dev server: the
# agent's edit phase (step 2) ran with no server bound, so here we free the
# candidate ports, start `npm run dev`, robustly discover the port it actually
# binds, and point Playwright at it via APP_BASE_URL. Writes the
# build/dev-server/playwright/test signals to $GITHUB_OUTPUT (the judge step
# folds them into EVIDENCE for its hard caps).
#
# Required env:
#   WORKSPACE     absolute path to the bench-app
#   TASK_DIR      absolute path to the task directory (PROMPT.md + test.spec.ts)
# The dev port is NO LONGER passed in — it is discovered internally below.
set -euo pipefail

: "${WORKSPACE:?WORKSPACE must be set}"
: "${TASK_DIR:?TASK_DIR must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set (run inside GitHub Actions)}"

# Pin to the version the monorepo lockfile already resolves, so the bench
# browser/runner stay reproducible run-to-run.
PW_VERSION="1.60.0"

# Write pessimistic defaults up front, then update on success. If any step
# below fails (npm install, playwright install, the parser), the workflow
# still sees valid values and the EVIDENCE JSON in step 4 is well-formed.
# build_status is the tri-state the judge's build-cap keys off (na|ok|failed);
# its pessimistic default is "failed" so an early abort still caps, matching
# build_succeeded=false. The build step below overwrites BOTH on every path
# (GITHUB_OUTPUT is last-write-wins per key).
{
  echo "build_succeeded=false"
  echo "build_status=failed"
  echo "dev_server_started=false"
  echo "playwright_installed=false"
  echo "tests_passed=0"
  echo "tests_failed=0"
  echo "tests_total=0"
} >> "$GITHUB_OUTPUT"

# The dev server is launched + discovered further below (after the build), since
# this verifier now OWNS the server. First make sure the workspace exists and cd
# into it — the build and the dev launch both need to run from the bench-app root.
cd "$WORKSPACE" || {
  # A missing workspace (e.g. the agent never produced bench-app) must not hard-abort
  # this step: the pessimistic defaults written to $GITHUB_OUTPUT above already record
  # build_status=failed / dev_server_started=false / tests_*=0, so honour the step's
  # exit-0 green-regardless guarantee rather than masking it as a job failure.
  echo "::warning::workspace missing at $WORKSPACE — recording pessimistic build/test signals and skipping"
  exit 0
}

# Build detection (scoring correctness). Some templates (e.g. backend/tsx) ship
# NO `build` script, so a bare `npm run build` prints `npm error Missing script:
# "build"` and exits non-zero. Recording THAT as build_succeeded=false wrongly
# caps the judge's functional_completeness (observability-api was capped to 3
# despite 18/18 tests). So FIRST confirm package.json is readable, THEN detect
# whether a `build` script exists:
#   - package.json missing/malformed → build_status=failed, build_succeeded=false
#                           (a broken workspace IS a build failure; cap preserved).
#   - no `build` script   → build is N/A: build_status=na, build_succeeded=true
#                           (not a failure; step 4 applies NO build-cap).
#   - `build` exists, ok  → build_status=ok,     build_succeeded=true.
#   - `build` exists, !=0 → build_status=failed, build_succeeded=false — a REAL
#                           failure (e.g. file-gallery's `tsc` type errors), whose
#                           cap is intentionally preserved.
# The readability probe (`node -e 'require("./package.json")'`) THROWS on a
# missing/malformed file; without it that throw would look identical to "no
# build script" and wrongly skip the cap. The second `node -e` exits 0 iff
# scripts.build is a non-empty string. Guarded `if`s keep both safe under `set -e`.
if ! node -e 'require("./package.json")' 2>/dev/null; then
  echo "::warning::package.json missing or malformed — treating as build failure"
  {
    echo "build_status=failed"
    echo "build_succeeded=false"
  } >> "$GITHUB_OUTPUT"
elif node -e 'process.exit(require("./package.json").scripts?.build ? 0 : 1)'; then
  if npm run build > /tmp/build.log 2>&1; then
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
    tail -50 /tmp/build.log
  fi
else
  echo "[build] no \`build\` script in package.json — build is N/A for this template (not a failure)"
  {
    echo "build_status=na"
    echo "build_succeeded=true"
  } >> "$GITHUB_OUTPUT"
fi

# ── Dev server: launch fresh + robustly discover its bound port ──────────────
# The verifier OWNS the server now (step 1 no longer starts one, so the agent's
# edit phase ran with nothing bound). Free the candidate ports first (kill
# anything the agent may have left — the old tsx-watch/EADDRINUSE flakiness),
# launch `npm run dev` in the background, then discover the port it ACTUALLY
# binds. Discovery is belt-and-suspenders: (a) poll each candidate port for a
# real HTTP response (<500), and (b) parse the dev log for a "listening on
# :<port>" line and verify THAT port responds — first hit wins. Bounded (~60s):
# if nothing serves we record dev_server_started=false and PROCEED
# (green-regardless — the cell fails honestly rather than hanging or hard-failing).
for p in 3000 3001 3100; do fuser -k "${p}/tcp" 2>/dev/null || true; done
sleep 1

nohup npm run dev > /tmp/dev.log 2>&1 &
echo $! > /tmp/dev.pid

CANDIDATE_PORTS="3000 3001 3100"
APP_BASE_URL=""
for i in $(seq 1 60); do
  # (a) direct probe: first candidate port returning a real HTTP status <500.
  # `|| code=000` sits OUTSIDE $(...) so a transport failure reads as one "000"
  # (curl also prints "000" itself) rather than concatenating to a false ready.
  for port in $CANDIDATE_PORTS; do
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:${port}") || code=000
    if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then
      APP_BASE_URL="http://localhost:${port}"
      echo "[discover] dev server serving on :${port} (HTTP $code) after ${i}s"
      break
    fi
  done
  [ -n "$APP_BASE_URL" ] && break
  # (b) log fallback: a "listening on"/":<port>" line names the bound port; only
  # accept it once that port actually answers (guards against matching a PID/etc).
  if [ -f /tmp/dev.log ]; then
    log_port=$(grep -oiE '(listening on|localhost:|:)[[:space:]]*[0-9]{4,5}' /tmp/dev.log 2>/dev/null | grep -oE '[0-9]{4,5}' | tail -1 || true)
    if [ -n "${log_port:-}" ]; then
      code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:${log_port}") || code=000
      if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then
        APP_BASE_URL="http://localhost:${log_port}"
        echo "[discover] dev server serving on :${log_port} (from dev.log, HTTP $code) after ${i}s"
        break
      fi
    fi
  fi
  sleep 1
done

if [ -n "$APP_BASE_URL" ]; then
  echo "dev_server_started=true" >> "$GITHUB_OUTPUT"
  echo "[discover] APP_BASE_URL=${APP_BASE_URL}"
else
  # No port ever served within the bounded window. Record the signal (already
  # defaulted to false above) + a brief diagnostic (pid liveness + log tail) onto
  # result.json, then PROCEED: the specs run against the :3000 fallback and fail
  # honestly. RESULT_PATH matches steps 0/4/finalize; extra keys are carried through.
  echo "::warning::dev server never became ready on any candidate port within ~60s"
  dev_pid=""; [ -f /tmp/dev.pid ] && dev_pid="$(cat /tmp/dev.pid 2>/dev/null || true)"
  if [ -z "${dev_pid:-}" ]; then dev_pid_status="no-pidfile"
  elif kill -0 "$dev_pid" 2>/dev/null; then dev_pid_status="alive (pid=${dev_pid}) but not serving"
  else dev_pid_status="exited (pid=${dev_pid})"; fi
  echo "[dead-server] dev pid: ${dev_pid_status}"
  if [ -f /tmp/dev.log ]; then
    dev_log_tail="$(tail -100 /tmp/dev.log 2>/dev/null || true)"
    echo "[dead-server] tail -100 /tmp/dev.log:"; printf '%s\n' "$dev_log_tail"
  else
    dev_log_tail="(/tmp/dev.log missing)"; echo "[dead-server] /tmp/dev.log missing"
  fi
  RESULT_PATH="${RESULT_PATH:-/tmp/result.json}" DEV_PID_STATUS="$dev_pid_status" DEV_LOG_TAIL="$dev_log_tail" node -e '
    const fs = require("fs");
    const p = process.env.RESULT_PATH;
    let r = {};
    try { r = JSON.parse(fs.readFileSync(p, "utf-8")); } catch {}
    r.dev_log_tail = process.env.DEV_LOG_TAIL || "";
    r.dev_pid_status = process.env.DEV_PID_STATUS || "";
    fs.writeFileSync(p, JSON.stringify(r, null, 2));
  ' || echo "::warning::failed to record dev_log_tail on result.json"
  APP_BASE_URL="http://localhost:3000"
fi
export APP_BASE_URL

# Record whether Playwright installed. On failure tests can't run, so we emit
# the signal and bail — the judge treats playwright_installed=false explicitly
# rather than mistaking the resulting tests_total=0 for "no caps needed".
# Both the package install AND the browser download must succeed before the
# signal flips true; a failed chromium download would otherwise leave specs
# unable to run while playwright_installed wrongly claimed true.
if ! npm install --no-save --silent "@playwright/test@${PW_VERSION}"; then
  echo "::warning::playwright install failed; functional tests will not run"
  exit 0
fi
if ! npx playwright install chromium > /tmp/pw-install.log 2>&1; then
  echo "::warning::playwright chromium download failed; functional tests will not run"
  exit 0
fi
echo "playwright_installed=true" >> "$GITHUB_OUTPUT"

mkdir -p bench-tests
cp "$TASK_DIR/test.spec.ts" bench-tests/task.spec.ts
cat > playwright.config.ts <<EOF
import { defineConfig } from '@playwright/test';

// Serial, single-worker: cells share one dev server whose backing store
// (KVStore / SQL / DSQL) persists for the whole run, so parallel tests would
// race on that shared state. One retry absorbs first-load / realtime-propagation
// flake; the specs' run-stable unique identity keeps a retry from colliding with
// the data its own earlier attempt wrote.
export default defineConfig({
  testDir: './bench-tests',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 60_000,
  globalTimeout: 600_000,
  expect: { timeout: 15_000 },
  use: {
    // The discovered dev-server URL (exported as APP_BASE_URL by this step).
    // The specs use their own absolute goto() via BLOCKS_URL (set on the run
    // line below to the same value); baseURL is set too so any relative
    // navigation also resolves against the real port.
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
  reporter: [['json', { outputFile: '/tmp/pw-results.json' }]],
});
EOF

# The specs read BLOCKS_URL for their absolute goto() (they don't rely on
# Playwright's baseURL). Point it at the port the verifier discovered above
# (APP_BASE_URL); pass APP_BASE_URL through too so the config's baseURL resolves.
#
# RUN_ID is a run-stable seed the specs fold into their unique-but-deterministic
# test data (usernames, file names, notes …). Exported once here so it stays
# identical across Playwright's in-process retries; the specs' uniq() helper adds
# a per-call counter + timestamp on top, so a retry still gets fresh identifiers
# instead of colliding with the data its own earlier attempt wrote.
export RUN_ID="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$(date +%s)"
BLOCKS_URL="$APP_BASE_URL" APP_BASE_URL="$APP_BASE_URL" npx playwright test 2>&1 | tee /tmp/pw.log || true

if [ -f /tmp/pw-results.json ]; then
  node -e "
    const fs = require('fs');
    const stats = JSON.parse(fs.readFileSync('/tmp/pw-results.json', 'utf-8')).stats ?? {};
    // Assert the field exists before the ?? fallback — a missing 'expected'
    // means an unexpected reporter shape, not zero passes. Fail loudly so the
    // pessimistic defaults are retained instead of silently reporting 0/0.
    if (stats.expected === undefined) {
      console.error('stats.expected missing — unexpected Playwright reporter shape');
      process.exit(1);
    }
    const passed = stats.expected + (stats.flaky ?? 0);
    const failed = stats.unexpected ?? 0;
    // NB: tests_total INCLUDES skipped (for display); the scoring denominator test_rate in lib/scoring.mjs EXCLUDES skipped (passed+failed only).
    const total = passed + failed + (stats.skipped ?? 0);
    console.log('tests_passed='+passed);
    console.log('tests_failed='+failed);
    console.log('tests_total='+total);
  " >> "$GITHUB_OUTPUT" || echo "::warning::pw-results.json parse failed or unexpected shape; defaults retained"
else
  echo "::warning::Playwright produced no /tmp/pw-results.json (probably never ran); defaults retained"
fi

# Always exit 0: this step records signals to $GITHUB_OUTPUT for the judge's
# hard caps; a non-zero exit here would fail the job and break the
# green-regardless guarantee. Every real failure is already captured as a signal
# (build_status / dev_server_started / tests_*), so the step itself must not abort.
exit 0
