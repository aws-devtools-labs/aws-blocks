// Regression test for the agent-bench shell runner's backgrounded-process
// containment — the `runShell` in steps/2-agent-run.ts and steps/4-judge.ts.
//
// Why this doesn't import runShell directly: both step modules self-execute on
// import (top-level `await agent.invoke(...)` plus required env vars) and are
// TypeScript, so the bare `node --test steps/lib/*.test.mjs` runner cannot load
// them. This test therefore pins the exact platform SEMANTICS the fix relies on,
// exercised against REAL child processes:
//
//   BUG  — a plain `spawn` that resolves on 'close' BLOCKS when the command
//          backgrounds a process (`sleep N & echo …`): the child inherits the
//          stdout/stderr pipe write-ends, and 'close' waits for EVERY stdio FD to
//          reach EOF, so it never fires until the (long-lived) child dies. This
//          is the ~600s hang from run 28549669447.
//   FIX  — spawning `detached: true` (bash leads its own process group) and
//          SIGKILLing the WHOLE group (negative pid) the moment bash itself
//          EXITs reaps the leaked child, closing those FDs so 'close' fires
//          promptly — while still resolving on 'close', so the foreground output
//          is captured intact (the vended fileEditor decodes result.stdout).
//
// The command is `sleep N & echo $!`, so bash prints the backgrounded child's
// PID on stdout — letting the fix test assert the child was actually reaped.
//
// If any of detached / group-kill-on-exit / resolve-on-close regresses, one of
// these assertions fails and the post-invoke hang is back.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';

const EXIT_DRAIN_GRACE_MS = 2000;

function isAlive(pid) {
	try {
		// signal 0 = existence/permission probe, doesn't actually signal
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// The FIX distilled: detached spawn + resolve-on-close + kill-the-group-on-exit
// (+ bounded post-exit grace). Mirrors runShell's containment mechanism.
function runContained(command, graceMs = EXIT_DRAIN_GRACE_MS) {
	return new Promise((resolve, reject) => {
		const proc = spawn('bash', ['-c', command], { detached: true });
		let stdout = '';
		let settled = false;
		let exited = false;
		let drain;
		const killGroup = () => {
			if (proc.pid === undefined) return;
			try {
				process.kill(-proc.pid, 'SIGKILL');
			} catch {
				// group already gone
			}
		};
		const settle = (fn) => {
			if (settled) return;
			settled = true;
			if (drain) clearTimeout(drain);
			killGroup();
			fn();
		};
		proc.stdout.on('data', (d) => {
			stdout += String(d);
		});
		proc.on('error', reject);
		proc.on('exit', () => {
			if (settled || exited) return;
			exited = true;
			killGroup();
			drain = setTimeout(() => settle(() => resolve({ stdout })), graceMs);
			drain.unref();
		});
		proc.on('close', () => settle(() => resolve({ stdout })));
	});
}

// The BUG distilled: naive spawn, resolve ONLY on 'close', no process group.
// Resolves { closedInTime:false } if 'close' has NOT fired within budgetMs —
// which is the hang precondition when the command backgrounds a live child.
function runNaive(command, budgetMs) {
	return new Promise((resolve) => {
		const proc = spawn('bash', ['-c', command]);
		let stdout = '';
		let closed = false;
		proc.stdout.on('data', (d) => {
			stdout += String(d);
		});
		proc.on('close', () => {
			closed = true;
			resolve({ closedInTime: true, proc, stdout });
		});
		setTimeout(() => {
			if (!closed) resolve({ closedInTime: false, proc, stdout });
		}, budgetMs).unref();
	});
}

describe('agent-bench shell runner — backgrounded-process containment', () => {
	it('resolves promptly, captures foreground output, and reaps the backgrounded child (the fix)', async () => {
		const start = Date.now();
		// Background a 30s sleep; bash echoes its PID then exits immediately.
		const { stdout } = await runContained('sleep 30 & echo $!');
		const elapsed = Date.now() - start;

		assert.ok(
			elapsed < 3000,
			`expected prompt resolution (~0s), but took ${elapsed}ms — a backgrounded child is holding 'close'`,
		);
		const bgPid = Number.parseInt(stdout.trim(), 10);
		assert.ok(Number.isInteger(bgPid) && bgPid > 0, `expected the backgrounded PID on stdout, got ${JSON.stringify(stdout)}`);

		// Allow a beat for the group SIGKILL to be delivered, then confirm the
		// leaked `sleep 30` is dead — i.e. the group-kill actually reaped it.
		await sleep(250);
		assert.equal(isAlive(bgPid), false, `backgrounded child ${bgPid} survived — group-kill did not reap it`);
	});

	it("a naive close-only wait BLOCKS on a backgrounded child (the bug it guards against)", async () => {
		const budgetMs = 1500;
		const { closedInTime, proc, stdout } = await runNaive('sleep 5 & echo $!', budgetMs);

		assert.equal(
			closedInTime,
			false,
			"naive 'close'-only wait resolved within budget — the hang precondition is unexpectedly gone",
		);

		// Cleanup so this test process can exit: release node's read-end of the
		// inherited pipe and kill the still-running background child by its PID.
		proc.stdout?.destroy();
		proc.stderr?.destroy();
		const bgPid = Number.parseInt(stdout.trim(), 10);
		if (Number.isInteger(bgPid) && bgPid > 0) {
			try {
				process.kill(bgPid, 'SIGKILL');
			} catch {
				// already gone
			}
		}
	});
});
