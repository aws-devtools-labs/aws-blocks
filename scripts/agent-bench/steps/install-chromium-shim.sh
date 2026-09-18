#!/usr/bin/env bash
# Wrap the system chromium so the agent's own ad-hoc `/usr/bin/chromium --headless` CDP launches
# start cleanly in this runner. Without the flags below chromium aborts at startup on its crashpad
# handler (chrome_crashpad_handler: --database is required -> FATAL crashpad_linux.cc Check failed),
# which the agent then wastes cycles working around by hand. This wraps only the system-PATH
# binaries; the verifier's Playwright run resolves chromium from PLAYWRIGHT_BROWSERS_PATH and
# already passes these flags itself via launchOptions.args in the generated playwright.config.ts.
# A PATH shim is not enough: the agent calls chromium by ABSOLUTE path more often than by name, so
# the real binary FILE itself is replaced (its bytes moved aside to <file>.real) and the wrapper
# forwards to that. The three names (chromium / chromium-browser / google-chrome) are usually
# symlinks onto one real file, so we wrap each DISTINCT real file once; the symlinks then hit it.
set -euo pipefail

# Flags that make headless chromium start cleanly here. Crashpad off (no --database/socket in
# this sandbox), breakpad off, /dev/shm not required (small on the runner), gpu off. Prepended to
# every launch; a caller that also passes one of these (e.g. the verifier config's
# --disable-dev-shm-usage) just repeats it, which chromium accepts harmlessly.
SHIM_FLAGS='--disable-crashpad --no-crash-upload --disable-breakpad --disable-dev-shm-usage --disable-gpu'

wrap_real() {
  local real="$1"                       # an already-resolved real binary path
  local saved="${real}.real"

  # Idempotent: our own wrapper leaves <real>.real beside it, so its presence means done.
  [ -e "$saved" ] && return 0
  # Never wrap a file that is itself a saved-aside real binary.
  case "$real" in *.real) return 0 ;; esac

  mv "$real" "$saved"
  cat > "$real" <<EOF
#!/usr/bin/env bash
# Auto-generated chromium wrapper (agent-bench): inject startup flags, then exec the real binary.
exec "${saved}" ${SHIM_FLAGS} "\$@"
EOF
  chmod +x "$real"
}

# Resolve each name to its real file, dedupe, and wrap each distinct real file once. Symlinks
# among the names are left as-is: they already resolve to the (now-wrapped) real file.
seen=" "
for name in chromium chromium-browser google-chrome; do
  bin="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$bin" ] || continue
  real="$(readlink -f "$bin")"
  [ -n "$real" ] || continue
  case "$seen" in *" $real "*) continue ;; esac
  seen="$seen$real "
  wrap_real "$real"
done

echo "chromium shim installed:"
for name in chromium chromium-browser google-chrome; do
  bin="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$bin" ] && head -3 "$(readlink -f "$bin")" 2>/dev/null | sed "s/^/  $name: /"
done
