#!/usr/bin/env bash
# Step 3: run `npm run build` and the task's Playwright spec against the
# running dev server. Writes the build/test/dev-server/playwright signals to
# $GITHUB_OUTPUT (the judge step folds them into EVIDENCE for its hard caps).
#
# Required env:
#   WORKSPACE     absolute path to the bench-app
#   DEV_PORT      dev server port (set by step 1)
#   TASK_DIR      absolute path to the task directory (PROMPT.md + test.spec.ts)
set -euo pipefail

: "${WORKSPACE:?WORKSPACE must be set}"
: "${DEV_PORT:?DEV_PORT must be set}"
: "${TASK_DIR:?TASK_DIR must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set (run inside GitHub Actions)}"

# Pin to the version the monorepo lockfile already resolves, so the bench
# browser/runner stay reproducible run-to-run.
PW_VERSION="1.60.0"

# Write pessimistic defaults up front, then update on success. If any step
# below fails (npm install, playwright install, the parser), the workflow
# still sees valid values and the EVIDENCE JSON in step 4 is well-formed.
{
  echo "build_succeeded=false"
  echo "dev_server_started=false"
  echo "playwright_installed=false"
  echo "tests_passed=0"
  echo "tests_failed=0"
  echo "tests_total=0"
} >> "$GITHUB_OUTPUT"

# SINGLE bounded readiness wait. The dev server was launched once in step 1; the
# agent's edits in step 2 run under a `tsx watch` that restarts it in place, so
# it may still be finishing a normal restart/boot as this step begins. Poll the
# public port until it returns any non-5xx response (cap ~180s), then move on.
# This is the ONLY wait, and it deliberately does NO relaunch, port-freeing,
# data reset, or other recovery: if a framework bug leaves the server dead — an
# orphaned frontend on :3100 after a tsx-watch restart (502 / EADDRINUSE, issue
# #78) or a half-written PGlite `.bb-data` dir — the cell must FAIL HONESTLY so
# the failure is visible and tracked, not papered over here. A non-5xx response
# means the server is genuinely serving; a 5xx (e.g. the 502 the frontend-orphan
# bug produces) is NOT ready. The trailing `|| code=000` keeps the guarded curl
# safe under `set -euo pipefail`; curl ALSO prints "000" on a transport failure,
# so the override must sit OUTSIDE the $(...) — inside, the two "000"s would
# concatenate to "000000" and the `!= "000"` test would false-positive as ready.
dev_ready=false
for i in $(seq 1 36); do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:${DEV_PORT}") || code=000
  if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then
    echo "[readiness] dev server ready (HTTP $code) on attempt $i"
    dev_ready=true
    break
  fi
  echo "[readiness] attempt $i: HTTP $code"
  sleep 5
done

# Record dev_server_started from that single wait so the judge's caps reflect
# reality instead of a hardcoded true. If the server never became ready, emit a
# brief diagnostic — the dev PID's liveness + the tail of its log — to BOTH the
# step log AND result.json (dev_pid_status / dev_log_tail), so the uploaded
# artifact records WHY it was down, then proceed so the cell fails honestly.
# RESULT_PATH matches steps 0/4/finalize (/tmp/result.json); the judge's merge
# and finalize both carry extra keys through, so this field survives into the
# final artifact.
if [ "$dev_ready" = "true" ]; then
  echo "dev_server_started=true" >> "$GITHUB_OUTPUT"
else
  echo "::warning::dev server never became ready on :${DEV_PORT} within the readiness window"
  dev_pid=""
  if [ -f /tmp/dev.pid ]; then dev_pid="$(cat /tmp/dev.pid 2>/dev/null || true)"; fi
  if [ -z "${dev_pid:-}" ]; then
    dev_pid_status="no-pidfile"
  elif kill -0 "$dev_pid" 2>/dev/null; then
    dev_pid_status="alive (pid=${dev_pid}) but not serving"
  else
    dev_pid_status="exited (pid=${dev_pid})"
  fi
  echo "[dead-server] dev pid: ${dev_pid_status}"
  if [ -f /tmp/dev.log ]; then
    dev_log_tail="$(tail -100 /tmp/dev.log 2>/dev/null || true)"
    echo "[dead-server] tail -100 /tmp/dev.log:"
    printf '%s\n' "$dev_log_tail"
  else
    dev_log_tail="(/tmp/dev.log missing)"
    echo "[dead-server] /tmp/dev.log missing"
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
fi

cd "$WORKSPACE"

if npm run build > /tmp/build.log 2>&1; then
  echo "build_succeeded=true" >> "$GITHUB_OUTPUT"
else
  tail -50 /tmp/build.log
fi

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
# Playwright's baseURL), so it must point at the actual dev port — the
# `backend` template binds :3001, not :3000.
#
# RUN_ID is a run-stable seed the specs fold into their unique-but-deterministic
# test data (usernames, file names, notes …). Exported once here so it stays
# identical across Playwright's in-process retries; the specs' uniq() helper adds
# a per-call counter + timestamp on top, so a retry still gets fresh identifiers
# instead of colliding with the data its own earlier attempt wrote.
export RUN_ID="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$(date +%s)"
BLOCKS_URL="http://localhost:${DEV_PORT}" npx playwright test 2>&1 | tee /tmp/pw.log || true

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
