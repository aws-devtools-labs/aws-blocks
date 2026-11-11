// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the e2e stack step of .github/workflows/cleanup-stacks.yml,
// run against a stub `aws` and a stub `sleep` on PATH (nothing reaches AWS and
// nothing waits). API Gateway allows about one REST API delete per 30 seconds
// per account, so the step spaces the deletes of stacks that still own a REST
// API, caps them per run, defers a stack whose resources it cannot list, and
// leaves a stack whose delete is in progress alone. A stack stuck in
// DELETE_FAILED is deleted once, retaining its failed REST API when the REST
// API sweep will reclaim it, based on how long it has been DELETE_FAILED
// rather than on its age.
//
// Run: node --test scripts/ci/stack-sweep.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = readFileSync(
	fileURLToPath(new URL('../../.github/workflows/cleanup-stacks.yml', import.meta.url)),
	'utf8',
);
const STEP = 'Find and delete stale e2e stacks';

// A stub `aws` serving the calls the step makes, from its fixture dir:
//   cloudformation list-stacks (names query) -> the names in stacks.txt with
//     the queried prefix, tab-separated
//   cloudformation list-stacks (length query) -> 0
//   cloudformation describe-stacks -> info-<name>.txt
//   cloudformation list-stack-resources -> resources-<name>.txt ("error"
//     answers a Throttling error)
//   cloudformation describe-stack-resources -> failed-<name>.json, else []
//   cloudformation describe-stack-events -> events-<name>.txt ("error" answers
//     a Throttling error), else None
//   cloudformation delete-stack -> appends "delete-stack <args>" to calls.txt;
//     exits 254 when delete-fails-<name> exists
//   apigateway get-rest-api -> the REST API name in api-<id>.txt ("error"
//     answers a Throttling error), else NotFound
// and a stub `sleep` that appends "sleep <seconds>" to calls.txt.
const AWS_STUB = `#!/usr/bin/env bash
args="$*"
name=""; prev=""
for a in "$@"; do [ "$prev" = "--stack-name" ] && name="$a"; prev="$a"; done
case "$1 $2" in
  "cloudformation list-stacks")
    case "$args" in
      *length*) echo 0 ;;
      *)
        prefix=$(echo "$args" | grep -o "starts_with(StackName, '[^']*')" | cut -d"'" -f2)
        grep "^$prefix" "$STUB_DIR/stacks.txt" | tr '\\n' '\\t'; echo ;;
    esac ;;
  "cloudformation describe-stacks") cat "$STUB_DIR/info-$name.txt" ;;
  "cloudformation list-stack-resources")
    f="$STUB_DIR/resources-$name.txt"
    if [ "$(cat "$f" 2>/dev/null)" = error ]; then
      echo "An error occurred (Throttling) when calling the ListStackResources operation: Rate exceeded" >&2; exit 254
    fi
    cat "$f" 2>/dev/null || true ;;
  "cloudformation describe-stack-resources") cat "$STUB_DIR/failed-$name.json" 2>/dev/null || echo '[]' ;;
  "cloudformation describe-stack-events")
    f="$STUB_DIR/events-$name.txt"
    if [ ! -f "$f" ]; then echo None
    elif [ "$(cat "$f")" = error ]; then
      echo "An error occurred (Throttling) when calling the DescribeStackEvents operation: Rate exceeded" >&2; exit 254
    else cat "$f"; fi ;;
  "cloudformation delete-stack")
    shift 2; echo "delete-stack $*" >> "$STUB_DIR/calls.txt"
    if [ -f "$STUB_DIR/delete-fails-$name" ]; then
      echo "An error occurred (ValidationError) when calling the DeleteStack operation: rejected" >&2; exit 254
    fi ;;
  "apigateway get-rest-api")
    id=""; prev=""
    for a in "$@"; do [ "$prev" = "--rest-api-id" ] && id="$a"; prev="$a"; done
    f="$STUB_DIR/api-$id.txt"
    if [ ! -f "$f" ]; then
      echo "An error occurred (NotFoundException) when calling the GetRestApi operation: Invalid API identifier specified" >&2; exit 254
    elif [ "$(cat "$f")" = error ]; then
      echo "An error occurred (TooManyRequestsException) when calling the GetRestApi operation: Too Many Requests" >&2; exit 254
    else cat "$f"; fi ;;
  *) echo "stub aws: unexpected call: $args" >&2; exit 1 ;;
esac
`;
const SLEEP_STUB = `#!/usr/bin/env bash
echo "sleep $1" >> "$STUB_DIR/calls.txt"
`;

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

/** The step's dedented `run:` script. */
function script() {
	const lines = WORKFLOW.split('\n');
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

/**
 * A stack fixture. `apis` is the number of REST APIs it still owns (physical
 * ids api0, api1, …); `deletedApis` the number already deleted;
 * `failedHoursAgo` when it last entered DELETE_FAILED ('error' for a throttled
 * event lookup); `failed` its DELETE_FAILED resources as [logical id, type,
 * physical id]; `apiNames` the name of each REST API by physical id ('error'
 * for a throttled lookup). `listError` fails its resource listing; `nested`
 * names a nested stack, in `nestedStatus`, whose listing fails. `deleteFails`
 * rejects its delete-stack calls.
 */
function stack({
	status = 'DELETE_FAILED',
	createdHoursAgo = 10,
	apis = 0,
	deletedApis = 0,
	failedHoursAgo,
	failed = [],
	apiNames = {},
	listError = false,
	nested,
	nestedStatus = 'DELETE_FAILED',
	deleteFails = false,
} = {}) {
	return {
		status,
		createdHoursAgo,
		apis,
		deletedApis,
		failedHoursAgo,
		failed,
		apiNames,
		listError,
		nested,
		nestedStatus,
		deleteFails,
	};
}

/** Runs the step over `stacks` ({ name: stack() }) and returns the delete-stack and sleep calls it made, in order. */
function run(stacks, env = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'stack-sweep-'));
	dirs.push(dir);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	for (const [file, body] of [
		['aws', AWS_STUB],
		['sleep', SLEEP_STUB],
	]) {
		writeFileSync(join(bin, file), body);
		chmodSync(join(bin, file), 0o755);
	}
	writeFileSync(join(dir, 'stacks.txt'), `${Object.keys(stacks).join('\n')}\n`);
	for (const [name, s] of Object.entries(stacks)) {
		writeFileSync(
			join(dir, `info-${name}.txt`),
			`e2e-hosting-ssr\tNone\t${s.status}\t${hoursAgo(s.createdHoursAgo)}\n`,
		);
		const resources = [
			...Array.from({ length: s.apis }, (_, i) => `AWS::ApiGateway::RestApi\tapi${i}\tDELETE_FAILED`),
			...Array.from({ length: s.deletedApis }, (_, i) => `AWS::ApiGateway::RestApi\tgone${i}\tDELETE_COMPLETE`),
			...(s.nested ? [`AWS::CloudFormation::Stack\t${s.nested}\t${s.nestedStatus}`] : []),
		];
		writeFileSync(
			join(dir, `resources-${name}.txt`),
			s.listError ? 'error\n' : resources.map((r) => `${r}\n`).join(''),
		);
		if (s.nested) writeFileSync(join(dir, `resources-${s.nested}.txt`), 'error\n');
		if (s.deleteFails) writeFileSync(join(dir, `delete-fails-${name}`), '');
		for (const [id, apiName] of Object.entries(s.apiNames))
			writeFileSync(join(dir, `api-${id}.txt`), `${apiName}\n`);
		if (s.failed.length) writeFileSync(join(dir, `failed-${name}.json`), JSON.stringify(s.failed));
		if (s.failedHoursAgo !== undefined) {
			const events = s.failedHoursAgo === 'error' ? 'error' : hoursAgo(s.failedHoursAgo);
			writeFileSync(join(dir, `events-${name}.txt`), `${events}\n`);
		}
	}
	const file = join(dir, 'step.sh');
	writeFileSync(file, script());
	const r = spawnSync('bash', [file], {
		cwd: ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			...env,
			PATH: `${bin}:${process.env.PATH}`,
			STUB_DIR: dir,
			GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
		},
	});
	const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
	// The wait is the interval minus the time since the last paced delete, so
	// a second boundary crossed during the run can shorten it by one.
	const calls = read('calls.txt')
		.split('\n')
		.filter(Boolean)
		.map((c) => c.replace(/^sleep 3[01]$/, 'sleep ~31'));
	return { ...r, calls, summary: read('summary.md') };
}

const API = 'blocks-hosting-ssr-a';
const API2 = 'blocks-hosting-ssr-b';
const API3 = 'blocks-hosting-ssr-c';
const PLAIN = 'bb-test-plain';
const REST_API = 'AWS::ApiGateway::RestApi';
// A stuck stack's DELETE_FAILED REST APIs: the compute API, whose name the
// REST API sweep reclaims, and hosting's SSR origin API, whose name it doesn't.
const COMPUTE_API = ['DefaultComputeAPI5E5CE44A', REST_API, 'api0'];
const SSR_API = ['HostingCdnSsrRestApi1A2B3C4D', REST_API, 'api1'];

describe('e2e stack sweep step', () => {
	it('spaces the deletes of stacks that own a REST API, and only those', () => {
		const r = run({
			[API]: stack({ status: 'UPDATE_COMPLETE', apis: 1 }),
			[API2]: stack({ status: 'ROLLBACK_COMPLETE', apis: 1 }),
			[PLAIN]: stack({ status: 'UPDATE_COMPLETE' }),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [
			`delete-stack --stack-name ${API}`,
			'sleep ~31',
			`delete-stack --stack-name ${API2}`,
			`delete-stack --stack-name ${PLAIN}`,
		]);
		assert.match(r.summary, /Paced \(deletes a REST API, 31s apart\): 2/);
	});

	it('does not pace a stack whose REST API is already deleted', () => {
		const r = run({
			[API]: stack({ status: 'UPDATE_COMPLETE', apis: 1 }),
			[API2]: stack({ deletedApis: 1, failedHoursAgo: 0.1 }),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [`delete-stack --stack-name ${API}`, `delete-stack --stack-name ${API2}`]);
	});

	it('defers the stacks that own a REST API past the per-run cap to the next run', () => {
		const r = run(
			{
				[API]: stack({ status: 'UPDATE_COMPLETE', apis: 1 }),
				[API2]: stack({ status: 'UPDATE_COMPLETE', apis: 2 }),
				[API3]: stack({ status: 'UPDATE_COMPLETE', apis: 1 }),
				[PLAIN]: stack({ status: 'UPDATE_COMPLETE' }),
			},
			{ CLEANUP_MAX_PACED_DELETES: '2' },
		);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [
			`delete-stack --stack-name ${API}`,
			'sleep ~31',
			`delete-stack --stack-name ${API2}`,
			`delete-stack --stack-name ${PLAIN}`,
		]);
		assert.match(
			r.summary,
			/Deferred to the next run \(paced-delete cap of 2 reached, or resources not listed\): 1/,
		);
	});

	it('leaves a stack whose delete is already in progress alone', () => {
		const r = run({ [API]: stack({ status: 'DELETE_IN_PROGRESS', apis: 1 }) });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, []);
		assert.match(r.summary, /Skipped \(delete already in progress\): 1/);
	});

	it('deletes a stack DELETE_FAILED for over an hour once, retaining its failed REST API, without pacing', () => {
		// Created 3 hours ago, so its age alone would not mark it stuck.
		const r = run({
			[API]: stack({
				createdHoursAgo: 3,
				failedHoursAgo: 2,
				apis: 1,
				failed: [COMPUTE_API],
				apiNames: { api0: 'DefaultComputeAPI' },
			}),
			[API2]: stack({ status: 'UPDATE_COMPLETE', apis: 1 }),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [
			`delete-stack --stack-name ${API} --retain-resources DefaultComputeAPI5E5CE44A`,
			`delete-stack --stack-name ${API2}`,
		]);
		assert.match(r.summary, /Retain-resources deletes \(DELETE_FAILED for over 1h\): 1/);
	});

	it('retries a stack that entered DELETE_FAILED less than an hour ago plainly, however old it is', () => {
		const r = run({
			[API]: stack({
				createdHoursAgo: 72,
				failedHoursAgo: 0.3,
				apis: 1,
				failed: [COMPUTE_API],
				apiNames: { api0: 'DefaultComputeAPI' },
			}),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [`delete-stack --stack-name ${API}`]);
		assert.match(r.summary, /Retain-resources deletes \(DELETE_FAILED for over 1h\): 0/);
	});

	it('retains nothing when it cannot tell how long the stack has been DELETE_FAILED', () => {
		const r = run({
			[API]: stack({
				failedHoursAgo: 'error',
				apis: 1,
				failed: [COMPUTE_API],
				apiNames: { api0: 'DefaultComputeAPI' },
			}),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [`delete-stack --stack-name ${API}`]);
	});

	it('retries plainly and warns when no failed resource is retainable', () => {
		const r = run({
			[API]: stack({
				failedHoursAgo: 2,
				apis: 1,
				failed: [['HostingCdnRouteStoreKeys6C9F37BC', 'AWS::CloudFormation::CustomResource']],
			}),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [`delete-stack --stack-name ${API}`]);
		assert.match(r.stdout, /::warning::blocks-hosting-ssr-a has non-reclaimable DELETE_FAILED blocker\(s\)/);
	});

	it('does not retain a REST API whose name the REST API sweep does not reclaim', () => {
		const r = run({
			[API]: stack({ failedHoursAgo: 2, apis: 2, failed: [SSR_API], apiNames: { api1: 'SsrRestApi' } }),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [`delete-stack --stack-name ${API}`]);
		assert.match(
			r.stdout,
			/::warning::.*HostingCdnSsrRestApi1A2B3C4D \(REST API 'SsrRestApi', which the REST API sweep/,
		);
		assert.match(r.summary, /Retain-resources deletes \(DELETE_FAILED for over 1h\): 0/);
	});

	it('retains only the REST APIs the sweep reclaims, and paces the delete of the rest', () => {
		const r = run({
			[API]: stack({ status: 'UPDATE_COMPLETE', apis: 1 }),
			[API2]: stack({
				failedHoursAgo: 2,
				apis: 2,
				failed: [COMPUTE_API, SSR_API],
				apiNames: { api0: 'DefaultComputeAPI', api1: 'SsrRestApi' },
			}),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [
			`delete-stack --stack-name ${API}`,
			'sleep ~31',
			`delete-stack --stack-name ${API2} --retain-resources DefaultComputeAPI5E5CE44A`,
		]);
	});

	it('retains nothing when a REST API name lookup fails', () => {
		const r = run({
			[API]: stack({
				failedHoursAgo: 2,
				apis: 2,
				failed: [COMPUTE_API, SSR_API],
				apiNames: { api0: 'DefaultComputeAPI', api1: 'error' },
			}),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [`delete-stack --stack-name ${API}`]);
		assert.match(r.stdout, /could not look up REST API api1/);
	});

	it('defers a stack whose resources cannot be listed, even past the cap', () => {
		const r = run(
			{
				[API]: stack({ status: 'UPDATE_COMPLETE', apis: 1 }),
				[API2]: stack({ status: 'UPDATE_COMPLETE', listError: true }),
				[PLAIN]: stack({ status: 'UPDATE_COMPLETE' }),
			},
			{ CLEANUP_MAX_PACED_DELETES: '1' },
		);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [`delete-stack --stack-name ${API}`, `delete-stack --stack-name ${PLAIN}`]);
		assert.match(r.summary, /or resources not listed\): 1/);
		assert.match(r.stdout, /::warning::1 stack\(s\) deferred because list-stack-resources failed/);
	});

	it('defers a stack whose live nested stack cannot be listed', () => {
		const r = run({ [API]: stack({ status: 'UPDATE_COMPLETE', nested: 'blocks-hosting-ssr-a-nested' }) });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, []);
		assert.match(r.stdout, /list-stack-resources failed for blocks-hosting-ssr-a-nested: .*Throttling/);
		assert.match(r.summary, /or resources not listed\): 1/);
	});

	it('does not walk a nested stack that is already deleted, so its expired record cannot defer the parent', () => {
		const r = run({
			[API]: stack({
				status: 'DELETE_FAILED',
				failedHoursAgo: 0.1,
				nested: 'blocks-hosting-ssr-a-nested',
				nestedStatus: 'DELETE_COMPLETE',
			}),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [`delete-stack --stack-name ${API}`]);
		assert.doesNotMatch(r.stdout, /list-stack-resources failed/);
		assert.match(r.summary, /or resources not listed\): 0/);
	});

	it('sends a stuck stack one delete only: a rejected retaining delete is not followed by a plain one', () => {
		// A second delete in the same run would start the plain delete the
		// retain exists to avoid, or be rejected as a delete already in progress.
		const r = run({
			[API]: stack({
				failedHoursAgo: 2,
				apis: 1,
				failed: [COMPUTE_API],
				apiNames: { api0: 'DefaultComputeAPI' },
				deleteFails: true,
			}),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.calls, [`delete-stack --stack-name ${API} --retain-resources DefaultComputeAPI5E5CE44A`]);
		assert.match(r.summary, /Delete-stack call failed: 1/);
		assert.match(r.summary, /Retain-resources deletes \(DELETE_FAILED for over 1h\): 0/);
	});
});
