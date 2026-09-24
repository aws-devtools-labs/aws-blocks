#!/usr/bin/env bash
# Wrap the system chromium so the agent's own ad-hoc `/usr/bin/chromium --headless` CDP launches
# start cleanly in this runner. Without the flags below chromium aborts at startup on its crashpad
# handler (chrome_crashpad_handler: --database is required -> FATAL crashpad_linux.cc Check failed),
# which the agent then wastes cycles working around by hand. This wraps both the system-PATH
# chromium names AND the Playwright-installed binary under PLAYWRIGHT_BROWSERS_PATH, since a stock
# runner may have no system chromium on PATH (the verifier's own Playwright run also passes these
# flags via launchOptions.args, so it is unaffected either way).
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
  # Write the wrapper to a temp file beside the target, make it executable, then atomically mv it
  # into place — so an interrupt/failure between steps never leaves the real path half-written
  # (a moved-aside original with a missing or non-executable replacement).
  local tmp="${real}.wrap.$$"
  cat > "$tmp" <<EOF
#!/usr/bin/env bash
# Auto-generated chromium wrapper (agent-bench): inject startup flags on the TOP-LEVEL launch only,
# then exec the real binary. Chromium re-launches itself (same path, now this wrapper) for its
# zygote/renderer/gpu children, always passing --type=<role>; those already inherit the parent's
# flags, so we skip injection when --type is present to avoid a wider blast radius on every fork.
for arg in "\$@"; do
  case "\$arg" in --type=*|--type) exec "${saved}" "\$@" ;; esac
done
exec "${saved}" ${SHIM_FLAGS} "\$@"
EOF
  chmod +x "$tmp"
  mv "$tmp" "$real"
}

# Resolve each name to its real file, dedupe, and wrap each distinct real file once. Symlinks
# among the names are left as-is: they already resolve to the (now-wrapped) real file.
#
# Candidates: the three PATH names, PLUS the Playwright-installed browser under
# PLAYWRIGHT_BROWSERS_PATH. On a stock GitHub-hosted runner there may be no system chromium on
# PATH, so wrapping only PATH names would silently no-op and leave the agent's ad-hoc launches
# unwrapped; the Playwright binary is the one that is reliably present after `playwright install`.
candidates=""
for name in chromium chromium-browser google-chrome; do
  bin="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$bin" ] && candidates="$candidates $bin"
done
# Playwright's chromium: PLAYWRIGHT_BROWSERS_PATH/chromium-*/chrome-linux/chrome (glob may miss).
if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  for pw in "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux/chrome; do
    [ -x "$pw" ] && candidates="$candidates $pw"
  done
fi

seen=" "
for bin in $candidates; do
  # readlink's non-zero exit on an unresolvable path is intentionally swallowed here: under set -e
  # a command substitution's exit status does not trip the shell, and the [ -n ] / [ -e ] guards
  # below handle the empty/missing case. Keep the readlink inside the $(...) if refactoring.
  real="$(readlink -f "$bin")"
  [ -n "$real" ] || continue
  [ -e "$real" ] || continue   # skip a resolved-but-missing target so wrap_real's mv can't act on a stale path
  case "$seen" in *" $real "*) continue ;; esac
  seen="$seen$real "
  wrap_real "$real"
done

echo "chromium shim installed:"
for bin in $candidates; do
  real="$(readlink -f "$bin" 2>/dev/null)"
  [ -n "$real" ] && head -3 "$real" 2>/dev/null | sed "s#^#  $bin -> #"
done
