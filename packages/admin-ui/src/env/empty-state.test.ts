// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnvironmentInfo } from '../contract/v1.js';
import { deployCommandFor } from '../lib/commands.js';
import {
	type EmptyScreen,
	type GuidedAction,
	type GuidedEmpty,
	guidedEmpty,
	isGuided,
	switchTargets,
} from './empty-state.js';
import { CLOUD_ONLY_PILLARS, environmentStatuses, localNotApplicableReason } from './environment.js';

const STAGES = ['sandbox', 'production'];

/**
 * A tagged stub, following `environment.test.ts`: pinning "uses THAT stage's
 * command" is stronger than matching a literal, because a literal assertion
 * still passes when the code hard-codes whichever stage the test happens to
 * check. One test below uses the real `deployCommandFor` instead, to prove the
 * pairing against the actual scripts.
 */
const deployCommand = (stage: string) => `deploy:${stage}`;

function env(stage: string, state: EnvironmentInfo['state'], stackStatus?: string): EnvironmentInfo {
	return { stage, state, ...(stackStatus ? { stackStatus } : {}) };
}

/** Statuses built through the real model, so the pairing under test is the real one. */
function statuses(...infos: EnvironmentInfo[]) {
	return environmentStatuses(STAGES, deployCommand, infos);
}

const BOTH_DEPLOYED = () => statuses(env('sandbox', 'deployed'), env('production', 'deployed'));
const SANDBOX_MISSING = () => statuses(env('sandbox', 'not-deployed'), env('production', 'deployed'));
const NEITHER_DEPLOYED = () => statuses(env('sandbox', 'not-deployed'), env('production', 'not-deployed'));

function guide(screen: EmptyScreen, from = SANDBOX_MISSING(), current = 'local'): GuidedEmpty {
	return guidedEmpty(screen, from, current, deployCommand, localNotApplicableReason);
}

function commands(guided: GuidedEmpty): string[] {
	return guided.actions.filter((a) => a.type === 'command').map((a) => a.command);
}

function switches(guided: GuidedEmpty): string[] {
	return guided.actions.filter((a) => a.type === 'switch').map((a) => a.environment);
}

function links(guided: GuidedEmpty): string[] {
	return guided.actions.filter((a) => a.type === 'link').map((a) => a.href);
}

/** Every state the union can express, for the invariant sweep. */
const EVERY_SCREEN: EmptyScreen[] = [
	...CLOUD_ONLY_PILLARS.map((pillar): EmptyScreen => ({ kind: 'local-pillar', pillar })),
	{ kind: 'not-deployed', stage: 'production' },
	{ kind: 'not-deployed', stage: 'production', detail: 'looked in eu-west-1' },
	{ kind: 'unauthorized' },
	{ kind: 'unauthorized', detail: 'HTTP 401' },
	{ kind: 'nothing-recorded', subject: 'deployments', stage: 'sandbox' },
	{ kind: 'nothing-recorded', subject: 'deployments', stage: 'sandbox', detail: 'two sources, both empty' },
	{ kind: 'nothing-recorded', subject: 'traffic', stage: 'sandbox' },
	{ kind: 'nothing-recorded', subject: 'traffic', stage: 'sandbox', detail: 'nothing in the window' },
	{ kind: 'access-denied', permission: 'cloudwatch:GetMetricData' },
	{
		kind: 'access-denied',
		permission: 'ce:GetCostAndUsage and ce:ListCostAllocationTags',
		detail: 'also needs enabling',
	},
];

describe('isGuided', () => {
	it('holds for every empty screen the union can express', () => {
		// The whole point of the module: no screen may be a dead end. Swept over
		// the union rather than asserted per branch, so a new member cannot be
		// added with no guidance and no failing test.
		for (const screen of EVERY_SCREEN) {
			for (const from of [BOTH_DEPLOYED(), SANDBOX_MISSING(), NEITHER_DEPLOYED(), statuses()]) {
				for (const current of ['local', 'sandbox', 'production']) {
					const guided = guidedEmpty(screen, from, current, deployCommand, localNotApplicableReason);
					assert.ok(
						isGuided(guided),
						`${screen.kind} from ${current} offered ${guided.actions.length} actions and reason ${String(guided.noActionReason)}`,
					);
				}
			}
		}
	});

	it('rejects a screen that lists actions AND claims there are none', () => {
		// A contradiction the reader would see directly: buttons under a sentence
		// saying there are no buttons.
		const action: GuidedAction = { type: 'command', command: 'x', label: 'x' };
		assert.equal(isGuided({ headline: 'h', nextStep: 'n', actions: [action], noActionReason: 'none' }), false);
	});

	it('rejects a screen with neither an action nor a reason', () => {
		assert.equal(isGuided({ headline: 'h', nextStep: 'n', actions: [] }), false);
	});
});

describe('switchTargets', () => {
	it('never offers the environment already selected', () => {
		assert.ok(!switchTargets(BOTH_DEPLOYED(), 'production').some((s) => s.id === 'production'));
	});

	it('does not offer a stage that is not deployed', () => {
		// Switching there would land on another empty screen, which is worse than
		// not offering it.
		assert.deepEqual(
			switchTargets(SANDBOX_MISSING(), 'local').map((s) => s.id),
			['production'],
		);
	});

	it('puts a known-deployed environment ahead of one whose state could not be read', () => {
		const from = statuses(env('sandbox', 'unknown'), env('production', 'deployed'));
		assert.deepEqual(
			switchTargets(from, 'local').map((s) => s.id),
			['production', 'sandbox'],
		);
	});

	it('still offers an environment whose state could not be read', () => {
		// D79: only `not-deployed` is refused. Dropping `unknown` would claim we
		// looked and found nothing when we could not look at all.
		const from = statuses(env('sandbox', 'unknown'), env('production', 'unknown'));
		assert.deepEqual(
			switchTargets(from, 'local').map((s) => s.id),
			['sandbox', 'production'],
		);
	});

	it('offers local when a deployed stage is selected', () => {
		assert.ok(switchTargets(BOTH_DEPLOYED(), 'production').some((s) => s.id === 'local'));
	});
});

describe('guidedEmpty: a cloud-only pillar in local', () => {
	it('offers the deployed stage and omits the undeployed one', () => {
		assert.deepEqual(switches(guide({ kind: 'local-pillar', pillar: 'logs' })), ['production']);
	});

	it('offers the deploy command for the stage that actually needs deploying', () => {
		assert.deepEqual(commands(guide({ kind: 'local-pillar', pillar: 'logs' })), ['deploy:sandbox']);
	});

	it('offers no deploy command when every stage is already deployed', () => {
		// Nothing needs deploying, so a deploy button would be noise next to two
		// working environments.
		assert.deepEqual(commands(guide({ kind: 'local-pillar', pillar: 'cost' }, BOTH_DEPLOYED())), []);
	});

	it('offers no deploy command while the stages are still unread', () => {
		// We have not been told whether anything is deployed. Telling someone to
		// deploy on the strength of a guess is worse than offering only a switch.
		assert.deepEqual(commands(guide({ kind: 'local-pillar', pillar: 'usage' }, statuses())), []);
	});

	it('names switching in the next step only when a switch is on offer', () => {
		const withSwitch = guide({ kind: 'local-pillar', pillar: 'logs' });
		const withoutSwitch = guide({ kind: 'local-pillar', pillar: 'logs' }, NEITHER_DEPLOYED());
		assert.match(withSwitch.nextStep, /[Ss]witch/);
		assert.deepEqual(switches(withoutSwitch), []);
		assert.ok(
			!/[Ss]witch to an environment that is already running/.test(withoutSwitch.nextStep),
			`promised a switch with none offered: ${withoutSwitch.nextStep}`,
		);
	});

	it('keeps the mechanism sentence as the detail rather than discarding it', () => {
		// The reason is useful once you know what to do, so it is demoted, not
		// deleted. Compared against the real function, so the two cannot drift.
		for (const pillar of CLOUD_ONLY_PILLARS) {
			assert.equal(guide({ kind: 'local-pillar', pillar }).detail, localNotApplicableReason(pillar));
		}
	});

	it('gives every pillar its own headline', () => {
		const headlines = CLOUD_ONLY_PILLARS.map((pillar) => guide({ kind: 'local-pillar', pillar }).headline);
		assert.equal(new Set(headlines).size, CLOUD_ONLY_PILLARS.length);
	});

	it('writes headlines in plain words, with no AWS noun and no error code', () => {
		for (const pillar of CLOUD_ONLY_PILLARS) {
			const { headline } = guide({ kind: 'local-pillar', pillar });
			assert.ok(!/CloudWatch|CloudFormation|Lambda|DynamoDB|HTTP|\d{3}/.test(headline), headline);
			assert.ok(!/not applicable|unavailable/i.test(headline), headline);
		}
	});

	it('marks a switch to an unresolved environment with its reason, and a deployed one without', () => {
		const from = statuses(env('sandbox', 'unknown'), env('production', 'deployed'));
		const actions = guide({ kind: 'local-pillar', pillar: 'logs' }, from).actions;
		const unresolved = actions.find((a) => a.type === 'switch' && a.environment === 'sandbox');
		const deployed = actions.find((a) => a.type === 'switch' && a.environment === 'production');
		assert.ok(unresolved?.type === 'switch' && typeof unresolved.hint === 'string');
		assert.ok(deployed?.type === 'switch' && deployed.hint === undefined);
	});

	it('offers the Blocks route for resources, on every resources screen', () => {
		// It used to exist in one page's markup, so the resources INDEX printed a
		// sentence naming Blocks with no way to follow it. Owning it here is what
		// makes both screens agree.
		assert.deepEqual(links(guide({ kind: 'local-pillar', pillar: 'resources' })), ['/blocks']);
	});

	it('offers a route only where the reason actually names one', () => {
		// The invariant, not just the resources case: a detail sentence that
		// promises somewhere to go must come with the way to get there, and one
		// that does not must not sprout a link.
		for (const pillar of CLOUD_ONLY_PILLARS) {
			const guided = guide({ kind: 'local-pillar', pillar });
			const promisesBlocks = /\bBlocks\b/.test(String(guided.detail));
			assert.equal(
				links(guided).length > 0,
				promisesBlocks,
				`${pillar}: reason ${promisesBlocks ? 'promises' : 'does not promise'} Blocks but offers ${links(guided).length} route(s)`,
			);
		}
	});

	it('puts the alternative route last, behind the environment that answers properly', () => {
		const actions = guide({ kind: 'local-pillar', pillar: 'resources' }).actions;
		assert.equal(actions.at(-1)?.type, 'link');
		assert.ok(actions.length > 1, 'the link should not be the only action here');
	});

	it('states why there is nothing to offer when no stage is even known', () => {
		// Reachable: `/api/v1/meta` failed, so there is no stage list, and local is
		// the only environment there is. Nothing to switch to and nothing known to
		// deploy, so the absence has to be spoken rather than left as a bare card.
		const guided = guidedEmpty(
			{ kind: 'local-pillar', pillar: 'logs' },
			environmentStatuses([], deployCommand, []),
			'local',
			deployCommand,
			localNotApplicableReason,
		);
		assert.deepEqual(guided.actions, []);
		assert.match(String(guided.noActionReason), /nothing to switch to/);
		assert.ok(isGuided(guided));
	});
});

describe('guidedEmpty: a stage with nothing deployed', () => {
	it('leads with the deploy command, because that is the direct answer', () => {
		const guided = guide({ kind: 'not-deployed', stage: 'production' }, SANDBOX_MISSING(), 'production');
		assert.equal(guided.actions[0]?.type, 'command');
		assert.deepEqual(commands(guided), ['deploy:production']);
	});

	it('uses the real script for each stage', () => {
		// The one assertion against the genuine commands rather than the stub, so
		// the two stages cannot be collapsed onto one script.
		const forProd = guidedEmpty(
			{ kind: 'not-deployed', stage: 'production' },
			BOTH_DEPLOYED(),
			'production',
			deployCommandFor,
			localNotApplicableReason,
		);
		const forSandbox = guidedEmpty(
			{ kind: 'not-deployed', stage: 'sandbox' },
			BOTH_DEPLOYED(),
			'sandbox',
			deployCommandFor,
			localNotApplicableReason,
		);
		assert.deepEqual(commands(forProd), ['npm run deploy']);
		assert.deepEqual(commands(forSandbox), ['npm run sandbox']);
	});

	it('names the stage in the headline', () => {
		assert.match(guide({ kind: 'not-deployed', stage: 'production' }).headline, /production/);
	});

	it("keeps the provider's sentence as the detail, since it names the region looked in", () => {
		const guided = guide({ kind: 'not-deployed', stage: 'production', detail: 'looked in eu-west-1' });
		assert.equal(guided.detail, 'looked in eu-west-1');
	});
});

describe('guidedEmpty: nothing recorded yet', () => {
	it('offers the deploy command when no deployment has happened', () => {
		assert.deepEqual(commands(guide({ kind: 'nothing-recorded', subject: 'deployments', stage: 'sandbox' })), [
			'deploy:sandbox',
		]);
	});

	it('offers nothing to run for an idle app, and says why', () => {
		const guided = guide({ kind: 'nothing-recorded', subject: 'traffic', stage: 'sandbox' });
		assert.deepEqual(guided.actions, []);
		assert.match(String(guided.noActionReason), /nothing to run/i);
	});

	it('does not share copy with access-denied', () => {
		// The defect worth pinning: "no traffic" and "we were not allowed to look"
		// render as the same flat chart, and only one of them means the app is
		// idle. Conflating the copy makes a permissions problem invisible.
		const idle = guide({ kind: 'nothing-recorded', subject: 'traffic', stage: 'sandbox' });
		const denied = guide({ kind: 'access-denied', permission: 'cloudwatch:GetMetricData' });
		assert.notEqual(idle.headline, denied.headline);
		assert.notEqual(idle.nextStep, denied.nextStep);
		assert.notEqual(idle.noActionReason, denied.noActionReason);
	});

	it('keeps the page mechanism sentence as the detail, for either subject', () => {
		// The deployments page explains that history has TWO sources, so an empty
		// list means both are empty. The command is a button now, but that sentence
		// is not something a button can say.
		for (const subject of ['deployments', 'traffic'] as const) {
			const guided = guide({
				kind: 'nothing-recorded',
				subject,
				stage: 'sandbox',
				detail: 'two sources, both empty',
			});
			assert.equal(guided.detail, 'two sources, both empty', subject);
		}
	});
});

describe('guidedEmpty: unauthorized', () => {
	it('offers no command to copy, because the dashboard script is per project', () => {
		// `npm run dashboard` is defined by one of the eight templates. Offering it
		// would hand most readers `command not found` on top of their actual
		// problem, which is the mistake `commands.ts` exists to prevent.
		const guided = guide({ kind: 'unauthorized' });
		assert.deepEqual(guided.actions, []);
		assert.match(String(guided.noActionReason), /differs from project to project/);
		assert.ok(!/npm run/.test(guided.nextStep), guided.nextStep);
	});

	it('still tells the reader what to do', () => {
		assert.match(guide({ kind: 'unauthorized' }).nextStep, /[Rr]estart/);
	});

	it('keeps the status as the detail', () => {
		assert.equal(guide({ kind: 'unauthorized', detail: 'HTTP 401' }).detail, 'HTTP 401');
	});
});

describe('guidedEmpty: access denied', () => {
	it('names the exact permission needed', () => {
		const guided = guide({ kind: 'access-denied', permission: 'cloudwatch:GetMetricData' });
		assert.match(guided.nextStep, /cloudwatch:GetMetricData/);
	});

	it('says why there is no button rather than rendering a dead card', () => {
		const guided = guide({ kind: 'access-denied', permission: 'cloudwatch:GetMetricData' });
		assert.deepEqual(guided.actions, []);
		// Deliberately "your AWS account" and not "IAM": the Cost page reaches this
		// screen when Cost Explorer is merely not enabled, which no permission
		// fixes, so naming IAM would be false on one of the two callers.
		assert.match(String(guided.noActionReason), /AWS account/);
		assert.ok(!/\bIAM\b/.test(String(guided.noActionReason)), guided.noActionReason);
	});
});

describe('guidedEmpty: shape', () => {
	it('always writes a headline and exactly one next-step sentence', () => {
		for (const screen of EVERY_SCREEN) {
			const guided = guide(screen);
			assert.ok(guided.headline.length > 0, screen.kind);
			assert.ok(guided.nextStep.length > 0, screen.kind);
			// One sentence: a single terminating period at the very end.
			assert.equal(guided.nextStep.trim().match(/\.(\s|$)/g)?.length, 1, guided.nextStep);
		}
	});

	it('labels every action with something a reader can act on', () => {
		for (const screen of EVERY_SCREEN) {
			for (const action of guide(screen).actions) {
				assert.ok(action.label.length > 0, `${screen.kind} has an unlabelled action`);
			}
		}
	});
});
