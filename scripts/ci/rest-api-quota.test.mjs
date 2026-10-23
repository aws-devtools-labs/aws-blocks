// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/rest-api-quota.sh, and for the REST API sweep step
// of .github/workflows/cleanup-stacks.yml that runs it. Both run against a stub
// `aws` on PATH; nothing reaches AWS.
//
// Run: node --test scripts/ci/rest-api-quota.test.mjs
// The step tests need GNU date (the step runs `date -d`), so they skip elsewhere.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./rest-api-quota.sh', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/cleanup-stacks.yml', import.meta.url));
const STEP = 'Cleanup orphaned API Gateway REST APIs';

// What AWS CLI v2 writes to stderr for a rejected call: a blank line, then the
// message. The account id must not reach the (public) log.
const DENIED =
	'\nAn error occurred (AccessDeniedException) when calling the GetRestApis operation: ' +
	'User: arn:aws:sts::123456789012:assumed-role/ci/run is not authorized to perform: apigateway:GET\n';
// A reason with a "%", which a workflow command must carry as "%25".
const PERCENT = '\nAn error occurred (LimitExceededException) when calling the GetRestApis operation: 100% of the rate used\n';

// A stub `aws` that serves canned output from its fixture dir and logs every call.
//   get-rest-apis with --query  -> rest-apis.txt (the sweep's id/name/date listing)
//   get-rest-apis without       -> rest-apis.json (the quota count)
//   get-rest-apis.err present   -> its text on stderr, exit 254 (both forms);
//                                  get-rest-apis-query.err / -json.err fail one form
//   list-stacks.err present     -> the same for list-stacks
//   describe-stack-resources    -> resources-<stack>.txt
//   delete-rest-api             -> appends the id to deleted.txt
const STUB = `#!/usr/bin/env bash
d=$STUB_DIR
echo "$*" >> "$d/calls.txt"
case "$1 $2" in
'apigateway get-rest-apis')
	case " $* " in *' --query '*) form=query ;; *) form=json ;; esac
	for f in "$d/get-rest-apis.err" "$d/get-rest-apis-$form.err"; do
		if [ -f "$f" ]; then cat "$f" >&2; exit 254; fi
	done
	if [ "$form" = query ]; then cat "$d/rest-apis.txt" 2>/dev/null; else cat "$d/rest-apis.json"; fi ;;
'cloudformation list-stacks')
	if [ -f "$d/list-stacks.err" ]; then cat "$d/list-stacks.err" >&2; exit 254; fi
	cat "$d/stacks.txt" 2>/dev/null ;;
'cloudformation describe-stack-resources')
	cat "$d/resources-$4.txt" 2>/dev/null ;;
'apigateway delete-rest-api')
	echo "$4" >> "$d/deleted.txt" ;;
*) echo "stub aws: unexpected call: $*" >&2; exit 2 ;;
esac
`;

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fixture dir holding the stub `aws` (and a no-op `sleep`) plus `files`. */
function fixture(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'rest-api-quota-'));
	dirs.push(dir);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'aws'), STUB);
	writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\n');
	chmodSync(join(bin, 'aws'), 0o755);
	chmodSync(join(bin, 'sleep'), 0o755);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

function run(dir, args, env = {}) {
	const summary = join(dir, 'summary.md');
	const r = spawnSync('bash', args, {
		cwd: ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			...env,
			PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
			STUB_DIR: dir,
			GITHUB_STEP_SUMMARY: summary,
		},
	});
	const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary: read('summary.md'), deleted: read('deleted.txt') };
}

const api = (id, types) => ({ id, name: id, endpointConfiguration: { types } });
const apis = (...items) => JSON.stringify({ items });

const GNU_DATE = spawnSync('date', ['-d', '@0', '+%s'], { encoding: 'utf8' }).stdout?.trim() === '0';

/** The `run:` script of the REST API sweep step, dedented. */
function stepScript() {
	const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
	const start = lines.findIndex((l) => l.trim() === `- name: ${STEP}`);
	assert.notEqual(start, -1, `step "${STEP}" not found in cleanup-stacks.yml`);
	const runAt = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
	const body = [];
	for (const line of lines.slice(runAt + 1)) {
		if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
		body.push(line.slice(10));
	}
	return body.join('\n');
}

function runStep(dir) {
	const file = join(dir, 'step.sh');
	writeFileSync(file, stepScript());
	return run(dir, [file]);
}

describe('rest-api-quota.sh', () => {
	it('counts EDGE APIs apart from regional and private ones', () => {
		const dir = fixture({
			'rest-apis.json': apis(api('a', ['EDGE']), api('b', ['REGIONAL']), api('c', ['EDGE']), api('d', ['PRIVATE'])),
		});
		const r = run(dir, [SCRIPT]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^- REST APIs remaining: 4 total, 2 EDGE \(cap 120\)$/m);
		assert.match(r.summary, /^- REST APIs remaining: 4 total, 2 EDGE \(cap 120\)$/m);
		assert.doesNotMatch(r.stdout, /::(warning|error)::/);
	});

	it('reports zero for an account with no REST APIs', () => {
		const dir = fixture({ 'rest-apis.json': apis() });
		const r = run(dir, [SCRIPT]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /- REST APIs remaining: 0 total, 0 EDGE \(cap 120\)/);
	});

	it('warns once the EDGE count reaches the threshold', () => {
		const items = Array.from({ length: 80 }, (_, i) => api(`e${i}`, ['EDGE']));
		const dir = fixture({ 'rest-apis.json': apis(...items) });
		const r = run(dir, [SCRIPT]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^::warning::80\/120 EDGE REST APIs in use/m);
	});

	it('does not warn one below the threshold', () => {
		const items = Array.from({ length: 79 }, (_, i) => api(`e${i}`, ['EDGE']));
		const r = run(fixture({ 'rest-apis.json': apis(...items) }), [SCRIPT]);
		assert.equal(r.status, 0, r.stderr);
		assert.doesNotMatch(r.stdout, /::warning::/);
	});

	it('takes the threshold from REST_API_EDGE_WARN', () => {
		const dir = fixture({ 'rest-apis.json': apis(api('a', ['EDGE']), api('b', ['EDGE'])) });
		const r = run(dir, [SCRIPT], { REST_API_EDGE_WARN: '2' });
		assert.match(r.stdout, /^::warning::2\/120 EDGE REST APIs in use/m);
	});

	it('fails with the CLI error when the listing fails, never reading it as zero', () => {
		const r = run(fixture({ 'get-rest-apis.err': DENIED }), [SCRIPT]);
		assert.equal(r.status, 1);
		assert.match(r.stdout, /^::error::.*AccessDeniedException.*not authorized/m);
		assert.match(r.summary, /REST APIs remaining: unknown.*AccessDeniedException/);
		assert.doesNotMatch(r.stdout + r.summary, /\b0 total\b/);
	});

	it('keeps account ids out of the error', () => {
		const r = run(fixture({ 'get-rest-apis.err': DENIED }), [SCRIPT]);
		assert.doesNotMatch(r.stdout + r.summary, /123456789012/);
	});

	it('escapes a "%" in the reason for the annotation, and keeps it in the summary', () => {
		const r = run(fixture({ 'get-rest-apis.err': PERCENT }), [SCRIPT]);
		assert.equal(r.status, 1);
		assert.match(r.stdout, /^::error::.*: An error occurred \(LimitExceededException\).*: 100%25 of the rate used$/m);
		assert.match(r.summary, /listing failed: .*: 100% of the rate used$/m);
	});

	it('fails on output it cannot parse', () => {
		const r = run(fixture({ 'rest-apis.json': 'not json' }), [SCRIPT]);
		assert.equal(r.status, 1);
		assert.match(r.stdout, /^::error::/m);
	});
});

describe(`cleanup-stacks.yml "${STEP}" step`, { skip: !GNU_DATE && 'needs GNU date' }, () => {
	const old = '2020-01-01T00:00:00+00:00';

	it('fails the leg, with the CLI error, when the REST APIs cannot be listed', () => {
		const r = runStep(fixture({ 'get-rest-apis.err': DENIED }));
		assert.notEqual(r.status, 0, 'the step must fail when get-rest-apis fails');
		assert.match(
			r.stdout,
			/^::error::apigateway get-rest-apis failed, orphaned REST APIs were not swept: An error occurred \(AccessDeniedException\)/m,
		);
		assert.doesNotMatch(r.stdout, /123456789012/);
		assert.doesNotMatch(r.stdout, /No custom REST APIs found/);
		// The summary still prints, so the run page shows what happened.
		assert.match(r.summary, /## API Gateway REST API Cleanup Summary/);
		assert.match(r.summary, /REST APIs remaining: unknown/);
		assert.equal(r.deleted, '');
	});

	it('escapes a "%" in the reason for the annotation', () => {
		const r = runStep(fixture({ 'get-rest-apis-query.err': PERCENT, 'rest-apis.json': apis() }));
		assert.match(r.stdout, /^::error::apigateway get-rest-apis failed, .*: 100%25 of the rate used$/m);
	});

	it('fails the leg when only the sweep listing fails', () => {
		const r = runStep(fixture({ 'get-rest-apis-query.err': DENIED, 'rest-apis.json': apis(api('a', ['EDGE'])) }));
		assert.notEqual(r.status, 0);
		assert.match(r.stdout, /^::error::apigateway get-rest-apis failed/m);
		assert.match(r.summary, /^- REST APIs remaining: 1 total, 1 EDGE \(cap 120\)$/m);
	});

	it('fails the leg when only the count fails', () => {
		const r = runStep(fixture({ 'get-rest-apis-json.err': DENIED, 'rest-apis.txt': '' }));
		assert.notEqual(r.status, 0);
		assert.doesNotMatch(r.stdout, /orphaned REST APIs were not swept/);
		assert.match(r.summary, /REST APIs remaining: unknown/);
	});

	it('reports the EDGE count and passes when the listing works', () => {
		const r = runStep(fixture({ 'rest-apis.txt': '', 'rest-apis.json': apis(api('a', ['EDGE'])) }));
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.summary, /^- REST APIs remaining: 1 total, 1 EDGE \(cap 120\)$/m);
	});

	it('still deletes an old unowned test API and spares the stack-owned one', () => {
		const r = runStep(
			fixture({
				'stacks.txt': 'bb-test-live\n',
				'resources-bb-test-live.txt': 'owned1\n',
				'rest-apis.txt': `owned1\tBlocks API\t${old}\norphan1\tBlocks API\t${old}\nother1\tcustomer-api\t${old}\n`,
				'rest-apis.json': apis(api('owned1', ['EDGE']), api('other1', ['EDGE'])),
			}),
		);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(r.deleted, 'orphan1\n');
		assert.match(r.summary, /- Orphaned REST APIs deleted: 1/);
		assert.match(r.summary, /- Skipped \(owned by live stack\): 1/);
		assert.match(r.summary, /- Skipped \(non-test name\): 1/);
	});

	it('deletes nothing when the live stacks cannot be listed', () => {
		const r = runStep(
			fixture({
				'list-stacks.err': '\nAn error occurred (Throttling) when calling the ListStacks operation: Rate exceeded\n',
				'rest-apis.txt': `live1\tBlocks API\t${old}\n`,
				'rest-apis.json': apis(api('live1', ['EDGE'])),
			}),
		);
		assert.equal(r.deleted, '', 'an unknown ownership set must not read as "no stack owns any API"');
		assert.match(r.summary, /- Deferred to next run.*: 1/);
		assert.match(
			r.stdout,
			/^::warning::list-stacks failed, so the ownership set is incomplete and no REST API is deleted this run: An error occurred \(Throttling\)/m,
		);
	});
});

describe('cleanup-stacks.yml checkout', () => {
	// The REST API step runs the script from the checkout, on every leg.
	it('checks out scripts/ci on every leg', () => {
		const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
		const job = lines.slice(lines.indexOf('  cleanup:'));
		const at = job.findIndex((l) => l.trim().startsWith('- uses: actions/checkout@'));
		assert.notEqual(at, -1, 'the cleanup job has no checkout step');
		const step = [];
		for (const line of job.slice(at + 1)) {
			if (line.trim().startsWith('- ')) break;
			step.push(line.trim());
		}
		assert.ok(!step.some((l) => l.startsWith('if:')), 'the checkout must run on every leg');
		assert.ok(step.includes('scripts/ci'), 'sparse-checkout must include scripts/ci');
	});
});
