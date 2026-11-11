#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Deletes the Cognito user pools E2E stacks left behind in an E2E account.
// Runs in cleanup-stacks.yml, one leg per E2E account.
//
// Usage: node scripts/ci/sweep-cognito-pools.mjs
//
// The E2E apps deploy user pools with self sign-up on (the feature under
// test). The account's security scan files a finding for every such pool it
// sees, so a pool must not outlive its test. A pool goes with its stack, but
// is left when the stack is (DELETE_FAILED, a delete that retained it, a stack
// removed out of band). The stack sweep reclaims a leftover stack; this reclaims
// a leftover pool no stack owns any more.
//
// A pool is deleted only when ALL of these hold, and any check it can't make
// skips the pool, never deletes it:
//   1. The caller's account is one of the E2E accounts in AWS_ROLE_ARNS, so a
//      run with any other credentials deletes nothing (the step fails).
//   2. Its name has a CI shape: a Blocks E2E stack prefix (the pool is named
//      after its stack), or the logical-id name an Amplify Gen 2 sandbox's
//      defineAuth pool gets.
//   3. It is older than COGNITO_SWEEP_MIN_AGE_HOURS (default 6, longer than any
//      E2E job and its teardown), so an in-flight test's pool is never touched.
//   4. Its tags mark it as CI's, as the stack sweep requires of a stack: a
//      Blocks pool carries blocks:purpose e2e-* or *-e2e; an Amplify pool
//      carries amplify:deployment-type=sandbox (its name alone is the same in
//      any Gen 2 app with auth).
//   5. No live CloudFormation stack owns it. A pool a live stack owns is left
//      to the stack sweep, which deletes the stack and the pool with it.
// A pool with deletion protection on is reported, never changed.
//
// Env: AWS_ROLE_ARNS (the e2e environment's JSON array of role ARNs),
// COGNITO_SWEEP_MIN_AGE_HOURS (default 6), COGNITO_SWEEP_BUDGET_SECONDS
// (default 300), GITHUB_STEP_SUMMARY.
//
// Tests: node --test scripts/ci/sweep-cognito-pools.test.mjs

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Same prefixes as the e2e stack sweep in cleanup-stacks.yml, minus my-app-
// (a developer's ad-hoc app can carry that name).
const BLOCKS_POOL = /^(blocks-test|blocks-hosting|bb-test|bb-telemetry|bb-vpc-smoke)-[A-Za-z0-9-]+$/;
// <logical id>-<CloudFormation suffix>, e.g. amplifyAuthUserPool4BA7F805-viQ0rPu77agW.
const AMPLIFY_POOL = /^amplifyAuthUserPool[0-9A-F]{8}-[A-Za-z0-9]{6,}$/;

const minAgeMs = Number(process.env.COGNITO_SWEEP_MIN_AGE_HOURS ?? 6) * 3600_000;
const deadline = Date.now() + Number(process.env.COGNITO_SWEEP_BUDGET_SECONDS ?? 300) * 1000;

const warning = (msg) => console.log(`::warning title=Cognito pool sweep::${msg}`);
const error = (msg) => console.log(`::error title=Cognito pool sweep::${msg}`);

function aws(...args) {
	const r = spawnSync('aws', [...args, '--output', 'json', '--cli-read-timeout', '20'], {
		encoding: 'utf8',
		timeout: 60_000,
	});
	const err = (r.error?.message ?? r.stderr ?? '').trim();
	return { ok: r.status === 0, out: r.stdout, err: err || `aws exited ${r.status}` };
}

const json = (out) => JSON.parse(out || 'null');

/** Whether the tags mark a pool of this name as a CI test fixture. */
export function taggedForCi(name, tags = {}) {
	if (AMPLIFY_POOL.test(name)) return tags['amplify:deployment-type'] === 'sandbox';
	const purpose = tags['blocks:purpose'] ?? '';
	return /^e2e-/.test(purpose) || /-e2e$/.test(purpose);
}

/** The 12-digit account ids of a JSON array of role ARNs; empty when malformed. */
export function accountsOf(roleArns) {
	try {
		const arns = JSON.parse(roleArns ?? '');
		if (!Array.isArray(arns)) return [];
		return arns.map((a) => /^arn:aws[a-z-]*:iam::(\d{12}):role\//.exec(String(a))?.[1]).filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Who owns a pool: 'none' when no live stack does, 'live' when one does,
 * `unknown (...)` when it can't be told (then the pool is skipped).
 */
function ownerOf(poolId) {
	const r = aws('cloudformation', 'describe-stack-resources', '--physical-resource-id', poolId);
	if (!r.ok) return /does not exist/.test(r.err) ? 'none' : `unknown (${r.err})`;
	const stackId = json(r.out)?.StackResources?.[0]?.StackId;
	if (!stackId) return 'none';
	// A deleted stack can still be named here; only a live one owns the pool.
	const s = aws('cloudformation', 'describe-stacks', '--stack-name', stackId, '--query', 'Stacks[0].StackStatus');
	if (!s.ok) return /does not exist/.test(s.err) ? 'none' : `unknown (${s.err})`;
	return json(s.out) === 'DELETE_COMPLETE' ? 'none' : 'live';
}

async function main() {
	const accounts = accountsOf(process.env.AWS_ROLE_ARNS);
	if (accounts.length === 0) {
		error('AWS_ROLE_ARNS is missing or holds no role ARN, so the E2E accounts are unknown; not deleting anything.');
		return 1;
	}
	const who = aws('sts', 'get-caller-identity', '--query', 'Account');
	if (!who.ok) {
		error(`Could not read the caller's account: ${who.err}; not deleting anything.`);
		return 1;
	}
	// Never print the account id: the role ARNs it comes from are masked.
	if (!accounts.includes(json(who.out))) {
		error("The caller's account is not an E2E account in AWS_ROLE_ARNS; not deleting anything.");
		return 1;
	}

	const list = aws(
		'cognito-idp',
		'list-user-pools',
		'--max-results',
		'60',
		'--query',
		'UserPools[].{Id: Id, Name: Name, CreationDate: CreationDate}',
	);
	if (!list.ok) {
		warning(`Could not list user pools, so none is swept this run: ${list.err}`);
		summary({ listed: 'unknown' });
		return 0;
	}
	const cutoff = Date.now() - minAgeMs;
	const candidates = (json(list.out) ?? []).filter((p) => BLOCKS_POOL.test(p.Name) || AMPLIFY_POOL.test(p.Name));
	const counts = {
		listed: candidates.length,
		deleted: 0,
		tooNew: 0,
		owned: 0,
		untagged: 0,
		protected: 0,
		unknown: 0,
		failed: 0,
	};

	for (const { Id: id, Name: name, CreationDate: created } of candidates) {
		if (Date.now() >= deadline) {
			console.log('Time budget reached; the remaining pools are swept on the next run.');
			break;
		}
		const createdMs = Date.parse(created);
		if (!(createdMs < cutoff)) {
			console.log(`Skipping ${name} (${id}): created ${created}, too new.`);
			counts.tooNew++;
			continue;
		}
		const desc = aws('cognito-idp', 'describe-user-pool', '--user-pool-id', id);
		if (!desc.ok) {
			console.log(`Skipping ${name} (${id}): could not describe it: ${desc.err}`);
			counts.unknown++;
			continue;
		}
		const pool = json(desc.out)?.UserPool ?? {};
		if (!taggedForCi(name, pool.UserPoolTags)) {
			console.log(`Skipping ${name} (${id}): its tags don't mark it as a CI test pool.`);
			counts.untagged++;
			continue;
		}
		if (pool.DeletionProtection === 'ACTIVE') {
			warning(`${name} (${id}) has deletion protection on; left in place (this sweep never turns it off).`);
			counts.protected++;
			continue;
		}
		const owner = ownerOf(id);
		if (owner === 'live') {
			console.log(`Skipping ${name} (${id}): a live stack owns it; the stack sweep deletes the stack.`);
			counts.owned++;
			continue;
		}
		if (owner !== 'none') {
			console.log(`Skipping ${name} (${id}): could not tell which stack owns it: ${owner}`);
			counts.unknown++;
			continue;
		}
		// A pool with a domain can't be deleted until the domain is.
		let domainFailed = false;
		for (const domain of [pool.Domain, pool.CustomDomain].filter(Boolean)) {
			const d = aws('cognito-idp', 'delete-user-pool-domain', '--domain', domain, '--user-pool-id', id);
			if (!d.ok) {
				warning(`Could not delete domain ${domain} of ${name} (${id}): ${d.err}`);
				domainFailed = true;
			}
		}
		if (domainFailed) {
			counts.failed++;
			continue;
		}
		const del = aws('cognito-idp', 'delete-user-pool', '--user-pool-id', id);
		if (!del.ok) {
			warning(`Could not delete ${name} (${id}): ${del.err}`);
			counts.failed++;
			continue;
		}
		console.log(`Deleted orphaned user pool ${name} (${id}), created ${created}.`);
		counts.deleted++;
	}
	summary(counts);
	if (counts.failed > 0) warning(`${counts.failed} orphaned user pool(s) could not be deleted; see the log.`);
	return 0;
}

function summary(counts) {
	const lines = [
		'## Cognito User Pool Sweep',
		`- Test-named pools listed: ${counts.listed}`,
		...(counts.listed === 'unknown'
			? []
			: [
					`- Orphans deleted: ${counts.deleted}`,
					`- Delete failed: ${counts.failed}`,
					`- Skipped (younger than ${minAgeMs / 3600_000}h): ${counts.tooNew}`,
					`- Skipped (a live stack owns it): ${counts.owned}`,
					`- Skipped (not tagged as CI): ${counts.untagged}`,
					`- Skipped (deletion protection on): ${counts.protected}`,
					`- Skipped (owner or details unreadable): ${counts.unknown}`,
				]),
	];
	console.log(lines.join('\n'));
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
