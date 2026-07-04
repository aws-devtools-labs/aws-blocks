// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';

// Shared process-tree teardown primitives used by every dev-tooling entrypoint
// (the dev server and the sandbox). Both spawn a long-running command with
// `shell: true`, so the real process (Vite, or the `tsx watch` dev server) is a
// grandchild of the shell. Reaping it requires killing the whole tree, not just
// the shell parent — see the per-function docs. Keeping this in one module means
// the dev server, the sandbox, and the `process.on('exit')` safety net all reap
// identically instead of hand-rolling divergent copies.

/** Minimal child-process surface needed to terminate a frontend dev server. */
export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Subset of {@link import('node:child_process').SpawnSyncReturns} that {@link windowsTreeKill} inspects. */
interface TreeKillResult {
  status: number | null;
  error?: Error;
}

/**
 * Force-kill an entire process tree on Windows via `taskkill /T /F /PID <pid>`.
 *
 * Windows has no POSIX process groups, so a bare `child.kill()` only signals the
 * spawned shell and orphans the real dev server (the Vite grandchild), which
 * keeps holding `:3100` — the very wedge the POSIX process-group kill fixes.
 * `taskkill /T` walks the live child tree by PID and terminates every
 * descendant; `/F` is required because Windows cannot deliver a graceful
 * shutdown to a non-console subtree anyway (Node maps SIGTERM/SIGKILL to
 * `TerminateProcess`).
 *
 * Returns `true` only when `taskkill` ran AND reported the tree handled — exit
 * `0` (reaped the tree) or `128` (`"process not found"`, i.e. already gone).
 * Returns `false` when the command could not be spawned at all (e.g. not on
 * `PATH`) OR when it ran but returned any other status (e.g. `1` = access
 * denied): such a run did NOT reap the tree, so the caller must fall back to a
 * direct `child.kill` rather than treat the leak as handled. (`child.kill`
 * cannot reap the orphaned grandchild either, but the fallback is cheap and
 * strictly correct — we never silently swallow a failed tree-kill.) Runs with a
 * 3s `timeout` so a wedged `taskkill` can't stall teardown; a timed-out run
 * surfaces as `{error}` and degrades to the fallback. Never throws.
 */
export function windowsTreeKill(
  pid: number,
  runner: (command: string, args: readonly string[]) => TreeKillResult = (command, args) =>
    spawnSync(command, args as string[], { stdio: 'ignore', windowsHide: true, timeout: 3000 }),
): boolean {
  try {
    const { status, error } = runner('taskkill', ['/T', '/F', '/PID', String(pid)]);
    // Couldn't even spawn taskkill (e.g. not on PATH) → not handled; fall back.
    if (error) return false;
    // taskkill ran: only exit 0 (reaped the tree) or 128 ("process not found",
    // already gone) mean the tree is handled. Any other non-null status (e.g.
    // 1 = access denied) means taskkill ran but did NOT reap the tree, so report
    // not-handled and let the caller fall back to a direct child.kill.
    return status === 0 || status === 128;
  } catch {
    return false;
  }
}

/**
 * Terminate a process spawned with `shell: true`, including its descendants, on
 * every platform.
 *
 * Under a shell the real dev server (e.g. Vite) is a **grandchild**: the direct
 * child is the shell, so signalling only the shell (`child.kill`) orphans the
 * grandchild, which keeps holding its port (`:3100`) and wedges the next
 * restart.
 *
 * - **POSIX**: the process is spawned `detached` (its own process group,
 *   pgid === child.pid), so we signal the whole group with
 *   `process.kill(-pid, signal)` and every descendant dies, freeing the port.
 * - **Windows**: there are no process groups, so we reap the tree with
 *   `taskkill /T /F /PID <pid>` (see {@link windowsTreeKill}), which walks the
 *   child tree by PID. A bare `child.kill` would leave the Vite grandchild
 *   bound to `:3100`, reproducing the POSIX wedge.
 *
 * Best-effort and never throws: a missing/invalid pid, an already-dead group
 * (ESRCH), a failed group signal, or an unavailable `taskkill` all degrade to a
 * direct `child.kill`.
 */
export function killFrontendTree(
  child: KillableProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
  killFn: (pid: number, signal: NodeJS.Signals) => void = (p, s) => process.kill(p, s),
  winTreeKill: (pid: number) => boolean = windowsTreeKill,
): void {
  const { pid } = child;
  // pid > 1 guards against signalling the whole current group (-0) or init (-1).
  if (pid && pid > 1) {
    if (platform !== 'win32') {
      try {
        killFn(-pid, signal);
        return;
      } catch {
        // Group already gone or signal failed — fall through to a direct kill.
      }
    } else if (winTreeKill(pid)) {
      // taskkill walked the PID tree and reaped the Vite grandchild.
      return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process already exited; nothing to do.
  }
}

/** Subset of a `spawnSync` result that {@link findListenerPids} inspects. */
interface CommandOutput {
  stdout?: string | null;
  status?: number | null;
  error?: Error;
}

/**
 * Find the PIDs of processes holding a TCP *listener* on `port`, so a fresh dev
 * server can reclaim a port left bound by a crashed / SIGKILL'd predecessor (its
 * orphaned backend, or a detached Vite grandchild) instead of colliding on it.
 * This mirrors the `lsof -ti:<port>` discovery the `cleanup` script already uses
 * — it does NOT introduce a new port-to-PID mechanism.
 *
 * - **POSIX**: `lsof -ti tcp:<port> -sTCP:LISTEN` — `-t` prints bare PIDs and the
 *   `-sTCP:LISTEN` state filter restricts the match to the *listener*, so a
 *   transient client socket on the same port is never targeted.
 * - **Windows**: `netstat -ano -p tcp`, keeping the trailing PID column of
 *   `LISTENING` rows whose local address ends in `:<port>`.
 *
 * Best-effort and never throws: a missing tool, a non-zero exit ("nothing is
 * listening"), or unparseable output all yield `[]`. The `spawnSync` runs with a
 * 3s `timeout` so a hung `lsof`/`netstat` (e.g. an unresponsive NFS mount) can't
 * block the event loop during startup — a timed-out probe returns `{error}`,
 * which the `catch` degrades to `[]`. PIDs `<= 1` are dropped
 * defensively (never target init / the whole current group). `runner`/`platform`
 * are injected for tests.
 */
export function findListenerPids(
  port: number,
  runner: (command: string, args: readonly string[]) => CommandOutput = (command, args) =>
    spawnSync(command, args as string[], { encoding: 'utf-8', windowsHide: true, timeout: 3000 }),
  platform: NodeJS.Platform = process.platform,
): number[] {
  try {
    const pids = new Set<number>();
    if (platform === 'win32') {
      const { stdout } = runner('netstat', ['-ano', '-p', 'tcp']);
      if (!stdout) return [];
      for (const line of stdout.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        // Columns: Proto  Local-Address  Foreign-Address  State  PID
        const cols = line.trim().split(/\s+/);
        const local = cols[1] ?? '';
        if (!local.endsWith(`:${port}`)) continue;
        const pid = Number(cols[cols.length - 1]);
        if (Number.isInteger(pid) && pid > 1) pids.add(pid);
      }
      return [...pids];
    }
    const { stdout } = runner('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    if (!stdout) return [];
    for (const token of stdout.split(/\s+/)) {
      const pid = Number(token.trim());
      if (Number.isInteger(pid) && pid > 1) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

/**
 * Force-terminate whatever process (and, on POSIX, its process group) currently
 * holds a port — used by the dev server's startup / EADDRINUSE *reclaim* path on
 * a PID discovered via {@link findListenerPids}, i.e. a process this dev server
 * did NOT spawn. Reuses {@link killFrontendTree} (POSIX `-pid` group kill /
 * Windows `taskkill /T`, with a direct-`kill` fallback) so reclaim reaps exactly
 * like our own frontend teardown — no bespoke kill mechanism. Best-effort; never
 * throws (a since-exited PID just yields ESRCH, swallowed by killFrontendTree).
 */
export function killListenerTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
  killFn: (pid: number, signal: NodeJS.Signals) => void = (p, s) => process.kill(p, s),
  winTreeKill: (pid: number) => boolean = windowsTreeKill,
): void {
  killFrontendTree(
    {
      pid,
      kill: (s) => {
        try {
          process.kill(pid, s ?? signal);
          return true;
        } catch {
          return false;
        }
      },
    },
    signal,
    platform,
    killFn,
    winTreeKill,
  );
}

/** Child surface {@link terminateProcessTree} needs: a tree to kill plus exit state to await. */
export interface AwaitableChild extends KillableProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: 'exit', listener: () => void): unknown;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((res) => {
    setTimeout(res, ms).unref?.();
  });

/**
 * Grace (ms) we wait for the child's `exit` event *after* SIGKILL before giving
 * up and reporting its last-known exit state. Deliberately shorter than — and
 * intentionally decoupled from — the injectable SIGTERM `graceMs`: SIGKILL
 * cannot be caught, blocked, or handled, so the child is already being
 * force-terminated; we only need a brief beat to observe the `exit` event, not a
 * full, tunable shutdown window. Fixed (not a parameter) because no caller needs
 * to tune it — the injected `sleep` is the test seam.
 */
export const KILL_GRACE_MS = 500;

/**
 * Probe whether a detached process *group* still has at least one live member,
 * **without signalling it**. Used to scope the post-exit group SIGKILL in
 * {@link terminateProcessTree} to the only window where the `-pid` group signal
 * is PID-reuse-safe.
 *
 * The hazard: {@link killFrontendTree}'s POSIX reap is `process.kill(-pid, …)`,
 * which targets the process group whose gid is `pid`. That is safe only while a
 * group member is still alive — a survivor keeps the kernel from recycling
 * `pid` as a brand-new (unrelated) group leader. Once the whole group has
 * drained, `pid` is eligible for reuse and a blind `-pid` kill could land on an
 * unrelated group. So before a *post-exit* reap we probe here and skip when the
 * group has already drained (there is then nothing of ours left to reap).
 *
 * - **POSIX**: `kill(-pid, 0)` sends no signal — it only checks the group
 *   exists and is signallable. Success or `EPERM` (exists but owned by another
 *   user) ⇒ alive. `ESRCH` (or anything else) ⇒ treat as drained.
 * - **Windows**: there are no process groups and the reap path
 *   (`taskkill /T /F /PID`) walks the live PID tree, so there is no `-pid`
 *   recycle hazard — always allow the reap (`true`).
 *
 * Never throws. `platform`/`kill` are injected for tests.
 */
export function isProcessGroupAlive(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  kill: (pid: number, signal: number) => void = (p, s) => process.kill(p, s),
): boolean {
  if (platform === 'win32') return true;
  try {
    kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Terminate a child process *tree* and wait — bounded — for the child to exit,
 * escalating SIGTERM → SIGKILL. Reuses {@link killFrontendTree} so every
 * entrypoint reaps the same way (POSIX process-group kill / Windows `taskkill`)
 * instead of hand-rolling its own group kill.
 *
 * Post-exit policy: if the child has *already* exited, a detached grandchild may
 * still be orphaned (still holding a port), so we issue one best-effort group
 * SIGKILL to reap it — but ONLY when the group still has a live member
 * ({@link isProcessGroupAlive}). When the whole group has already drained (the
 * common healthy shutdown — Vite was already gone), `pid` is eligible for
 * recycling and a blind `-pid` signal could hit an unrelated, newly created
 * group; since there is also nothing of ours left to reap, we skip the kill.
 * See the dev server's "POST-EXIT GROUP-KILL POLICY" for the full rationale and
 * the accepted residual (the synchronous probe→kill window). Otherwise we
 * SIGTERM the tree, wait up to `graceMs` for a clean exit, then SIGKILL the tree
 * and wait a short grace.
 *
 * Return value — IMPORTANT: the boolean reflects only the **direct child's**
 * exit state (its `exitCode`/`signalCode`), NOT whole-group teardown or port
 * release. On POSIX the SIGKILL is delivered to the whole group (`-pid`), but a
 * surviving *detached grandchild* can outlive the awaited child and keep holding
 * a port even after this resolves `true`. So `true` means only "the child we
 * awaited has exited (or was already gone)" and `false` means "it was still
 * alive when the budget elapsed" — neither guarantees the port is free. Callers
 * that need a freed port MUST follow this with a bounded port-free wait (see
 * `waitForPortFree` in dev-server.ts, which the dev-server child's own SIGTERM
 * handler runs). Dependencies are injected for tests.
 */
export async function terminateProcessTree(
  child: AwaitableChild,
  graceMs = 2000,
  killTree: (c: KillableProcess, signal: NodeJS.Signals) => void = killFrontendTree,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  isGroupAlive: (pid: number) => boolean = isProcessGroupAlive,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    // ── POST-EXIT GROUP-KILL (scoped) ──────────────────────────────────────
    // The direct child has already exited, but a detached *grandchild* (e.g. an
    // orphaned Vite) may still be alive in its process group, still holding a
    // port — reap it with one best-effort group SIGKILL.
    //
    // SCOPING: only reap when the group still has a live member. killFrontendTree's
    // `-pid` group signal is PID-reuse-safe ONLY while a member keeps `pid`
    // reserved as the group id; once the whole group has drained `pid` can be
    // recycled and a blind `process.kill(-pid)` could hit an unrelated group. So
    // we probe first (isProcessGroupAlive; POSIX signal 0) and skip when already
    // drained — there is then nothing of ours to reap. The residual synchronous
    // probe→kill window is the accepted trade-off documented in dev-server.ts
    // "POST-EXIT GROUP-KILL POLICY", cross-referenced here so the risk is
    // discoverable at this shared primitive.
    const { pid } = child;
    if (pid && pid > 1 && isGroupAlive(pid)) {
      killTree(child, 'SIGKILL');
    }
    return true;
  }
  const exited = new Promise<void>((res) => child.once('exit', () => res()));
  killTree(child, 'SIGTERM');
  const exitedCleanly = await Promise.race([
    exited.then(() => true),
    sleep(graceMs).then(() => false),
  ]);
  if (exitedCleanly) return true;
  killTree(child, 'SIGKILL');
  // Shorter, fixed grace after SIGKILL (vs. the injectable SIGTERM graceMs):
  // SIGKILL is uncatchable, so we only need a brief beat to observe `exit`.
  await Promise.race([exited, sleep(KILL_GRACE_MS)]);
  return child.exitCode !== null || child.signalCode !== null;
}
