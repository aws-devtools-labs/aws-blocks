// The builder's INCREMENTAL partial-envelope checkpoint — factored out of
// 2-agent-run.ts so the round-trip is unit-testable under bare `node --test`
// (importing 2-agent-run.ts would execute the whole top-level agent script).
//
// WHY THIS EXISTS: the SIGTERM flush in 2-agent-run.ts only preserves token
// spend when the process is killed GRACEFULLY (a catchable SIGTERM whose handler
// runs to completion). When the agent's vended `bash` issues a broad
// process-group / `pkill` storm at a dying dev server, it can tear down the
// parent harness (npx tsx) itself with an UNGRACEFUL signal that never runs the
// handler — leaving result.json with the step-0 zeros (tokens_in/out=0, no
// trace), which both masks the (often large) spend that triggered the thrash and
// (before the classification fix) silently dragged the mean. Persisting a running
// checkpoint every model cycle means even such an abrupt kill leaves the LAST
// checkpoint on disk: nonzero tokens + a partial cycle count, regardless of how
// the process died. The terminal exit paths (SIGTERM flush / invoke-exhausted
// sentinel / normal finish) OVERWRITE this checkpoint with a real stop_reason, so
// a genuine timeout is unaffected and stays agent_fail (INCLUDED in the mean).
import { renameSync, writeFileSync } from 'node:fs';
import { CHECKPOINT_STOP_REASON } from './scoring.mjs';

/**
 * Build the running-checkpoint envelope written every model cycle. Shape mirrors
 * the terminal envelopes 2-agent-run.ts writes (model / duration_sec / tokens /
 * cycle_count / final_message) so finalize-result folds it identically — but with
 * the NON-terminal {@link CHECKPOINT_STOP_REASON} stop_reason and `checkpoint:true`
 * so scoring can tell it apart from a graceful terminal exit. A surviving
 * checkpoint therefore classifies as harness_error (EXCLUDED) while still carrying
 * the tokens so the cost signal is preserved.
 * @param {{model: string, startedMs: number, tokensIn: number, tokensOut: number, cycles: number, now?: number}} state
 * @returns {{model: string, duration_sec: number, tokens_in: number, tokens_out: number, stop_reason: string, cycle_count: number, final_message: string, partial: true, checkpoint: true}}
 */
export function buildCheckpointEnvelope(state) {
	const now = typeof state.now === 'number' ? state.now : Date.now();
	return {
		model: state.model,
		duration_sec: Math.round((now - state.startedMs) / 1000),
		tokens_in: state.tokensIn,
		tokens_out: state.tokensOut,
		stop_reason: CHECKPOINT_STOP_REASON,
		cycle_count: state.cycles,
		final_message: '',
		partial: true,
		checkpoint: true,
	};
}

/**
 * Persist `envelope` to `path` ATOMICALLY: write a sibling `.tmp` then rename it
 * over the target. rename(2) is atomic on the same filesystem, so a kill at any
 * instant leaves a reader seeing EITHER the previous checkpoint OR the new one —
 * never a torn / half-written JSON. This matters precisely because the whole
 * point of the checkpoint is to survive an abrupt kill.
 * @param {string} path destination (the builder envelope OUTPUT)
 * @param {object} envelope the JSON-serializable envelope to write
 * @returns {void}
 */
export function writeEnvelopeAtomic(path, envelope) {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(envelope, null, 2));
	renameSync(tmp, path);
}
