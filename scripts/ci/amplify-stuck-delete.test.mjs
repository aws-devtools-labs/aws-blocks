// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/amplify-stuck-delete.sh, and for the Amplify sweep
// step of .github/workflows/cleanup-stacks.yml that runs it. Both run against a
// stub `aws` on PATH; nothing reaches AWS.
//
// The fixtures replay a sandbox that sat in DELETE_FAILED for days: its deploy
// failed while the Todo table was being created, and every delete then failed
// on Amplify's table manager being denied dynamodb:DescribeTable.
//
// Run: node --test scripts/ci/amplify-stuck-delete.test.mjs
// The step tests need GNU date (the step runs `date -d`), so they skip elsewhere.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./amplify-stuck-delete.sh', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/cleanup-stacks.yml', import.meta.url));
const STEP = 'Find and delete stale Amplify sandbox stacks';

// A stub `aws` that serves canned output from its fixture dir and logs every
// call. Files are keyed by the --stack-name value with every character outside
// [A-Za-z0-9-] replaced by `_` (see key() below).
//   list-stacks                    -> stacks.txt; with a length() query, 0;
//                                     for DELETE_COMPLETE, deleted.json (exit
//                                     254 if list-deleted-fails exists)
//   describe-stacks, Tags query    -> info-<key>.txt (the step's tag/status/date)
//   describe-stacks, Parameters    -> params-<key>.json, else exit 254
//   describe-stacks, other query   -> status-<key>.txt, else exit 254
//   get-template                   -> template-<key>.json, else exit 254
//   list-stack-resources, --query  -> empty (the step's bucket walk)
//   list-stack-resources           -> resources-<key>.json; exit 254 if
//                                     list-fails-<key> exists
//   describe-stack-events          -> events-<key>.json, else exit 254
//   dynamodb describe-table        -> ACTIVE; exit 254 with ResourceNotFound
//                                     if table-gone-<name> exists, AccessDenied
//                                     if table-denied-<name> exists
//   delete-stack                   -> appends the call to deletes.txt; exit 254
//                                     if delete-fails-<key> exists
// Its errors quote the stack id, ARN and all, as the real CLI's do.
const STUB = `#!/usr/bin/env bash
d=$STUB_DIR
echo "$*" >> "$d/calls.txt"
arg() { local f=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$f" ] && { printf '%s' "$2"; return; }; shift; done; }
stack=$(arg --stack-name "$@")
k=$(printf '%s' "$stack" | tr -c 'A-Za-z0-9-' '_')
q=$(arg --query "$@")
case "$1 $2" in
'cloudformation list-stacks')
	case " $* " in *' DELETE_COMPLETE '*)
		if [ -f "$d/list-deleted-fails" ]; then echo "An error occurred (Throttling) for stack $(cat "$d/list-deleted-fails")" >&2; exit 254; fi
		cat "$d/deleted.json" 2>/dev/null || echo '{"StackSummaries":[]}'
		exit 0 ;;
	esac
	case "$q" in length*) echo 0 ;; *) cat "$d/stacks.txt" 2>/dev/null ;; esac ;;
'cloudformation describe-stacks')
	case "$q" in
	*Tags*) cat "$d/info-$k.txt" ;;
	*Parameters*) cat "$d/params-$k.json" 2>/dev/null || { echo "throttled" >&2; exit 254; } ;;
	*) cat "$d/status-$k.txt" 2>/dev/null || { echo "stack $stack does not exist" >&2; exit 254; } ;;
	esac ;;
'cloudformation get-template')
	cat "$d/template-$k.json" 2>/dev/null || { echo "throttled" >&2; exit 254; } ;;
'cloudformation list-stack-resources')
	[ -n "$q" ] && exit 0
	if [ -f "$d/list-fails-$k" ]; then echo "An error occurred (Throttling) for stack $stack" >&2; exit 254; fi
	cat "$d/resources-$k.json" 2>/dev/null || echo '{"StackResourceSummaries":[]}' ;;
'cloudformation describe-stack-events')
	cat "$d/events-$k.json" 2>/dev/null || { echo "throttled" >&2; exit 254; } ;;
'dynamodb describe-table')
	t=$(arg --table-name "$@")
	if [ -f "$d/table-gone-$t" ]; then echo "An error occurred (ResourceNotFoundException) when calling the DescribeTable operation: Requested resource not found: Table: $t not found" >&2; exit 254; fi
	if [ -f "$d/table-denied-$t" ]; then echo "An error occurred (AccessDeniedException) when calling the DescribeTable operation: User: arn:aws:sts::123456789012:assumed-role/x is not authorized" >&2; exit 254; fi
	echo ACTIVE ;;
'cloudformation delete-stack')
	echo "$*" >> "$d/deletes.txt"
	if [ -f "$d/delete-fails-$k" ]; then
		echo "An error occurred (ValidationError) when calling the DeleteStack operation: Stack with id $stack is invalid" >&2
		exit 254
	fi ;;
*) echo "stub aws: unexpected call: $*" >&2; exit 2 ;;
esac
`;

const key = (stack) => stack.replace(/[^A-Za-z0-9-]/g, '_');

// The stuck sandbox, as CloudFormation reported it (account id replaced).
const ROOT = 'amplify-amplifygen2-amp716639251-sandbox-95f5ae461b';
const arn = (name, id) => `arn:aws:cloudformation:us-east-1:123456789012:stack/${name}/${id}`;
const DATA = arn(`${ROOT}-data7552DF31-XHIQ9R8EQ2SD`, '3892d5b0-cbcc-11f1-88f7-0e9c1d58f497');
const AUTH = arn(`${ROOT}-auth179371D7-AX5FUZP3J8PK`, '240a7cb0-cbcc-11f1-995b-0afff00f2571');
const TODO_NAME = 'amplify-amplifygen2-amp716639251-sandbox-95-amplifyDataTodoNestedStackTodoNestedStackR-1MQN5NRL6HFG7';
const TODO = arn(TODO_NAME, '76f39d80-cbcc-11f1-8eb7-0affe9a0842d');
const MANAGER = arn(
	'amplify-amplifygen2-amp716639251-sandbox-95-amplifyDataAmplifyTableManagerNestedStackA-1CR72HSBF7REB',
	'3e2b7b80-cbcc-11f1-bce2-0affe8ceea2b',
);
// The placeholder id CloudFormation gave the cancelled resource, and the table
// Amplify had already created under its real name.
const TABLE_ID = `${TODO_NAME}-TodoTable-1T67GCT6E2YR7`;
const API_ID = 'hne2o3d2bvejxciy2bw4prehma';
const API_ID_PARAM = 'referencetoamplifyamplifygen2amp716639251sandbox95f5ae461bdataamplifyDataGraphQLAPI41C3A2F6ApiId';
const REAL_TABLE = `Todo-${API_ID}-NONE`;
const DENIED =
	'Received response status [FAILED] from custom resource. Message returned: User: ' +
	'arn:aws:sts::123456789012:assumed-role/amplify-amplifygen2-amp71-AmplifyManagedTableOnEven-IxzUrUQufakC/' +
	'amplify-amplifygen2-amp71-TableManagerCustomProvid-i5Pxl9aQDt74 is not authorized to perform: ' +
	`dynamodb:DescribeTable on resource: arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE_ID} ` +
	'because no identity-based policy allows the dynamodb:DescribeTable action';

const resource = (LogicalResourceId, ResourceType, ResourceStatus, PhysicalResourceId) => ({
	LogicalResourceId,
	ResourceType,
	ResourceStatus,
	PhysicalResourceId,
});
const resources = (...items) => JSON.stringify({ StackResourceSummaries: items });
const event = (LogicalResourceId, ResourceStatus, ResourceStatusReason) => ({
	LogicalResourceId,
	ResourceStatus,
	ResourceStatusReason,
});
// Newest first, as describe-stack-events returns them.
const events = (...items) => JSON.stringify({ StackEvents: items });

const TABLE = 'Custom::AmplifyDynamoDBTable';
const NESTED = 'AWS::CloudFormation::Stack';

/** Fixture files for the stuck sandbox; `over` replaces or adds files. */
function sandbox(over = {}) {
	return {
		[`status-${key(ROOT)}.txt`]: 'DELETE_FAILED\n',
		[`resources-${key(ROOT)}.json`]: resources(
			resource('auth179371D7', NESTED, 'CREATE_COMPLETE', AUTH),
			resource('data7552DF31', NESTED, 'DELETE_FAILED', DATA),
		),
		[`status-${key(DATA)}.txt`]: 'DELETE_FAILED\n',
		[`resources-${key(DATA)}.json`]: resources(
			resource('amplifyDataAmplifyTableManagerNestedStackA', NESTED, 'CREATE_COMPLETE', MANAGER),
			resource('amplifyDataTodoNestedStackTodoNestedStackResource551CEA56', NESTED, 'DELETE_FAILED', TODO),
		),
		[`status-${key(TODO)}.txt`]: 'DELETE_FAILED\n',
		[`resources-${key(TODO)}.json`]: resources(
			resource('TodoTable', TABLE, 'DELETE_FAILED', TABLE_ID),
			resource('TodoIAMRole', 'AWS::IAM::Role', 'CREATE_COMPLETE', 'role'),
		),
		[`events-${key(TODO)}.json`]: events(
			event(TODO_NAME, 'DELETE_FAILED', 'The following resource(s) failed to delete: [TodoTable].'),
			event('TodoTable', 'DELETE_FAILED', DENIED),
			event('TodoTable', 'DELETE_IN_PROGRESS'),
			event('TodoTable', 'CREATE_FAILED', 'Resource creation cancelled'),
			event('TodoTable', 'CREATE_IN_PROGRESS'),
		),
		// get-template returns a JSON template as an object.
		[`template-${key(TODO)}.json`]: JSON.stringify({
			TemplateBody: {
				Resources: {
					TodoTable: {
						Type: TABLE,
						Properties: { tableName: { 'Fn::Join': ['', ['Todo-', { Ref: API_ID_PARAM }, '-NONE']] } },
					},
				},
			},
		}),
		[`params-${key(TODO)}.json`]: JSON.stringify([
			{ ParameterKey: 'DynamoDBBillingMode', ParameterValue: 'PAY_PER_REQUEST' },
			{ ParameterKey: API_ID_PARAM, ParameterValue: API_ID },
		]),
		...over,
	};
}

const RETAIN_TODO = `cloudformation delete-stack --stack-name ${TODO} --retain-resources TodoTable`;

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fixture dir holding the stub `aws` plus `files`. */
function fixture(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'amplify-stuck-delete-'));
	dirs.push(dir);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'aws'), STUB);
	chmodSync(join(bin, 'aws'), 0o755);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

function run(dir, args, env = {}, cwd = ROOT_DIR) {
	const r = spawnSync('bash', args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			AMPLIFY_RETAINED_FILE: join(dir, 'report.md'),
			...env,
			PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
			STUB_DIR: dir,
			GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
		},
	});
	const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
	return {
		status: r.status,
		stdout: r.stdout,
		stderr: r.stderr,
		summary: read('summary.md'),
		report: read('report.md'),
		deletes: read('deletes.txt').split('\n').filter(Boolean),
		calls: read('calls.txt'),
	};
}

const runScript = (dir, stack = ROOT) => run(dir, [SCRIPT, stack]);

const GNU_DATE = spawnSync('date', ['-d', '@0', '+%s'], { encoding: 'utf8' }).stdout?.trim() === '0';

/** The `run:` script of the Amplify sweep step, dedented. */
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

/**
 * Runs the step against `files`, with the root listed, tagged and `status`.
 * `cwd` replaces the repo root the step runs scripts/ci/ from.
 */
function runStep(files, { status = 'DELETE_FAILED', created = '2026-10-19T14:48:22.894Z', cwd } = {}) {
	const dir = fixture({
		'stacks.txt': `${ROOT}\n`,
		[`info-${key(ROOT)}.txt`]: `sandbox\t${status}\t${created}\n`,
		...files,
	});
	const file = join(dir, 'step.sh');
	writeFileSync(file, stepScript());
	return run(dir, [file], { AMPLIFY_RETAINED_FILE: '' }, cwd);
}

const NO_ACCOUNT = /123456789012/;

describe('amplify-stuck-delete.sh', () => {
	it('deletes the nested stack that holds the stuck table, retaining only the table, and exits 3', () => {
		const r = runScript(fixture(sandbox()));
		assert.equal(r.status, 3, r.stdout);
		assert.deepEqual(r.deletes, [RETAIN_TODO]);
	});

	it('names the real table, which survives the retain, in a warning and the report', () => {
		const r = runScript(fixture(sandbox()));
		assert.match(r.stdout, new RegExp(`::warning::retained TodoTable of ${TODO_NAME}; DynamoDB table ${REAL_TABLE} `));
		assert.equal(
			r.report,
			`- retained: TodoTable (Custom::AmplifyDynamoDBTable) in ${TODO_NAME}; ` +
				`delete DynamoDB table ${REAL_TABLE} by hand if it still exists\n`,
		);
	});

	it('says so when the real table name cannot be resolved', () => {
		const files = sandbox();
		delete files[`template-${key(TODO)}.json`];
		const r = runScript(fixture(files));
		assert.equal(r.status, 3, r.stdout);
		assert.match(r.report, /delete DynamoDB table \(name unresolved, see the stack template\) by hand/);
	});

	it('prints stack names, never ARNs (they carry the account id)', () => {
		const r = runScript(fixture(sandbox()));
		// The script merges its stderr into stdout.
		assert.doesNotMatch(r.stdout, NO_ACCOUNT);
		assert.doesNotMatch(r.report, NO_ACCOUNT);
	});

	it('never deletes the root or the data stack', () => {
		const r = runScript(fixture(sandbox()));
		assert.ok(!r.deletes.some((d) => d.includes(`--stack-name ${ROOT} `) || d.endsWith(`--stack-name ${ROOT}`)));
		assert.ok(!r.deletes.some((d) => d.includes(DATA)));
	});

	for (const done of ['CREATE_COMPLETE', 'UPDATE_COMPLETE']) {
		it(`does not retain a table resource that reached ${done}`, () => {
			const r = runScript(
				fixture(
					sandbox({
						// A first create failed; a later operation completed.
						[`events-${key(TODO)}.json`]: events(
							event('TodoTable', 'DELETE_FAILED', DENIED),
							event('TodoTable', done),
							event('TodoTable', 'CREATE_FAILED', 'Resource creation cancelled'),
						),
					}),
				),
			);
			assert.equal(r.status, 0, r.stdout);
			assert.deepEqual(r.deletes, []);
			assert.match(
				r.stdout,
				/::warning::.*TodoNestedStack.*left for the plain retry \(not retained\): TodoTable \(Custom::AmplifyDynamoDBTable\)/,
			);
			assert.match(r.report, /^- left in place: TodoTable \(Custom::AmplifyDynamoDBTable\) in /m);
		});
	}

	it('does not retain a table resource whose create never failed', () => {
		const r = runScript(
			fixture(sandbox({ [`events-${key(TODO)}.json`]: events(event('TodoTable', 'DELETE_FAILED', DENIED)) })),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
	});

	it('does not retain a table resource that fails to delete for another reason', () => {
		const r = runScript(
			fixture(
				sandbox({
					[`events-${key(TODO)}.json`]: events(
						event('TodoTable', 'DELETE_FAILED', 'Rate exceeded'),
						event('TodoTable', 'CREATE_FAILED', 'Resource creation cancelled'),
					),
				}),
			),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
		assert.match(r.report, /^- left in place: TodoTable /m);
	});

	it('does not retain when the denial names another table', () => {
		const r = runScript(
			fixture(
				sandbox({
					[`events-${key(TODO)}.json`]: events(
						event('TodoTable', 'DELETE_FAILED', DENIED.replace(TABLE_ID, REAL_TABLE)),
						event('TodoTable', 'CREATE_FAILED', 'Resource creation cancelled'),
					),
				}),
			),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
	});

	it('does not retain when the event history cannot be read', () => {
		const files = sandbox();
		delete files[`events-${key(TODO)}.json`];
		const r = runScript(fixture(files));
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
	});

	it('retains nothing when the same stack has another failed resource', () => {
		const r = runScript(
			fixture(
				sandbox({
					[`resources-${key(TODO)}.json`]: resources(
						resource('TodoTable', TABLE, 'DELETE_FAILED', TABLE_ID),
						resource('TodoIAMRole', 'AWS::IAM::Role', 'DELETE_FAILED', 'role'),
					),
				}),
			),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
		assert.match(r.stdout, /::warning::.*TodoIAMRole \(AWS::IAM::Role\)/);
	});

	it('does not retain a failed resource of the root itself', () => {
		const r = runScript(
			fixture({
				[`status-${key(ROOT)}.txt`]: 'DELETE_FAILED\n',
				[`resources-${key(ROOT)}.json`]: resources(resource('TodoTable', TABLE, 'DELETE_FAILED', TABLE_ID)),
				[`events-${key(ROOT)}.json`]: events(
					event('TodoTable', 'DELETE_FAILED', DENIED),
					event('TodoTable', 'CREATE_FAILED', 'Resource creation cancelled'),
				),
			}),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
	});

	it('leaves a nested stack that is not DELETE_FAILED to the plain retry', () => {
		const r = runScript(fixture(sandbox({ [`status-${key(TODO)}.txt`]: 'DELETE_IN_PROGRESS\n' })));
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
	});

	it('warns and exits 0 when the retaining delete-stack call fails', () => {
		const r = runScript(fixture(sandbox({ [`delete-fails-${key(TODO)}`]: '' })));
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.stdout, /::warning::delete-stack with --retain-resources failed for .*TodoNestedStack/);
		assert.equal(r.report, '');
	});

	it('does not loop on a nested stack that points back at an ancestor', { timeout: 10_000 }, () => {
		const r = runScript(
			fixture(
				sandbox({
					[`resources-${key(TODO)}.json`]: resources(
						resource('TodoTable', TABLE, 'DELETE_FAILED', TABLE_ID),
						resource('Loop', NESTED, 'DELETE_FAILED', DATA),
					),
				}),
			),
		);
		// Terminates; the failed nested stack keeps TodoNestedStack from being retained.
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
	});

	it('does nothing once the nested stack is gone (the next run)', () => {
		const r = runScript(
			fixture(
				sandbox({
					[`status-${key(TODO)}.txt`]: 'DELETE_COMPLETE\n',
					[`resources-${key(TODO)}.json`]: resources(
						resource('TodoTable', TABLE, 'DELETE_SKIPPED', TABLE_ID),
						resource('TodoIAMRole', 'AWS::IAM::Role', 'DELETE_COMPLETE', 'role'),
					),
				}),
			),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
		assert.equal(r.report, '');
	});

	it('retains every stuck table of a stack, naming each table it can resolve', () => {
		const r = runScript(
			fixture(
				sandbox({
					[`resources-${key(TODO)}.json`]: resources(
						resource('TodoTable', TABLE, 'DELETE_FAILED', TABLE_ID),
						resource('NoteTable', TABLE, 'DELETE_FAILED', `${TODO_NAME}-NoteTable-ABC`),
					),
					[`events-${key(TODO)}.json`]: events(
						event('NoteTable', 'DELETE_FAILED', DENIED.replace(TABLE_ID, `${TODO_NAME}-NoteTable-ABC`)),
						event('NoteTable', 'CREATE_FAILED', 'Resource creation cancelled'),
						event('TodoTable', 'DELETE_FAILED', DENIED),
						event('TodoTable', 'CREATE_FAILED', 'Resource creation cancelled'),
					),
				}),
			),
		);
		assert.equal(r.status, 3, r.stdout);
		assert.deepEqual(r.deletes, [`${RETAIN_TODO} NoteTable`]);
		assert.match(r.report, new RegExp(`^- retained: TodoTable .* delete DynamoDB table ${REAL_TABLE} by hand`, 'm'));
		assert.match(r.report, /^- retained: NoteTable .* delete DynamoDB table \(name unresolved, see the stack template\)/m);
	});

	it('leaves a name unresolved rather than guess it when a parameter is missing', () => {
		const r = runScript(
			fixture(
				sandbox({
					[`params-${key(TODO)}.json`]: JSON.stringify([
						{ ParameterKey: 'DynamoDBBillingMode', ParameterValue: 'PAY_PER_REQUEST' },
					]),
				}),
			),
		);
		assert.equal(r.status, 3, r.stdout);
		assert.match(r.report, /delete DynamoDB table \(name unresolved, see the stack template\) by hand/);
		assert.doesNotMatch(r.report, /Todo--NONE/);
	});

	it('retains when the denial ends at the table ARN', () => {
		const files = sandbox();
		files[`events-${key(TODO)}.json`] = events(
			event('TodoTable', 'DELETE_FAILED', DENIED.slice(0, DENIED.indexOf(TABLE_ID) + TABLE_ID.length)),
			event('TodoTable', 'CREATE_FAILED', 'Resource creation cancelled'),
		);
		const r = runScript(fixture(files));
		assert.equal(r.status, 3, r.stdout);
		assert.deepEqual(r.deletes, [RETAIN_TODO]);
	});

	it('does not retain when the denial names a longer table name', () => {
		const r = runScript(
			fixture(
				sandbox({
					[`events-${key(TODO)}.json`]: events(
						event('TodoTable', 'DELETE_FAILED', DENIED.replace(TABLE_ID, `${TABLE_ID}-old`)),
						event('TodoTable', 'CREATE_FAILED', 'Resource creation cancelled'),
					),
				}),
			),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
	});

	it('does not retain in a stack that also has a failed nested stack', () => {
		const CHILD = arn('child', '00000000-0000-0000-0000-000000000000');
		const r = runScript(
			fixture(
				sandbox({
					[`resources-${key(TODO)}.json`]: resources(
						resource('TodoTable', TABLE, 'DELETE_FAILED', TABLE_ID),
						resource('Child', NESTED, 'DELETE_FAILED', CHILD),
					),
				}),
			),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
		assert.match(r.stdout, /also has a failed nested stack/);
	});

	it('warns, without the account id, when a stack cannot be listed', () => {
		const r = runScript(fixture(sandbox({ [`list-fails-${key(TODO)}`]: '' })));
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
		assert.match(r.stdout, /::warning::could not list the resources of .*TodoNestedStack/);
		assert.doesNotMatch(r.stdout + r.stderr, NO_ACCOUNT);
	});

	it('masks the account id in a failed delete-stack error', () => {
		const r = runScript(fixture(sandbox({ [`delete-fails-${key(TODO)}`]: '' })));
		assert.match(r.stdout + r.stderr, /Stack with id arn:aws:cloudformation:us-east-1:<account>:stack\//);
		assert.doesNotMatch(r.stdout + r.stderr, NO_ACCOUNT);
	});

	it('does not retain, or report, a stack still blocked by a bucket the caller just emptied', () => {
		const r = runScript(
			fixture(
				sandbox({
					[`resources-${key(TODO)}.json`]: resources(
						resource('TodoTable', TABLE, 'DELETE_FAILED', TABLE_ID),
						resource('Bucket', 'AWS::S3::Bucket', 'DELETE_FAILED', 'bucket'),
					),
				}),
			),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, []);
		assert.doesNotMatch(r.stdout, /::warning::/);
		assert.match(r.report, /^- blocked by bucket Bucket in .*TodoNestedStack.* \(emptied this run, retried next run\)$/m);
		assert.doesNotMatch(r.report, /retained|left in place/);
	});

	it('masks the account id even when the guard variable is inherited', () => {
		const r = run(fixture(sandbox({ [`delete-fails-${key(TODO)}`]: '' })), [SCRIPT, ROOT], {
			_AMPLIFY_STUCK_DELETE_MASKED: '1',
		});
		assert.doesNotMatch(r.stdout + r.stderr, NO_ACCOUNT);
	});

	it('rejects a missing argument', () => {
		const r = run(fixture({}), [SCRIPT]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /usage/);
	});
});

// The model stack after the retain, as list-stacks reports it once deleted:
// CloudFormation keeps a deleted stack's record, resources and template for
// 90 days. It lived from the failed deploy to the retain, over 6 h later.
// Like the real record of the stuck sandbox, it has no ParentId, and its
// DeletionTime is that of the delete that succeeded.
const deletedTodo = (over = {}) => ({
	StackId: TODO,
	StackName: TODO_NAME,
	StackStatus: 'DELETE_COMPLETE',
	CreationTime: '2026-10-19T14:50:01.123000+00:00',
	DeletionTime: '2026-10-21T08:12:40.456000+00:00',
	...over,
});
const deleted = (...items) => JSON.stringify({ StackSummaries: items });
/** Fixture files for a later run: the retain went through and the model stack is gone. */
const afterRetain = (over = {}) =>
	sandbox({
		'deleted.json': deleted(deletedTodo()),
		[`status-${key(TODO)}.txt`]: 'DELETE_COMPLETE\n',
		[`resources-${key(TODO)}.json`]: resources(
			resource('TodoTable', TABLE, 'DELETE_SKIPPED', TABLE_ID),
			resource('TodoIAMRole', 'AWS::IAM::Role', 'DELETE_COMPLETE', 'role'),
		),
		...over,
	});
const runLeftovers = (dir) => run(dir, [SCRIPT, '--leftovers']);

describe('amplify-stuck-delete.sh --leftovers', () => {
	it('reports a table retained on an earlier run, by its real name, and deletes nothing', () => {
		const r = runLeftovers(fixture(afterRetain()));
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.deletes, []);
		assert.match(
			r.stdout,
			new RegExp(`^  ${TODO_NAME} retained TodoTable when it was deleted on 2026-10-21; DynamoDB table ${REAL_TABLE} may still exist$`, 'm'),
		);
		// One warning per run, however many tables: the summary lists them.
		assert.match(r.stdout, /^::warning::1 DynamoDB table\(s\) retained by earlier sweeps may still exist/m);
		assert.equal(r.stdout.match(/::warning::/g).length, 1);
		assert.match(
			r.report,
			new RegExp(`^- leftover: TodoTable \\(${TABLE}\\) of ${TODO_NAME}, deleted 2026-10-21; delete DynamoDB table ${REAL_TABLE} by hand if it still exists$`, 'm'),
		);
		assert.doesNotMatch(r.stdout + r.stderr + r.report, NO_ACCOUNT);
	});

	it('does not read the resources of a nested stack that lived under 5 hours (an ordinary teardown)', () => {
		const r = runLeftovers(
			fixture(afterRetain({ 'deleted.json': deleted(deletedTodo({ DeletionTime: '2026-10-19T19:40:01.123000+00:00' })) })),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.equal(r.report, '');
		assert.doesNotMatch(r.calls, /list-stack-resources/);
	});

	it('says nothing more of a table that DescribeTable reports gone', () => {
		const r = runLeftovers(fixture(afterRetain({ [`table-gone-${REAL_TABLE}`]: '' })));
		assert.equal(r.status, 0, r.stdout);
		assert.equal(r.report, '');
		assert.doesNotMatch(r.stdout, /::warning::/);
		assert.match(r.stdout, new RegExp(`DynamoDB table ${REAL_TABLE} is gone`));
	});

	it('still reports the table when DescribeTable is denied', () => {
		const r = runLeftovers(fixture(afterRetain({ [`table-denied-${REAL_TABLE}`]: '' })));
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.report, /^- leftover: TodoTable /m);
		assert.match(r.stdout, new RegExp(`DescribeTable failed for ${REAL_TABLE}, so whether it still exists is unknown: .*AccessDeniedException`));
		assert.match(r.stdout, /^::warning::1 DynamoDB table/m);
		assert.doesNotMatch(r.stdout + r.stderr, NO_ACCOUNT);
	});

	it('reports a stack that lived just over 5 hours', () => {
		const r = runLeftovers(
			fixture(afterRetain({ 'deleted.json': deleted(deletedTodo({ DeletionTime: '2026-10-19T20:00:01.123000+00:00' })) })),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.report, /^- leftover: TodoTable /m);
	});

	it('counts every table of every deleted stack in its one warning', () => {
		const OTHER_NAME = TODO_NAME.replace('TodoNestedStackTodoNestedStackR-1MQN5NRL6HFG7', 'NoteNestedStackNoteNestedStackR-2ABC');
		const OTHER = arn(OTHER_NAME, '11111111-2222-3333-4444-555555555555');
		const r = runLeftovers(
			fixture(
				afterRetain({
					'deleted.json': deleted(deletedTodo(), deletedTodo({ StackId: OTHER, StackName: OTHER_NAME })),
					[`resources-${key(TODO)}.json`]: resources(
						resource('TodoTable', TABLE, 'DELETE_SKIPPED', TABLE_ID),
						resource('TagTable', TABLE, 'DELETE_SKIPPED', `${TABLE_ID}-tag`),
					),
					[`resources-${key(OTHER)}.json`]: resources(resource('NoteTable', TABLE, 'DELETE_SKIPPED', 'note')),
				}),
			),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.stdout, /^::warning::3 DynamoDB table\(s\) retained by earlier sweeps/m);
		assert.deepEqual(
			r.report.split('\n').filter(Boolean).map((l) => l.split(' ')[2]),
			['TodoTable', 'TagTable', 'NoteTable'],
		);
	});

	it('warns and goes on when one deleted stack cannot be listed', () => {
		const r = runLeftovers(fixture(afterRetain({ [`list-fails-${key(TODO)}`]: '' })));
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.stdout, new RegExp(`^::warning::could not list the resources of deleted stack ${TODO_NAME}`, 'm'));
		assert.doesNotMatch(r.stdout + r.stderr, NO_ACCOUNT);
	});

	it('ignores the deleted stacks of other apps', () => {
		const r = runLeftovers(
			fixture(afterRetain({ 'deleted.json': deleted(deletedTodo({ StackName: 'amplify-myapp-x-sandbox-1-y' })) })),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.equal(r.report, '');
		assert.doesNotMatch(r.calls, /list-stack-resources/);
	});

	it('reports nothing for a retained resource that is not a table', () => {
		const r = runLeftovers(
			fixture(afterRetain({ [`resources-${key(TODO)}.json`]: resources(resource('TodoIAMRole', 'AWS::IAM::Role', 'DELETE_SKIPPED', 'role')) })),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.equal(r.report, '');
	});

	it('reports nothing for a table resource the delete removed', () => {
		const r = runLeftovers(
			fixture(afterRetain({ [`resources-${key(TODO)}.json`]: resources(resource('TodoTable', TABLE, 'DELETE_COMPLETE', TABLE_ID)) })),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.equal(r.report, '');
		assert.doesNotMatch(r.stdout, /::warning::/);
	});

	it('warns, without the account id, when the deleted stacks cannot be listed', () => {
		const r = runLeftovers(fixture(afterRetain({ 'list-deleted-fails': TODO })));
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.stdout, /::warning::could not list deleted stacks, .*: An error occurred \(Throttling\)/);
		assert.doesNotMatch(r.stdout + r.stderr, NO_ACCOUNT);
	});

	it('still names the table, unresolved, when its deleted template cannot be read', () => {
		const files = afterRetain();
		delete files[`template-${key(TODO)}.json`];
		const r = runLeftovers(fixture(files));
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.report, /^- leftover: TodoTable .*delete DynamoDB table \(name unresolved, see the stack template\) by hand/m);
	});
});

describe(`cleanup-stacks.yml "${STEP}" step`, { skip: !GNU_DATE && 'needs GNU date' }, () => {
	it('unblocks the stuck sandbox: nested retain, root deferred, real table in the summary', () => {
		const r = runStep(sandbox());
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, [RETAIN_TODO]);
		assert.match(r.summary, /^- Root delete deferred \(nested stack delete started\): 1$/m);
		// The script's output comes before the step's own line about it. A smoke
		// check: the guarantee is the script's foreground pipe, and a race here
		// shows only sometimes.
		const lines = r.stdout.split('\n');
		const started = lines.findIndex((l) => l.startsWith('Nested stack delete started for '));
		assert.ok(started > lines.findIndex((l) => l.includes('Deleting nested stack ')), r.stdout);
		assert.ok(started > lines.findIndex((l) => l.startsWith('::warning::retained TodoTable')), r.stdout);
		assert.match(r.summary, new RegExp(`^- retained: TodoTable .* delete DynamoDB table ${REAL_TABLE} by hand`, 'm'));
		assert.doesNotMatch(r.summary, NO_ACCOUNT);
	});

	it('deletes the root plainly on the next run, once the nested stack is gone', () => {
		const r = runStep(
			sandbox({
				[`status-${key(TODO)}.txt`]: 'DELETE_COMPLETE\n',
				[`resources-${key(TODO)}.json`]: resources(resource('TodoTable', TABLE, 'DELETE_SKIPPED', TABLE_ID)),
			}),
		);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, [`cloudformation delete-stack --stack-name ${ROOT}`]);
		assert.match(r.summary, /^- Root delete deferred \(nested stack delete started\): 0$/m);
	});

	it('warns and retries plainly when the script fails', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'amplify-stuck-delete-cwd-'));
		dirs.push(cwd);
		// Every script the step runs from scripts/ci, with this one failing.
		cpSync(join(ROOT_DIR, 'scripts', 'ci'), join(cwd, 'scripts', 'ci'), { recursive: true });
		writeFileSync(join(cwd, 'scripts', 'ci', 'amplify-stuck-delete.sh'), 'exit 1\n');
		const r = runStep(sandbox(), { cwd });
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, [`cloudformation delete-stack --stack-name ${ROOT}`]);
		assert.match(r.stdout, /::warning::amplify-stuck-delete.sh exited 1 for /);
		assert.match(r.summary, /^- Nested retain script failed: 1$/m);
	});

	it('only retries plainly while a DELETE_FAILED sandbox is younger than 6 hours', () => {
		const created = new Date(Date.now() - (6 * 60 - 10) * 60_000).toISOString();
		const r = runStep(sandbox(), { created });
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, [`cloudformation delete-stack --stack-name ${ROOT}`]);
	});

	it('retains for a DELETE_FAILED sandbox just over 6 hours old', () => {
		const created = new Date(Date.now() - (6 * 60 + 10) * 60_000).toISOString();
		const r = runStep(sandbox(), { created });
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, [RETAIN_TODO]);
	});

	it('reads the leftovers before any delete, so a table retained this run is not also a leftover', () => {
		// A nested delete can finish within the run; read after it, the same
		// table would be reported twice.
		const r = runStep(sandbox());
		assert.equal(r.status, 0, r.stdout);
		const read = r.calls.indexOf('DELETE_COMPLETE');
		assert.ok(read !== -1 && read < r.calls.indexOf('--retain-resources'), r.calls);
	});

	it('only retries plainly a sandbox with no creation time, even after an old stuck one', () => {
		const ROOT2 = 'amplify-amplifygen2-amp716639251-sandbox-0000000000';
		const r = runStep({
			...sandbox(),
			'stacks.txt': `${ROOT}\n${ROOT2}\n`,
			[`info-${key(ROOT2)}.txt`]: 'sandbox\tDELETE_FAILED\tNone\n',
		});
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, [RETAIN_TODO, `cloudformation delete-stack --stack-name ${ROOT2}`]);
		assert.doesNotMatch(r.calls, new RegExp(`list-stack-resources --stack-name ${ROOT2} --output json`));
	});

	it('reports a table retained on an earlier run in the summary, on every later run', () => {
		// The root is gone too: only the deleted model stack's record is left.
		const r = runStep(afterRetain(), { created: 'None' });
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.stdout, /^::warning::1 DynamoDB table\(s\) retained by earlier sweeps may still exist/m);
		assert.match(r.summary, new RegExp(`^- leftover: TodoTable .* delete DynamoDB table ${REAL_TABLE} by hand`, 'm'));
		assert.doesNotMatch(r.summary, NO_ACCOUNT);
	});

	it('only retries plainly a ROLLBACK_FAILED sandbox (the retain needs DELETE_FAILED)', () => {
		const r = runStep(sandbox(), { status: 'ROLLBACK_FAILED' });
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(r.deletes, [`cloudformation delete-stack --stack-name ${ROOT}`]);
	});
});

describe('cleanup-stacks.yml checkout', () => {
	// Every leg runs scripts from scripts/ci, so the comment names them.
	it('names the scripts it checks out for', () => {
		const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
		const at = lines.findIndex((l, i) => i > lines.indexOf('  cleanup:') && l.trim().startsWith('- uses: actions/checkout@'));
		const comment = lines.slice(at - 3, at).join('\n');
		assert.match(comment, /amplify-stuck-delete\.sh/);
	});

	// The Amplify step runs on every leg, so the script must be there on each.
	it('checks out scripts/ci on every leg', () => {
		const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
		const at = lines.findIndex((l, i) => i > lines.indexOf('  cleanup:') && l.trim().startsWith('- uses: actions/checkout@'));
		const step = [];
		for (const line of lines.slice(at + 1)) {
			if (line.trim().startsWith('- ')) break;
			step.push(line.trim());
		}
		assert.ok(!step.some((l) => l.startsWith('if:')), 'the checkout must run on every leg');
		assert.ok(step.includes('scripts/ci'), 'sparse-checkout must include scripts/ci');
	});
});
