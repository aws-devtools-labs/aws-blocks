// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Checks that no required check passes without running when a job it depends
// on fails or is cancelled. GitHub counts a skipped required check as passing,
// so a required job that is skipped, or a gate job that treats a skipped
// dependency as passing, would let a PR merge past checks that never ran.
//
// The test simulates each workflow's job graph: it evaluates every job's and
// step's `if:` (a small subset of the GitHub expression language), forces one
// upstream job to fail or be cancelled, and runs the leading `run:` steps of
// the required jobs that start (the guard and gate scripts) in bash, with
// `${{ }}` substituted. Steps from the first `uses:` step on are assumed to
// pass. It also checks that the required jobs that deploy are cancelled with
// the run, don't start after a failed required check, and skip for fork PRs.
//
// Run: node --test scripts/ci/required-checks.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const WORKFLOWS = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const E2E = [
	'compute-smoke',
	'hosting',
	'production',
	'sandbox',
	'sandbox-vpc',
	'supabase',
	'telemetry',
	'templates',
	'templates-windows',
];

// The required checks of the main branch ruleset, by workflow. `nothing` and
// `everything` are the outputs of a successful detection job that selects no
// job and every job.
const REQUIRED = {
	'pr-checks.yml': {
		checks: ['Build, Unit Tests, E2E Local', 'E2E Production', 'E2E Sandbox'],
		nothing: { 'detect-changes': { 'e2e-index': '0', e2e: '[]', 'e2e-blocked': '[]', 'e2e-run': '[]' } },
		everything: {
			'detect-changes': {
				'e2e-index': '0',
				e2e: JSON.stringify(E2E),
				'e2e-blocked': '[]',
				'e2e-run': JSON.stringify(E2E),
			},
		},
	},
	'e2e-amplify-interop.yml': {
		checks: ['E2E Amplify Interop (Required)'],
		nothing: { 'detect-changes': { 'e2e-index': '0', 'source-changed': 'false' } },
		everything: { 'detect-changes': { 'e2e-index': '0', 'source-changed': 'true' } },
	},
	'native-sdk-e2e.yml': {
		checks: ['Native SDK E2E (Required)'],
		nothing: {
			'detect-changes': {
				'e2e-index': '0',
				'dart-changed': 'false',
				'swift-changed': 'false',
				'kotlin-changed': 'false',
				'any-changed': 'false',
			},
		},
		everything: {
			'detect-changes': {
				'e2e-index': '0',
				'dart-changed': 'true',
				'swift-changed': 'true',
				'kotlin-changed': 'true',
				'any-changed': 'true',
			},
		},
	},
	'changeset-check.yml': { checks: ['Require changeset'], nothing: {}, everything: {} },
};

// ---- A subset of the GitHub expression language -------------------------

const TOKEN = /\s*(?:('(?:[^']|'')*')|(&&|\|\||==|!=|[!(),])|([A-Za-z_][\w.-]*))/y;

function tokenize(src) {
	const tokens = [];
	TOKEN.lastIndex = 0;
	while (TOKEN.lastIndex < src.trimEnd().length) {
		const m = TOKEN.exec(src);
		if (!m) throw new Error(`can't parse expression: ${src}`);
		if (m[1]) tokens.push({ str: m[1].slice(1, -1).replaceAll("''", "'") });
		else tokens.push({ op: m[2] ?? m[3] });
	}
	return tokens;
}

function parseExpr(src) {
	const t = tokenize(src);
	let i = 0;
	const peek = () => t[i]?.op;
	const take = (op) => {
		if (peek() !== op) throw new Error(`expected ${op} in: ${src}`);
		i++;
	};
	const binary = (next, ops) => () => {
		let left = next();
		while (ops.includes(peek())) {
			const op = t[i++].op;
			left = { op, left, right: next() };
		}
		return left;
	};
	const primary = () => {
		const tok = t[i++];
		if (!tok) throw new Error(`unexpected end of: ${src}`);
		if ('str' in tok) return { value: tok.str };
		if (tok.op === '!') return { op: '!', arg: primary() };
		if (tok.op === '(') {
			const e = or();
			take(')');
			return e;
		}
		if (tok.op === 'true' || tok.op === 'false') return { value: tok.op === 'true' };
		if (tok.op === 'null') return { value: null };
		if (peek() === '(') {
			i++;
			const args = [];
			while (peek() !== ')') {
				args.push(or());
				if (peek() === ',') i++;
			}
			take(')');
			return { call: tok.op.toLowerCase(), args };
		}
		return { path: tok.op.split('.') };
	};
	const eq = binary(primary, ['==', '!=']);
	const and = binary(eq, ['&&']);
	const or = binary(and, ['||']);
	const e = or();
	if (i !== t.length) throw new Error(`trailing tokens in: ${src}`);
	return e;
}

const truthy = (v) => !(v === false || v === null || v === undefined || v === '' || v === 0);
const loose = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

function evaluate(node, ctx) {
	if ('value' in node) return node.value;
	if (node.path) {
		const value = node.path.reduce((obj, key) => (obj == null ? null : (obj[key] ?? null)), ctx);
		// A job output that was never set reads as '' (and fromJSON('') fails).
		return value === null && node.path[0] === 'needs' && node.path[2] === 'outputs' ? '' : value;
	}
	if (node.call) {
		const fn = ctx.status[node.call];
		if (fn) return fn();
		const args = node.args.map((a) => evaluate(a, ctx));
		if (node.call === 'contains') {
			const [hay, needle] = args;
			if (Array.isArray(hay)) return hay.some((x) => loose(x) === loose(needle));
			return String(hay ?? '')
				.toLowerCase()
				.includes(String(needle ?? '').toLowerCase());
		}
		if (node.call === 'fromjson') return JSON.parse(args[0]);
		if (node.call === 'tojson') return JSON.stringify(args[0], null, 2);
		throw new Error(`unsupported function ${node.call}`);
	}
	if (node.op === '!') return !truthy(evaluate(node.arg, ctx));
	const left = evaluate(node.left, ctx);
	if (node.op === '&&') return truthy(left) ? evaluate(node.right, ctx) : left;
	if (node.op === '||') return truthy(left) ? left : evaluate(node.right, ctx);
	const same = loose(left) === loose(evaluate(node.right, ctx));
	return node.op === '==' ? same : !same;
}

/** An `if:`, with the implicit `success() &&` GitHub adds when it has no status function. */
function condition(src, ctx) {
	const body = String(src ?? 'success()')
		.trim()
		.replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
	const full = /\b(always|success|failure|cancelled)\(\)/.test(body) ? body : `success() && (${body})`;
	return truthy(evaluate(parseExpr(full), ctx));
}

const interpolate = (text, ctx) =>
	String(text).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => {
		const v = evaluate(parseExpr(e), ctx);
		return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
	});

// ---- Job graph simulation -------------------------------------------------

const needsOf = (job) => [job.needs ?? []].flat();

/**
 * Run the leading `run:` steps of a required job that started (its guard or
 * gate script); later steps are assumed to pass. These run on the host, so a
 * required job must not start with a `run:` step that has side effects.
 * `cancelled()` is false here on purpose: GitHub cancels only the jobs whose
 * `if:` turns false, so a job that `always()` keeps alive runs its steps.
 */
function runSteps(job, ctx) {
	let failed = false;
	for (const step of job.steps ?? []) {
		if (step.uses) break;
		const stepCtx = {
			...ctx,
			status: { always: () => true, success: () => !failed, failure: () => failed, cancelled: () => false },
		};
		if (!condition(step.if, stepCtx)) continue;
		const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, interpolate(v, stepCtx)]));
		const r = spawnSync(
			'bash',
			// A `run:` step without `shell:` runs as `bash -e {0}`.
			['-e', '-c', interpolate(step.run, stepCtx)],
			{
				env: { PATH: process.env.PATH, ...env },
				encoding: 'utf8',
			},
		);
		if (r.status !== 0) failed = true;
	}
	return failed ? 'failure' : 'success';
}

/** The context a job's `if:` sees. */
function jobContext(needs, cancelled, fork = false) {
	return {
		github: {
			event_name: 'pull_request',
			repository: 'owner/repo',
			event: { pull_request: { number: 1, head: { repo: { full_name: fork ? 'fork/repo' : 'owner/repo' } } } },
		},
		needs,
		secrets: {},
		status: {
			always: () => true,
			success: () => !cancelled && Object.values(needs).every((n) => n.result === 'success'),
			failure: () => Object.values(needs).some((n) => n.result === 'failure'),
			cancelled: () => cancelled,
		},
	};
}

/**
 * Each job's result for one scenario. `force` sets one job's result when it
 * starts; `outputs` are the outputs of jobs that succeed or are forced. When
 * `cancel` names a job, the run is cancelled while that job runs: `cancelled()`
 * is true for the jobs after it. The jobs beside it keep their results, the
 * worst case for a required check downstream. Only the `required` jobs run
 * their steps; the others succeed when they start. `fork` makes the PR come
 * from a fork.
 */
function simulate(jobs, { outputs, required, force = {}, cancel, fork }) {
	const results = {};
	const visit = (id) => {
		if (results[id]) return results[id];
		const job = jobs[id];
		const needs = Object.fromEntries(needsOf(job).map((n) => [n, visit(n)]));
		const cancelled = cancel !== undefined && upstreamOf(jobs, id).has(cancel);
		const ctx = jobContext(needs, cancelled, fork);
		let result;
		try {
			if (!condition(job.if, ctx)) result = 'skipped';
			else result = force[id] ?? (required.has(id) ? runSteps(job, ctx) : 'success');
		} catch (e) {
			// GitHub fails a job whose `if:` doesn't evaluate; keep it distinct
			// so the test asks for an `if:` that evaluates in every case.
			result = `error: ${e.message}`;
		}
		results[id] = { result, outputs: result === 'skipped' ? {} : (outputs[id] ?? {}) };
		return results[id];
	};
	for (const id of Object.keys(jobs)) visit(id);
	return results;
}

function upstreamOf(jobs, id, seen = new Set()) {
	for (const n of needsOf(jobs[id])) {
		if (!seen.has(n)) {
			seen.add(n);
			upstreamOf(jobs, n, seen);
		}
	}
	return seen;
}

// Outputs of a job that fails: whatever it wrote before failing (e2e-selection.sh
// writes empty selections and then fails for an unknown trailer name on a
// CI-only change), or nothing at all.
const blank = (outputs) => Object.fromEntries(Object.keys(outputs).map((k) => [k, '']));

for (const [file, spec] of Object.entries(REQUIRED)) {
	describe(file, () => {
		const { jobs } = parse(readFileSync(`${WORKFLOWS}${file}`, 'utf8'));
		const byName = Object.fromEntries(Object.entries(jobs).map(([id, job]) => [job.name ?? id, id]));
		const requiredIds = new Set(spec.checks.map((name) => byName[name]));

		for (const name of spec.checks) {
			const id = byName[name];

			it(`has a job named "${name}" (the ruleset matches checks by name)`, () => {
				assert.ok(id, `no job named "${name}" in ${file}`);
			});
			if (!id) continue;

			it(`${name}: passes when detection selects nothing`, () => {
				const { result } = simulate(jobs, { outputs: spec.nothing, required: requiredIds })[id];
				assert.ok(['success', 'skipped'].includes(result), result);
			});

			it(`${name}: runs when detection selects everything`, () => {
				assert.equal(simulate(jobs, { outputs: spec.everything, required: requiredIds })[id].result, 'success');
			});

			// A job that does real work (a `uses:` step) must stop when the run is
			// cancelled, e.g. by a new push: GitHub keeps a job whose `if:` is
			// still true after the cancel running, deploy and all.
			if (jobs[id].steps?.some((step) => step.uses)) {
				it(`${name}: is cancelled with the run`, () => {
					const results = simulate(jobs, { outputs: spec.everything, required: requiredIds });
					const needs = Object.fromEntries(needsOf(jobs[id]).map((n) => [n, results[n]]));
					assert.equal(condition(jobs[id].if, jobContext(needs, true)), false);
				});
			}

			// Fork PRs get no AWS credentials, so the E2E jobs skip for them (a
			// skip that passes; forks need approval to run workflows at all).
			if (jobs[id].environment) {
				for (const [label, outputs, force] of [
					['selecting nothing', spec.nothing, {}],
					['selecting everything', spec.everything, {}],
					['when detection fails', spec.everything, { 'detect-changes': 'failure' }],
				]) {
					it(`${name}: skips for a fork PR (${label})`, () => {
						const results = simulate(jobs, { outputs, required: requiredIds, force, fork: true });
						assert.equal(results[id].result, 'skipped');
					});
				}
			}

			// A required check upstream that fails blocks the merge, and the work
			// after it (a deploy) must not start.
			if (jobs[id].steps?.some((step) => step.uses)) {
				for (const r of [...upstreamOf(jobs, id)].filter((u) => requiredIds.has(u))) {
					it(`${name}: doesn't run when ${r} fails`, () => {
						const scenario = { outputs: spec.everything, required: requiredIds, force: { [r]: 'failure' } };
						assert.notEqual(simulate(jobs, scenario)[id].result, 'success');
					});
				}
			}

			// A required check upstream that fails blocks the merge on its own,
			// so this one may then skip.
			const required = [...upstreamOf(jobs, id)].filter((u) => requiredIds.has(u));
			const upstream = [...upstreamOf(jobs, id)].filter((u) => !requiredIds.has(u));
			for (const u of upstream) {
				for (const result of ['failure', 'cancelled']) {
					const bases = [
						['selecting nothing', spec.nothing],
						['selecting everything', spec.everything],
					];
					if (spec.everything[u])
						bases.push(['without outputs', { ...spec.everything, [u]: blank(spec.everything[u]) }]);
					for (const [label, base] of bases) {
						it(`${name}: fails when ${u} ends ${result} (${label})`, (t) => {
							const cancel = result === 'cancelled' ? u : undefined;
							const scenario = { outputs: base, required: requiredIds, force: { [u]: result }, cancel };
							const results = simulate(jobs, scenario);
							if (results[u].result !== result) return t.skip(`${u} doesn't start here`);
							const blocking = required.filter((r) =>
								['failure', 'cancelled'].includes(results[r].result),
							);
							if (blocking.length) return assert.ok(['failure', 'skipped'].includes(results[id].result));
							assert.equal(results[id].result, 'failure', `${name} ends ${results[id].result}`);
						});
					}
				}
			}
		}
	});
}
