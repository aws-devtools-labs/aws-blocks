// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture for the service-principal trust check, used as the backend
 * module of both a `BlocksStack` and an embedded `BlocksBackend`. It creates
 * unconditioned service roles the app owns:
 *
 * - one on the root and one at stack scope (the same place in a `BlocksStack`);
 * - one under the app's plain `Scope` namespace;
 * - one inside a custom block the app writes (a `Scope` subclass whose `bbName`
 *   is not an official Building Block's), next to a state machine and an
 *   EventBridge rule targeting it, whose `EventsRole` CDK creates trusting
 *   `events.amazonaws.com` with no condition and no prop to shape it;
 * - the same rule and state machine pair on the root.
 *
 * Roles AWS Blocks owns are opt-in, so one module serves both the "AWS Blocks
 * role fails synth" and the "app roles warn" tests:
 *
 * - `TRUST_CHECK_BLOCK_ROLE` adds a role inside a block with an official
 *   `bbName` (the way first-party blocks are marked);
 * - `TRUST_CHECK_HELPER_ROLE` adds a role a block hoists to stack scope and
 *   marks as its own (the way first-party stack-level helpers are marked).
 */
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';
import type { ScopeParent } from '../../common/index.js';
import { markAddedChildrenBlocksOwned } from '../blocks-roles.js';
import { Scope } from '../index.js';

/** Stands in for a first-party block: it carries an official `bbName`. */
class FakeBlock extends Scope {
	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope, bbName: 'KVStore' });
		new iam.Role(this, 'ServiceRole', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
	}
}

/** Stands in for a first-party block that hoists a shared helper to stack scope. */
class FakeHoistingBlock extends Scope {
	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope, bbName: 'KVStore' });
		const stack = cdk.Stack.of(this);
		const before = new Set(stack.node.children);
		new iam.Role(stack, 'BlocksFakeHelperRole', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
		markAddedChildrenBlocksOwned(stack, before);
	}
}

/** A custom block the app writes, the documented extension pattern. */
class MyCustomBlock extends Scope {
	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope, bbName: 'MyCustomBlock' });
		const machine = new sfn.StateMachine(this, 'SM', {
			definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(this, 'Pass')),
		});
		new events.Rule(this, 'Every5', {
			schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
			targets: [new targets.SfnStateMachine(machine)],
		});
	}
}

export default function (root: Construct) {
	const parent = root as unknown as ScopeParent;
	if (process.env.TRUST_CHECK_BLOCK_ROLE) new FakeBlock(parent, 'block');
	if (process.env.TRUST_CHECK_HELPER_ROLE) new FakeHoistingBlock(parent, 'hoisting');
	const namespace = new Scope('app', { parent });
	new iam.Role(namespace, 'NamespaceRole', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
	new MyCustomBlock(parent, 'mine');
	new iam.Role(root, 'ModuleRole', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
	const stack = cdk.Stack.of(root);
	if (stack !== root) {
		new iam.Role(stack, 'ModuleStackRole', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
	}
	const machine = new sfn.StateMachine(root, 'UserSM', {
		definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(root, 'Pass')),
	});
	new events.Rule(root, 'Every5', {
		schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
		targets: [new targets.SfnStateMachine(machine)],
	});
}
