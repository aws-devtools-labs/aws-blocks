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
 * Returns `true` when `taskkill` actually ran — whether it reaped the tree or
 * found it already gone (exit 128) — and `false` only when the command could
 * not be spawned at all (e.g. not on `PATH`), signalling the caller to fall
 * back to a direct `child.kill`. Never throws.
 */
export function windowsTreeKill(
  pid: number,
  runner: (command: string, args: readonly string[]) => TreeKillResult = (command, args) =>
    spawnSync(command, args as string[], { stdio: 'ignore', windowsHide: true }),
): boolean {
  try {
    const { error } = runner('taskkill', ['/T', '/F', '/PID', String(pid)]);
    return !error;
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
 * Terminate a child process *tree* and wait — bounded — for the child to exit,
 * escalating SIGTERM → SIGKILL. Reuses {@link killFrontendTree} so every
 * entrypoint reaps the same way (POSIX process-group kill / Windows `taskkill`)
 * instead of hand-rolling its own group kill.
 *
 * Post-exit policy: if the child has *already* exited, a detached grandchild may
 * still be orphaned (still holding a port), so we issue one best-effort group
 * SIGKILL to reap it rather than returning blind — see the dev server's
 * "POST-EXIT GROUP-KILL POLICY". Otherwise we SIGTERM the tree, wait up to
 * `graceMs` for a clean exit, then SIGKILL the tree and wait a short grace.
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
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    // Shell already exited — a detached grandchild may still hold its port, so
    // reap the group best-effort instead of returning blind.
    killTree(child, 'SIGKILL');
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
