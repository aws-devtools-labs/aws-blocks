// Unit tests for the builder's incremental partial-envelope checkpoint (partial-envelope.mjs) — fix
// (2) for #183. Prove the round-trip without importing 2-agent-run.ts: the envelope has the
// non-terminal shape, the atomic write survives read-back, and the cell classifies as an EXCLUDED
// harness_error whose cost is preserved. Run under bare `node --test`.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildCheckpointEnvelope, buildTraceArtifact, writeEnvelopeAtomic } from './partial-envelope.mjs';
import { CHECKPOINT_STOP_REASON, cellCost, classifyCell, isScoredCell } from './scoring.mjs';

describe('buildCheckpointEnvelope(state) — the non-terminal running checkpoint', () => {
	it('carries the accumulated spend and the non-terminal sentinel + checkpoint flag', () => {
		const env = buildCheckpointEnvelope({
			model: 'us.anthropic.claude-sonnet-4-6',
			startedMs: 1_000,
			tokensIn: 123_456,
			tokensOut: 7_890,
			cycles: 12,
			now: 61_000, // 60s later
		});
		assert.equal(env.model, 'us.anthropic.claude-sonnet-4-6');
		assert.equal(env.duration_sec, 60);
		assert.equal(env.tokens_in, 123_456);
		assert.equal(env.tokens_out, 7_890);
		assert.equal(env.cycle_count, 12);
		assert.equal(env.stop_reason, CHECKPOINT_STOP_REASON); // NON-terminal — never overwrites a real reason
		assert.equal(env.checkpoint, true);
		assert.equal(env.partial, true);
		assert.equal(env.final_message, '');
		// isolationActive omitted ⇒ defaults to false (never exclude on an unproven-isolation flag).
		assert.equal(env.isolation_active, false);
	});

	it('defaults `now` to the wall clock (duration is a finite, non-negative number)', () => {
		const env = buildCheckpointEnvelope({ model: 'm', startedMs: Date.now(), tokensIn: 1, tokensOut: 1, cycles: 1 });
		assert.ok(Number.isFinite(env.duration_sec) && env.duration_sec >= 0);
	});
});

describe('writeEnvelopeAtomic(path, envelope) — survives an abrupt kill, then classifies EXCLUDED', () => {
	it('a checkpoint written mid-run reads back with nonzero tokens after a simulated abrupt kill', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bench-checkpoint-'));
		const out = join(dir, 'builder-result.json');
		try {
			// Simulate the hook firing on cycle 7 with real accumulated usage, then
			// the process being killed abruptly (no terminal write) — the file on
			// disk IS the last checkpoint.
			const checkpoint = buildCheckpointEnvelope({
				model: 'us.anthropic.claude-sonnet-4-6',
				startedMs: Date.now() - 30_000,
				tokensIn: 210_000,
				tokensOut: 35_000,
				cycles: 7,
				isolationActive: true,
			});
			writeEnvelopeAtomic(out, checkpoint);

			// The abrupt-kill reader: finalize-result folds this envelope into the
			// cell, which finalize then stamps failed_at='2-agent'/status='error'.
			const onDisk = JSON.parse(readFileSync(out, 'utf-8'));
			assert.equal(onDisk.tokens_in, 210_000, 'token spend must survive the abrupt kill (not zero)');
			assert.equal(onDisk.tokens_out, 35_000);
			assert.equal(onDisk.checkpoint, true);
			assert.equal(onDisk.stop_reason, CHECKPOINT_STOP_REASON);
			assert.equal(onDisk.isolation_active, true, 'isolation flag must survive so scoring can gate the exclusion');

			const cell = { ...onDisk, failed_at: '2-agent', status: 'error' };
			// EXCLUDED from the mean — no terminal exit ran AND isolation was active …
			assert.equal(classifyCell(cell).klass, 'harness_error');
			assert.equal(isScoredCell(cell), false);
			// … yet the cost signal is preserved rather than masked as $0.
			assert.ok(cellCost(cell) > 0, 'preserved spend yields a real cost, not a masked zero');

			// The atomic write leaves no stray .tmp behind on success.
			assert.equal(existsSync(`${out}.tmp`), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a later checkpoint atomically replaces an earlier one (last-writer-wins, never torn)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bench-checkpoint-'));
		const out = join(dir, 'builder-result.json');
		try {
			writeEnvelopeAtomic(out, buildCheckpointEnvelope({ model: 'm', startedMs: 0, tokensIn: 10, tokensOut: 1, cycles: 1, now: 1_000 }));
			writeEnvelopeAtomic(out, buildCheckpointEnvelope({ model: 'm', startedMs: 0, tokensIn: 999, tokensOut: 99, cycles: 5, now: 5_000 }));
			const onDisk = JSON.parse(readFileSync(out, 'utf-8'));
			assert.equal(onDisk.tokens_in, 999); // the newer checkpoint won
			assert.equal(onDisk.cycle_count, 5);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('buildTraceArtifact(spanTraces, messages) — a trace on EVERY exit path (fixes #1/#2)', () => {
	// The bug: trace.json was written ONLY when invoke() RETURNED, so a non-returning invoke (a
	// MaxTokensError or a wall-clock/internal-deadline kill) left the cell with NO trace → an
	// unanalyzable silent 0. The per-turn MessageAddedEvent accumulator captures messages incrementally,
	// so even with zero span traces the tool-result-bearing messages are preserved on disk.
	it('preserves accumulated messages even when span traces are absent (the error / non-return path)', () => {
		const messages = [
			{ role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'bash', input: {} } }] },
			{ role: 'user', content: [{ toolResult: { toolUseId: 't1', status: 'error', content: [{ text: 'boom' }] } }] },
		];
		const artifact = buildTraceArtifact(undefined, messages);
		assert.deepEqual(artifact.traces, []); // invoke never returned ⇒ no span traces …
		assert.deepEqual(artifact.messages, messages); // … but the toolResult-bearing messages survive
	});

	it('passes both span traces and messages through on the success path', () => {
		const spanTraces = [{ name: 'invoke', children: [] }];
		const messages = [{ role: 'assistant', content: [{ text: 'done' }] }];
		assert.deepEqual(buildTraceArtifact(spanTraces, messages), { traces: spanTraces, messages });
	});

	it('is defensive: non-array inputs collapse to empty arrays (never throws, always serializable)', () => {
		assert.deepEqual(buildTraceArtifact(null, null), { traces: [], messages: [] });
		assert.deepEqual(buildTraceArtifact(undefined, undefined), { traces: [], messages: [] });
	});
});
