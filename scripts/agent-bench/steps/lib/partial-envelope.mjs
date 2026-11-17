// The builder's INCREMENTAL partial-envelope checkpoint, factored out of 2-agent-run.ts so it's
// unit-testable. WHY: the SIGTERM flush only preserves token spend on a GRACEFUL kill; an ungraceful
// signal (e.g. the agent's bash pkill storm tearing down the harness) never runs the handler, leaving
// result.json with step-0 zeros. Writing a checkpoint every model cycle means even an abrupt kill
// leaves nonzero tokens + a partial cycle count on disk. Terminal exits overwrite it with a real
// stop_reason, so a genuine timeout stays agent_fail (included in the mean).
import { renameSync, writeFileSync } from 'node:fs';
import { CHECKPOINT_STOP_REASON } from './scoring.mjs';

/**
 * Build the running-checkpoint envelope written every model cycle. Shape mirrors the terminal
 * envelopes so finalize-result folds it identically, but with the non-terminal
 * {@link CHECKPOINT_STOP_REASON} + `checkpoint:true` so a surviving checkpoint classifies as
 * harness_error (excluded) while still carrying tokens for the cost signal.
 * @param {{model: string, startedMs: number, tokensIn: number, tokensOut: number, cacheRead?: number, cacheWrite?: number, cycles: number, isolationActive?: boolean, now?: number}} state
 * @returns {{model: string, duration_sec: number, tokens_in: number, tokens_out: number, cache_read_tokens: number, cache_write_tokens: number, stop_reason: string, cycle_count: number, final_message: string, partial: true, checkpoint: true, isolation_active: boolean}}
 */
export function buildCheckpointEnvelope(state) {
	const now = typeof state.now === 'number' ? state.now : Date.now();
	return {
		model: state.model,
		duration_sec: Math.round((now - state.startedMs) / 1000),
		tokens_in: state.tokensIn,
		tokens_out: state.tokensOut,
		// Cache tokens are DISPLAYED only (never in cost/SCORE); carried on the checkpoint so an
		// ungraceful teardown still preserves them alongside tokens_in/out.
		cache_read_tokens: state.cacheRead ?? 0,
		cache_write_tokens: state.cacheWrite ?? 0,
		stop_reason: CHECKPOINT_STOP_REASON,
		cycle_count: state.cycles,
		final_message: '',
		partial: true,
		checkpoint: true,
		// Stamp whether agent-shell isolation was active so scoring can gate the ungraceful-death
		// exclusion on it: a checkpoint is exactly what survives an ungraceful teardown, and that
		// reclassification is only sound when isolation was on (see scoring.mjs classifyCell).
		isolation_active: state.isolationActive === true,
	};
}

/**
 * Persist `envelope` to `path` ATOMICALLY (write `.tmp` then rename over target). rename(2) is atomic
 * on the same filesystem, so a kill at any instant leaves a reader seeing the old OR new checkpoint,
 * never a torn write — the whole point being to survive an abrupt kill.
 * @param {string} path destination (the builder envelope OUTPUT)
 * @param {object} envelope the JSON-serializable envelope to write
 * @returns {void}
 */
export function writeEnvelopeAtomic(path, envelope) {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(envelope, null, 2));
	renameSync(tmp, path);
}
