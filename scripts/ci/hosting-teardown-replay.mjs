#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Replays the E2E Hosting matrix's REST API deletes through API Gateway's
// delete quota, to check or re-derive each leg's `teardown-at` in
// .github/workflows/pr-checks.yml.
//
//   node scripts/ci/hosting-teardown-replay.mjs [--search[=budget]] [--holdout] [--schedule=JSON] [runId ...]
//
// Inputs, read with the gh CLI for each PR Checks run (latest attempt;
// default: RUNS below, which produced the current values):
// - each E2E Hosting job's start (jobs API `started_at`);
// - from its log: the start of the destroy after the suite (the last
//   "Destroying sandbox" line after the first REST API create, less a
//   "Waiting Ns" before it, so runs made with a wait replay as without one),
//   and the AWS::ApiGateway::RestApi DELETE_IN_PROGRESS lines after it, up
//   to the first REST API DELETE_FAILED (later ones are retries, which a
//   better schedule would not cause);
// - the end of every other E2E job, for "the run's slowest E2E job".
// Logs of finished jobs are cached under the OS temp dir. GitHub keeps them
// for 90 days, so pass recent run ids once the default ones expire.
//
// Model: a leg's destroy starts at teardown-at seconds from its job start,
// or when the suite is done if that is later, and its deletes keep their
// offsets from it. Deletes go through FIFO at one per 30 seconds (capacity
// 1). Only the matrix's own deletes are modeled: Telemetry, the other E2E
// jobs and other PRs' runs in the same account are not, and neither are
// CloudFormation's own retries, so the modeled wait is a proxy for how much
// the matrix's deletes crowd each other, not a prediction of DELETE_FAILED
// (the report lists the ones the logs show, with their modeled wait). It
// reports, per schedule: total, p90 and max modeled queue wait, deletes
// waiting over 270 s (CloudFormation gives up after about 4.5 minutes), the
// runner time the waits cost (mean per run), and how far the end of the
// Hosting matrix and of the run's slowest E2E job move. The latter holds for
// full runs; in a run that selects only Hosting, Hosting is the slowest job.
//
// --search: a coordinate search (15 s steps), starting from the evaluated
// schedule, for teardown-at values that minimise the total wait without
// moving the end of any run's slowest E2E job, within a runner-time budget
// per run (default 1050 s, what fixed delays of 240+150+240+180+240 s
// cost). It finds a local minimum, so try other starts too. Round its result.
// --holdout: the same search, from no wait, on the even-indexed runs,
// evaluated on the odd ones, and the other way round.
// --schedule: evaluate a teardown-at JSON object instead of pr-checks.yml's.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const exec = promisify(execFile);
const REPO = process.env.GITHUB_REPOSITORY ?? 'aws-devtools-labs/aws-blocks';
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/pr-checks.yml', import.meta.url));
const CACHE = join(tmpdir(), 'hosting-teardown-replay');

// Successful PR Checks runs with all nine Hosting legs, 2026-10-17 to 2026-10-22.
export const RUNS = [
	39166163600, 39178283482, 39217869925, 39224324654, 39316369411, 39327864736, 39336625296, 39389169699,
	39393120739, 39409594310, 39470690808, 39471175776, 39513265169, 39596066948, 39618454009, 39632173898,
	39634828615, 39646431606, 39685060539, 39771392285, 39772106113, 39812188339, 39821845972,
];

const DELETE_INTERVAL = 30;
const GIVE_UP = 270;

/** `gh api`, retried on a transient failure (GitHub answers some log requests with a 5xx). */
async function gh(path) {
	for (let attempt = 1; ; attempt++) {
		try {
			const { stdout } = await exec('gh', ['api', '--allow-escape-sequences', path], {
				maxBuffer: 512 * 1024 * 1024,
			});
			return stdout;
		} catch (e) {
			if (attempt === 4) throw e;
			await new Promise((r) => setTimeout(r, 2000 * attempt));
		}
	}
}

/** Up to `n` calls of `fn` at a time. */
async function pool(items, n, fn) {
	const out = [];
	let i = 0;
	await Promise.all(
		Array.from({ length: n }, async () => {
			while (i < items.length) {
				const k = i++;
				out[k] = await fn(items[k]);
			}
		}),
	);
	return out;
}

async function jobLog(job) {
	const file = join(CACHE, `${job.id}.log`);
	if (existsSync(file)) return readFileSync(file, 'utf8');
	const text = await gh(`repos/${REPO}/actions/jobs/${job.id}/logs`);
	if (job.status === 'completed') writeFileSync(file, text);
	return text;
}

/**
 * From a Hosting job log: `ready` (when the destroy after the suite started,
 * less any teardown wait, as epoch seconds), `waited` (that wait), `deletes`
 * (REST API delete starts up to the first DELETE_FAILED, seconds after the
 * destroy actually started) and `failed` (whether one failed). Returns null
 * when the log has no destroy after the suite.
 */
export function parseHostingLog(text) {
	const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
	const at = (l) => Date.parse(l.slice(0, l.indexOf(' '))) / 1000;
	let created;
	let ready;
	let waited = 0;
	let waitedAt;
	let failed = false;
	const deletes = [];
	for (const l of lines) {
		if (created === undefined) {
			if (/\| CREATE_IN_PROGRESS\s+\| AWS::ApiGateway::RestApi /.test(l)) created = at(l);
			continue;
		}
		const w = l.match(/Waiting (\d+)s to spread the matrix's stack deletes/);
		if (w && deletes.length === 0) {
			waited = Number(w[1]);
			waitedAt = at(l);
		}
		if (/Destroying sandbox\.\.\./.test(l) && deletes.length === 0) ready = at(l);
		if (ready === undefined) continue;
		if (/\| DELETE_FAILED\s+\| AWS::ApiGateway::RestApi /.test(l)) {
			failed = true;
			break;
		}
		if (/\| DELETE_IN_PROGRESS\s+\| AWS::ApiGateway::RestApi /.test(l)) deletes.push(at(l));
	}
	if (ready === undefined || deletes.length === 0) return null;
	const start = ready;
	if (waitedAt !== undefined && waitedAt <= ready) ready = waitedAt;
	else waited = 0;
	return { ready, waited, failed, deletes: deletes.map((t) => t - start) };
}

export async function loadRun(run) {
	const { jobs } = JSON.parse(await gh(`repos/${REPO}/actions/runs/${run}/jobs?per_page=100`));
	const t = (s) => Date.parse(s) / 1000;
	const hosting = jobs.filter((j) => j.name.startsWith('E2E Hosting ('));
	const legs = {};
	await pool(hosting, 6, async (j) => {
		const parsed = parseHostingLog(await jobLog(j));
		if (!parsed) {
			console.error(`warning: run ${run}, ${j.name}: no destroy after the suite in the log; leg left out`);
			return;
		}
		const leg = j.name.match(/\((.*)\)/)[1];
		const start = t(j.started_at);
		legs[leg] = {
			ready: parsed.ready - start,
			deletes: parsed.deletes,
			failed: parsed.failed,
			end: t(j.completed_at) - parsed.waited - start,
			start,
		};
	});
	const others = jobs
		.filter((j) => /^E2E |^Telemetry E2E|^Build, Unit/.test(j.name) && !j.name.startsWith('E2E Hosting') && j.completed_at)
		.map((j) => t(j.completed_at));
	return { run, legs, othersEnd: Math.max(0, ...others) };
}

/** Replay one run under a schedule `{ leg: teardownAt }`. `waits` is per delete, in delete order, with its leg. */
export function replay(r, schedule) {
	const times = [];
	let hostingEnd = 0;
	let hostingEndBefore = 0;
	let cost = 0;
	for (const [leg, L] of Object.entries(r.legs)) {
		const shift = Math.max(0, (schedule[leg] ?? 0) - L.ready);
		cost += shift;
		for (const d of L.deletes) times.push({ leg, t: L.start + L.ready + shift + d });
		hostingEnd = Math.max(hostingEnd, L.start + L.end + shift);
		hostingEndBefore = Math.max(hostingEndBefore, L.start + L.end);
	}
	times.sort((a, b) => a.t - b.t);
	const waits = [];
	let free = -Infinity;
	for (const { leg, t } of times) {
		const s = Math.max(t, free + DELETE_INTERVAL);
		waits.push({ leg, wait: s - t });
		free = s;
	}
	const slowest = (h) => Math.max(h, r.othersEnd);
	return {
		waits,
		cost,
		hostingDelta: hostingEnd - hostingEndBefore,
		gateDelta: slowest(hostingEnd) - slowest(hostingEndBefore),
	};
}

export function summary(runs, schedule) {
	const all = runs.map((r) => replay(r, schedule));
	const waits = all.flatMap((a) => a.waits.map((w) => w.wait)).sort((a, b) => a - b);
	return {
		sum: waits.reduce((a, b) => a + b, 0),
		over: waits.filter((w) => w > GIVE_UP).length,
		p90: waits[Math.floor(0.9 * (waits.length - 1))] ?? 0,
		max: waits.at(-1) ?? 0,
		cost: all.reduce((a, b) => a + b.cost, 0) / all.length,
		hostingMax: Math.max(...all.map((a) => a.hostingDelta)),
		gateMax: Math.max(...all.map((a) => a.gateDelta)),
		n: waits.length,
	};
}

function print(name, s, base) {
	const m = (x) => (x / 60).toFixed(1);
	const cut = base ? `, ${(100 * (1 - s.sum / base.sum)).toFixed(0)}% less than no wait` : '';
	console.log(
		`${name.padEnd(14)} deletes ${s.n} | wait > ${GIVE_UP} s ${s.over} | modeled wait total ${m(s.sum)} min${cut}, p90 ${s.p90.toFixed(0)} s, max ${s.max.toFixed(0)} s | runner time ${m(s.cost)} min/run | Hosting end moves up to ${m(s.hostingMax)} min | slowest E2E job end moves up to ${m(s.gateMax)} min`,
	);
}

export function search(runs, legs, budget, start = {}) {
	const best = Object.fromEntries(legs.map((l) => [l, start[l] ?? 0]));
	let score = summary(runs, best).sum;
	for (let pass = 0; pass < 3; pass++) {
		for (const leg of legs) {
			for (let v = 0; v <= 3600; v += 15) {
				const s = summary(runs, { ...best, [leg]: v });
				if (s.gateMax <= 0 && s.cost <= budget && s.sum < score) {
					score = s.sum;
					best[leg] = v;
				}
			}
		}
	}
	return best;
}

async function main(argv) {
	const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
	const value = (name) => flag(name)?.split('=').slice(1).join('=');
	const budget = Number(value('search') || 1050);
	const ids = argv.filter((a) => /^\d+$/.test(a)).map(Number);
	mkdirSync(CACHE, { recursive: true });
	const wf = parse(readFileSync(WORKFLOW, 'utf8'));
	const matrix = wf.jobs['e2e-hosting'].strategy.matrix.include;
	const legs = matrix.map((m) => m.framework);
	const current = value('schedule')
		? JSON.parse(value('schedule'))
		: Object.fromEntries(matrix.map((m) => [m.framework, m['teardown-at'] ?? 0]));
	const runs = (await pool(ids.length > 0 ? ids : RUNS, 3, loadRun)).filter((r) => Object.keys(r.legs).length > 0);
	if (runs.length === 0) throw new Error('No run had a Hosting destroy to replay.');
	console.log(`${runs.length} runs. Destroy ready, minutes from job start (median, max):`);
	for (const leg of legs) {
		const v = runs.map((r) => r.legs[leg]?.ready).filter((x) => x !== undefined).sort((a, b) => a - b);
		if (v.length > 0) console.log(`  ${leg.padEnd(24)} ${(v[v.length >> 1] / 60).toFixed(1)}  ${(v.at(-1) / 60).toFixed(1)}`);
	}
	const none = summary(runs, {});
	print('no wait', none);
	print(value('schedule') ? 'schedule' : 'pr-checks', summary(runs, current), none);
	console.log(`teardown-at: ${JSON.stringify(current)}`);
	const failed = runs.flatMap((r) => {
		const w = replay(r, {}).waits;
		return Object.entries(r.legs)
			.filter(([, L]) => L.failed)
			.map(([leg]) => `${r.run} ${leg} (modeled wait ${Math.max(...w.filter((x) => x.leg === leg).map((x) => x.wait)).toFixed(0)} s)`);
	});
	console.log(`Logged REST API DELETE_FAILED, with no wait: ${failed.length} legs${failed.length ? `: ${failed.join(', ')}` : ''}`);
	if (flag('search')) {
		const found = search(runs, legs, budget, current);
		print('search', summary(runs, found), none);
		console.log(`search teardown-at: ${JSON.stringify(found)}`);
	}
	if (flag('holdout')) {
		const even = runs.filter((_, i) => i % 2 === 0);
		const odd = runs.filter((_, i) => i % 2 === 1);
		for (const [fit, test, name] of [
			[even, odd, 'even -> odd'],
			[odd, even, 'odd -> even'],
		]) {
			const found = search(fit, legs, budget);
			print(name, summary(test, found), summary(test, {}));
			console.log(`  fitted teardown-at: ${JSON.stringify(found)}`);
		}
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
