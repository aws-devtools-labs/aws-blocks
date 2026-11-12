// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnvironmentInfo } from '../contract/v1.js';
import {
	blockedReasonFor,
	CLOUD_ONLY_PILLARS,
	DEFAULT_ENVIRONMENT,
	dataTargetFor,
	deploymentStageNote,
	driftVariant,
	ENVIRONMENT_STORAGE_KEY,
	type EnvironmentState,
	environmentBadgeFor,
	environmentCards,
	environmentIdsFor,
	environmentSearchParams,
	environmentStatuses,
	isLocalEnvironment,
	isProductionEnvironment,
	LOCAL_ENVIRONMENT,
	localNotApplicableReason,
	parseEnvironment,
	readStoredEnvironment,
	resourceSummaryState,
	selectedCard,
	stackStatusVariant,
	statusFor,
	wireStageFor,
	writeStoredEnvironment,
} from './environment.js';

const STAGES = ['sandbox', 'production'];

/**
 * A stub for the injected deploy command, tagged per stage. Pinning "uses THAT
 * stage's command" is stronger than matching a literal: the real
 * `deployCommandFor` returns different scripts for sandbox and production, and a
 * literal assertion still passes if the detail hard-codes whichever one the test
 * happens to check.
 */
const deployCommand = (stage: string) => `deploy:${stage}`;

function env(stage: string, state: EnvironmentInfo['state'], error?: string): EnvironmentInfo {
	return { stage, state, ...(error ? { error } : {}) };
}

describe('environmentIdsFor', () => {
	it('puts local first, then the stages in the order given', () => {
		assert.deepEqual(environmentIdsFor(STAGES), ['local', 'sandbox', 'production']);
	});

	it('offers local even when no stage is known yet', () => {
		// The stage list arrives from a request; local needs neither.
		assert.deepEqual(environmentIdsFor([]), ['local']);
	});

	it('drops a stage literally named local rather than emitting the id twice', () => {
		// Two pills that look distinct and select the same thing is worse than one
		// missing stage.
		assert.deepEqual(environmentIdsFor(['local', 'sandbox']), ['local', 'sandbox']);
	});

	it('deduplicates a repeated stage', () => {
		assert.deepEqual(environmentIdsFor(['sandbox', 'sandbox']), ['local', 'sandbox']);
	});
});

describe('isLocalEnvironment', () => {
	it('recognises only the exact local id', () => {
		assert.equal(isLocalEnvironment('local'), true);
		assert.equal(isLocalEnvironment('Local'), false);
		assert.equal(isLocalEnvironment('localhost'), false);
	});
});

describe('isProductionEnvironment', () => {
	for (const id of ['prod', 'production', 'eu-prod', 'PRODUCTION']) {
		it(`treats ${id} as production, matching the previous /prod/i banner rule`, () => {
			assert.equal(isProductionEnvironment(id), true);
		});
	}

	for (const id of ['sandbox', 'staging', 'local']) {
		it(`does not treat ${id} as production`, () => {
			assert.equal(isProductionEnvironment(id), false);
		});
	}
});

describe('dataTargetFor', () => {
	it('carries no stage at all for local', () => {
		const target = dataTargetFor('local');
		assert.deepEqual(target, { mode: 'local' });
		// Not merely undefined: the key must be absent, because a present and
		// meaningless field is one someone eventually reads.
		assert.equal('stage' in target, false);
	});

	it('carries the environment id as the stage for a deployed environment', () => {
		assert.deepEqual(dataTargetFor('production'), { mode: 'cloud', stage: 'production' });
	});
});

describe('environmentSearchParams', () => {
	it('omits stage entirely in local rather than sending a placeholder', () => {
		const params = environmentSearchParams('local');
		assert.equal(params.get('mode'), 'local');
		assert.equal(params.has('stage'), false);
	});

	it('sends mode and stage together for a deployed environment', () => {
		const params = environmentSearchParams('sandbox');
		assert.equal(params.get('mode'), 'cloud');
		assert.equal(params.get('stage'), 'sandbox');
	});

	it('merges the caller\u2019s own parameters', () => {
		const params = environmentSearchParams('sandbox', { limit: '50', store: 'todos' });
		assert.equal(params.get('limit'), '50');
		assert.equal(params.get('store'), 'todos');
		assert.equal(params.get('stage'), 'sandbox');
	});
});

describe('wireStageFor', () => {
	it('sends the real stage for a deployed environment', () => {
		assert.equal(wireStageFor(dataTargetFor('production')), 'production');
	});

	it('sends an empty string for local, never a plausible stage name', () => {
		// The contract types `stage` as required on the write and RPC bodies, so
		// something must go there. An empty string cannot be mistaken for a target
		// if it ever surfaces in a log; 'local' or 'sandbox' could be.
		const wire = wireStageFor(dataTargetFor('local'));
		assert.equal(wire, '');
		// A cloud target sends the real stage, which is what makes the empty string
		// specifically the local case rather than a blanket behaviour.
		assert.equal(wireStageFor(dataTargetFor('production')), 'production');
	});
});

describe('environmentStatuses', () => {
	it('always offers local, with an explanation of what it reads', () => {
		const [local] = environmentStatuses(STAGES, deployCommand, []);
		assert.equal(local?.id, 'local');
		assert.equal(local?.state, 'local');
		assert.equal(local?.selectable, true);
		assert.match(String(local?.detail), /\.bb-data/);
	});

	it('offers a deployed stage with nothing to explain', () => {
		const status = statusFor(environmentStatuses(STAGES, deployCommand, [env('sandbox', 'deployed')]), 'sandbox');
		assert.equal(status?.state, 'deployed');
		assert.equal(status?.selectable, true);
		assert.equal(status?.detail, undefined);
	});

	it('disables a not-deployed stage and names the command that deploys THAT stage', () => {
		const statuses = environmentStatuses(STAGES, deployCommand, [
			env('sandbox', 'not-deployed'),
			env('production', 'not-deployed'),
		]);
		const sandbox = statusFor(statuses, 'sandbox');
		const production = statusFor(statuses, 'production');
		assert.equal(sandbox?.selectable, false);
		assert.equal(production?.selectable, false);
		// The two stages deploy with different scripts, which is the whole reason
		// the command is a function of the stage.
		assert.match(String(sandbox?.detail), /deploy:sandbox/);
		assert.match(String(production?.detail), /deploy:production/);
	});

	it('keeps an unknown stage SELECTABLE and carries the provider\u2019s own words', () => {
		// D79: unknown means we could not look, not that nothing is there.
		// Disabling it would assert an absence we never established.
		const status = statusFor(
			environmentStatuses(STAGES, deployCommand, [env('production', 'unknown', 'Credentials have expired.')]),
			'production',
		);
		assert.equal(status?.state, 'unknown');
		assert.equal(status?.selectable, true);
		assert.equal(status?.detail, 'Credentials have expired.');
	});

	it('still explains an unknown stage that arrived without a message', () => {
		const status = statusFor(environmentStatuses(STAGES, deployCommand, [env('sandbox', 'unknown')]), 'sandbox');
		assert.equal(status?.state, 'unknown');
		assert.match(String(status?.detail), /could not be determined/);
	});

	it('reports a stage with no entry as unread, not as not-deployed', () => {
		// The request is in flight. Saying "not deployed" here would be a false
		// statement that resolves itself, which is the worst kind to ship.
		const status = statusFor(
			environmentStatuses(STAGES, deployCommand, [env('sandbox', 'deployed')]),
			'production',
		);
		assert.equal(status?.state, 'unread');
		assert.equal(status?.selectable, true);
	});

	it('reports every stage as unread when the environments request has not answered', () => {
		const statuses = environmentStatuses(STAGES, deployCommand, undefined);
		assert.deepEqual(
			statuses.map((s) => s.state),
			['local', 'unread', 'unread'],
		);
		assert.equal(
			statuses.every((s) => s.selectable),
			true,
		);
	});

	it('ignores an environment entry for a stage the selector does not offer', () => {
		const statuses = environmentStatuses(['sandbox'], deployCommand, [env('staging', 'deployed')]);
		assert.deepEqual(
			statuses.map((s) => s.id),
			['local', 'sandbox'],
		);
		assert.equal(statusFor(statuses, 'sandbox')?.state, 'unread');
	});

	it('holds the invariant that only not-deployed is unselectable', () => {
		const statuses = environmentStatuses(['a', 'b', 'c', 'd'], deployCommand, [
			env('a', 'deployed'),
			env('b', 'not-deployed'),
			env('c', 'unknown', 'boom'),
		]);
		for (const status of statuses) {
			assert.equal(status.selectable, status.state !== 'not-deployed', `${status.id} is ${status.state}`);
		}
	});
});

describe('stackStatusVariant', () => {
	it('reads a completed stack as success', () => {
		assert.equal(stackStatusVariant('CREATE_COMPLETE'), 'success');
		assert.equal(stackStatusVariant('UPDATE_COMPLETE'), 'success');
	});

	it('reads a failure as destructive even when it also mentions a rollback', () => {
		assert.equal(stackStatusVariant('CREATE_FAILED'), 'destructive');
		// Ends in FAILED *and* contains ROLLBACK: the failure is the more urgent
		// of the two readings, so the order of the checks is load-bearing.
		assert.equal(stackStatusVariant('UPDATE_ROLLBACK_FAILED'), 'destructive');
	});

	it('reads a rollback or an in-flight change as a warning', () => {
		assert.equal(stackStatusVariant('UPDATE_ROLLBACK_COMPLETE'), 'warning');
		assert.equal(stackStatusVariant('UPDATE_IN_PROGRESS'), 'warning');
	});

	it('has no opinion with no status', () => {
		assert.equal(stackStatusVariant(undefined), 'outline');
		assert.equal(stackStatusVariant(''), 'outline');
	});
});

describe('environmentBadgeFor', () => {
	it('says local needs no deploy rather than claiming a stack state', () => {
		const badge = environmentBadgeFor('local');
		assert.equal(badge.label, 'no deploy needed');
		// Not merely "different text": local must not borrow any label that a
		// deployed-state environment uses, or the two read as the same verdict.
		const deployedStateLabels = (['deployed', 'not-deployed'] as EnvironmentState[]).map(
			(state) => environmentBadgeFor(state).label,
		);
		assert.ok(!deployedStateLabels.includes(badge.label), `local borrowed ${badge.label}`);
	});

	it('shows a deployed stage its real CloudFormation status', () => {
		assert.deepEqual(environmentBadgeFor('deployed', 'UPDATE_ROLLBACK_COMPLETE'), {
			label: 'UPDATE_ROLLBACK_COMPLETE',
			variant: 'warning',
		});
	});

	it('falls back to the plain word when a deployed stage reports no status', () => {
		assert.deepEqual(environmentBadgeFor('deployed'), { label: 'deployed', variant: 'success' });
	});

	it('never renders not-deployed and unknown the same way (D79)', () => {
		const notDeployed = environmentBadgeFor('not-deployed');
		const unknown = environmentBadgeFor('unknown');
		assert.notDeepEqual(notDeployed, unknown);
		assert.notEqual(notDeployed.label, unknown.label);
	});

	it('never renders ANY TWO of not-deployed, unknown and unread alike (D79)', () => {
		// The pairwise sweep, because the earlier two tests left the load-bearing
		// pair unasserted: `not-deployed` vs `unread` is precisely "nothing is
		// there" vs "we have not looked yet", and both were `outline`, differing by
		// label alone with nothing holding that.
		const states: EnvironmentState[] = ['not-deployed', 'unknown', 'unread'];
		const labels = states.map((state) => environmentBadgeFor(state).label);
		assert.equal(
			new Set(labels).size,
			states.length,
			`two of ${states.join('/')} share a label: ${labels.join(', ')}`,
		);
	});

	it('distinguishes "not read yet" from "read and unknown"', () => {
		assert.notEqual(environmentBadgeFor('unread').label, environmentBadgeFor('unknown').label);
	});

	it('covers every state, so a new one cannot render as blank', () => {
		const states: EnvironmentState[] = ['local', 'deployed', 'not-deployed', 'unknown', 'unread'];
		// `.length > 0` on the variant proves nothing -- the type is a closed union
		// of non-empty literals. Membership in the set the Badge component accepts
		// is the property that actually matters.
		const known = ['default', 'success', 'destructive', 'warning', 'outline'];
		for (const state of states) {
			const badge = environmentBadgeFor(state);
			assert.ok(badge.label.trim().length > 0, `${state} has no label`);
			assert.ok(
				known.includes(badge.variant),
				`${state} has variant ${badge.variant}, which Badge cannot render`,
			);
		}
	});
});

describe('environmentCards', () => {
	const statuses = () =>
		environmentStatuses(STAGES, deployCommand, [env('sandbox', 'deployed'), env('production', 'not-deployed')]);

	it('offers exactly the environments the header offers, in the same order', () => {
		const cards = environmentCards(statuses(), 'sandbox');
		assert.deepEqual(
			cards.map((card) => card.status.id),
			['local', 'sandbox', 'production'],
		);
	});

	it('marks exactly one card as selected', () => {
		const cards = environmentCards(statuses(), 'sandbox');
		assert.deepEqual(
			cards.filter((card) => card.selected).map((card) => card.status.id),
			['sandbox'],
		);
	});

	it('marks nothing when the selection is not on offer, rather than guessing', () => {
		const cards = environmentCards(statuses(), 'staging');
		assert.equal(
			cards.filter((card) => card.selected).length,
			0,
			'an environment that is not offered must not light up another card',
		);
	});

	it('never hands the local card a stack', () => {
		const infos = [env('sandbox', 'deployed'), { ...env('local', 'deployed'), stackStatus: 'CREATE_COMPLETE' }];
		const cards = environmentCards(environmentStatuses(STAGES, deployCommand, infos), 'local', infos);
		const local = cards.find((card) => card.status.id === 'local');
		assert.equal(local?.info, undefined, 'local has no CloudFormation stack by definition (D74)');
		assert.equal(local?.badge.label, 'no deploy needed');
	});

	it('pairs each stage with its own stack detail', () => {
		const infos = [
			{ ...env('sandbox', 'deployed'), stackStatus: 'CREATE_COMPLETE', region: 'us-east-1' },
			{ ...env('production', 'deployed'), stackStatus: 'UPDATE_IN_PROGRESS', region: 'eu-west-1' },
		];
		const cards = environmentCards(environmentStatuses(STAGES, deployCommand, infos), 'sandbox', infos);
		assert.equal(cards.find((c) => c.status.id === 'sandbox')?.info?.region, 'us-east-1');
		assert.equal(cards.find((c) => c.status.id === 'production')?.badge.label, 'UPDATE_IN_PROGRESS');
	});

	it('carries the availability through unchanged, so Overview cannot offer what the header refuses', () => {
		const cards = environmentCards(statuses(), 'sandbox');
		const production = cards.find((card) => card.status.id === 'production');
		assert.equal(production?.status.selectable, false);
		assert.match(String(production?.status.detail), /deploy:production/);
	});

	it('leaves a stage unread and selectable when the environments request has not landed', () => {
		const cards = environmentCards(environmentStatuses(STAGES, deployCommand), 'sandbox');
		const production = cards.find((card) => card.status.id === 'production');
		assert.equal(production?.status.state, 'unread');
		assert.equal(production?.status.selectable, true);
		assert.equal(production?.badge.label, 'checking…');
	});
});

describe('selectedCard', () => {
	const cards = () =>
		environmentCards(
			environmentStatuses(STAGES, deployCommand, [
				{ ...env('sandbox', 'deployed'), stackName: 'app-sandbox' },
				{ ...env('production', 'deployed'), stackName: 'app-production' },
			]),
			'production',
			[
				{ ...env('sandbox', 'deployed'), stackName: 'app-sandbox' },
				{ ...env('production', 'deployed'), stackName: 'app-production' },
			],
		);

	it('returns the selected environment with ITS OWN stack', () => {
		assert.equal(selectedCard(cards())?.info?.stackName, 'app-production');
	});

	it('returns nothing when the selection is not on offer', () => {
		const unselected = environmentCards(environmentStatuses(STAGES, deployCommand), 'staging');
		assert.equal(selectedCard(unselected), undefined);
	});

	it('gives the local selection no stack', () => {
		const local = environmentCards(environmentStatuses(STAGES, deployCommand), 'local');
		assert.equal(selectedCard(local)?.status.id, 'local');
		assert.equal(selectedCard(local)?.info, undefined);
	});
});

describe('driftVariant', () => {
	it('names drift a failure and sync a success', () => {
		assert.equal(driftVariant('DRIFTED'), 'destructive');
		assert.equal(driftVariant('IN_SYNC'), 'success');
	});

	it('has no opinion on an unchecked or unknown drift state', () => {
		assert.equal(driftVariant(undefined), 'outline');
		assert.equal(driftVariant('NOT_CHECKED'), 'outline');
		assert.equal(driftVariant('DETECTION_FAILED'), 'outline');
	});
});

describe('resourceSummaryState', () => {
	it('summarises only a CloudFormation-sourced read', () => {
		assert.deepEqual(resourceSummaryState('cloudformation', undefined), { state: 'ok' });
	});

	it('distinguishes "not read yet" from "read and failed"', () => {
		assert.deepEqual(resourceSummaryState(undefined, undefined), { state: 'unread' });
		const failed = resourceSummaryState('unavailable', 'the credentials expired');
		assert.equal(failed.state, 'failed');
	});

	it('carries the provider\u2019s own words when it has them', () => {
		const failed = resourceSummaryState('unavailable', 'the credentials expired');
		assert.equal(failed.state === 'failed' && failed.detail, 'the credentials expired');
	});

	it('never leaves a failed read without a sentence', () => {
		// Silence is the defect: an absent summary would otherwise read exactly like
		// a stack with no blocks in it.
		const failed = resourceSummaryState('unavailable', undefined);
		assert.equal(failed.state, 'failed');
		assert.ok(failed.state === 'failed' && failed.detail.length > 0);
		assert.match(failed.state === 'failed' ? failed.detail : '', /could not be read/);
	});
});

describe('blockedReasonFor', () => {
	it('blocks exactly the unselectable environment, and says why', () => {
		const statuses = environmentStatuses(STAGES, deployCommand, [
			env('sandbox', 'not-deployed'),
			env('production', 'deployed'),
		]);
		assert.match(String(blockedReasonFor(statusFor(statuses, 'sandbox'))), /No deployed stack for "sandbox"/);
		assert.equal(blockedReasonFor(statusFor(statuses, 'production')), undefined);
		assert.equal(blockedReasonFor(statusFor(statuses, 'local')), undefined);
	});

	it('does not block an unknown environment', () => {
		// The page issues its request and reports what comes back, which beats a
		// guess made before asking.
		const statuses = environmentStatuses(STAGES, deployCommand, [
			env('production', 'unknown', 'Credentials have expired.'),
		]);
		assert.equal(blockedReasonFor(statusFor(statuses, 'production')), undefined);
	});

	it('does not block an environment it has never heard of', () => {
		assert.equal(blockedReasonFor(undefined), undefined);
	});
});

describe('localNotApplicableReason', () => {
	it('names the actual mechanism for each cloud-only pillar', () => {
		assert.match(localNotApplicableReason('logs'), /stdout/);
		assert.match(localNotApplicableReason('deployments'), /npm run sandbox/);
		assert.match(localNotApplicableReason('resources'), /CloudFormation/);
		assert.match(localNotApplicableReason('cost'), /billed/);
	});

	it('gives every pillar its own sentence', () => {
		const reasons = CLOUD_ONLY_PILLARS.map(localNotApplicableReason);
		assert.equal(new Set(reasons).size, CLOUD_ONLY_PILLARS.length);
		// `.length > 40` passes on 41 characters of anything. The actual rule is
		// that each sentence names its MECHANISM instead of saying "unavailable",
		// so the placeholder vocabulary is what to forbid.
		for (const reason of reasons) {
			assert.doesNotMatch(reason, /\b(unavailable|not available|no data)\b/i, reason);
		}
	});
});

describe('deploymentStageNote', () => {
	it('says nothing when the record is from the selected stage', () => {
		assert.equal(deploymentStageNote('sandbox', 'sandbox'), undefined);
		assert.equal(deploymentStageNote('production', 'production'), undefined);
	});

	it('names both stages when they differ', () => {
		const note = deploymentStageNote('sandbox', 'production');
		assert.notEqual(note, undefined);
		assert.match(String(note), /went to production/);
		assert.match(String(note), /selected environment is sandbox/);
	});

	it('is not symmetric — it says which is which', () => {
		assert.notEqual(deploymentStageNote('sandbox', 'production'), deploymentStageNote('production', 'sandbox'));
	});

	it('explains why the page is showing it rather than just flagging it', () => {
		// A bare "these differ" note reads as an error the reader must fix. The
		// page is behaving correctly: a link names one record.
		assert.match(String(deploymentStageNote('sandbox', 'production')), /one specific record/);
	});
});

describe('parseEnvironment', () => {
	const known = ['local', 'sandbox', 'production'];

	it('keeps a known value', () => {
		assert.equal(parseEnvironment('production', known), 'production');
		assert.equal(parseEnvironment('local', known), 'local');
	});

	for (const raw of [null, undefined, '', 'staging', 'LOCAL', 'cloud']) {
		it(`falls back for ${JSON.stringify(raw)}`, () => {
			assert.equal(parseEnvironment(raw, known), DEFAULT_ENVIRONMENT);
		});
	}

	it('falls back to the first environment when the default is not on offer', () => {
		// A project whose stages were renamed: returning `sandbox` anyway would
		// leave the switcher with no active entry.
		assert.equal(parseEnvironment('nonsense', ['local', 'staging']), 'local');
		assert.equal(parseEnvironment('nonsense', ['staging', 'preprod']), 'staging');
	});

	it('falls back to local when there is nothing on offer at all', () => {
		assert.equal(parseEnvironment('nonsense', []), LOCAL_ENVIRONMENT);
	});

	it('keeps a known id whatever its deployment state', () => {
		// The audited test name used to claim this pinned "keeps an UNSELECTABLE
		// id", which `parseEnvironment` cannot express: it receives only ids and has
		// no access to selectability. What it does hold is that a known id is
		// returned unchanged -- which is what makes a torn-down `production` stay
		// selected while every page says so, rather than the reader being moved
		// silently. The selectability half is held by `environmentStatuses`.
		assert.equal(parseEnvironment('production', known), 'production');
		assert.equal(parseEnvironment('local', known), 'local');
	});
});

describe('readStoredEnvironment', () => {
	it('reads a stored value', () => {
		assert.equal(
			readStoredEnvironment(() => 'production'),
			'production',
		);
	});

	it('returns a stored value it cannot yet vouch for', () => {
		// The stage list arrives from a request, so at mount there is nothing to
		// validate against. Falling back here would move a reader off their stored
		// environment for as long as that request is in flight.
		assert.equal(
			readStoredEnvironment(() => 'preprod'),
			'preprod',
		);
	});

	for (const raw of [null, '']) {
		it(`falls back for ${JSON.stringify(raw)}`, () => {
			assert.equal(
				readStoredEnvironment(() => raw),
				DEFAULT_ENVIRONMENT,
			);
		});
	}

	it('survives storage THROWING rather than returning null', () => {
		// The failure this exists to prevent (D45): an unguarded read of exactly
		// this kind blanked every page with an uncaught `The operation is insecure.`
		assert.equal(
			readStoredEnvironment(() => {
				throw new Error('The operation is insecure.');
			}),
			DEFAULT_ENVIRONMENT,
		);
	});
});

describe('writeStoredEnvironment', () => {
	it('writes the id through', () => {
		let written: string | undefined;
		writeStoredEnvironment((value) => {
			written = value;
		}, 'local');
		assert.equal(written, 'local');
	});

	it('swallows a refused write instead of failing the click', () => {
		assert.doesNotThrow(() =>
			writeStoredEnvironment(() => {
				throw new Error('QuotaExceededError');
			}, 'production'),
		);
	});
});

describe('constants', () => {
	it('defaults to sandbox, preserving the stage selector\u2019s own default', () => {
		// Defaulting to local would open the five cloud-only pillars on "not
		// applicable here", which is not what an ops dashboard is for.
		assert.equal(DEFAULT_ENVIRONMENT, 'sandbox');
	});

	it('keeps the old storage key, so an open tab keeps its selection', () => {
		// Every value the key can already hold is a valid environment id, so
		// renaming it would silently reset a reader mid-session for no gain.
		assert.equal(ENVIRONMENT_STORAGE_KEY, 'blocks-dashboard-stage');
	});
});

describe('the provider s own not-deployed sentence', () => {
	/**
	 * The generic sentence asserts nothing is deployed for a stage. That claim is
	 * only safe when the provider verified it, and the provider now says where it
	 * looked — so its sentence must reach the card instead of being replaced by
	 * ours.
	 */
	it('is preferred over the generic one, so the region looked in survives', () => {
		const statuses = environmentStatuses(['sandbox'], () => 'npm run sandbox', [
			{
				stage: 'sandbox',
				stackName: 'app-sandbox',
				region: 'ap-southeast-1',
				regionSource: 'cli',
				state: 'not-deployed',
				stateReason: 'No stack named "app-sandbox" in ap-southeast-1 (region from your --region flag).',
			},
		]);
		const sandbox = statuses.find((s) => s.id === 'sandbox');
		assert.match(sandbox?.detail ?? '', /ap-southeast-1/);
		assert.doesNotMatch(sandbox?.detail ?? '', /No deployed stack/);
	});

	it('falls back to the generic sentence when the provider gives no reason', () => {
		const statuses = environmentStatuses(['sandbox'], () => 'npm run sandbox', [
			{ stage: 'sandbox', state: 'not-deployed' },
		]);
		assert.match(statuses.find((s) => s.id === 'sandbox')?.detail ?? '', /No deployed stack/);
	});
});
