// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture for the service-principal trust check in a `BlocksStack`: a
 * backend module that creates one unconditioned service role inside a "block"
 * (a `Scope` subclass, so AWS Blocks' own) and two the app owns — one at stack
 * scope and one under the app's plain `Scope` namespace — plus an EventBridge
 * rule targeting a Step Functions state machine, whose `EventsRole` CDK
 * creates trusting `events.amazonaws.com` with no condition and no prop to
 * shape it.
 *
 * The block's role is created only when `TRUST_CHECK_BLOCK_ROLE` is set, so one
 * module serves both the "block role fails synth" and the "app roles warn"
 * tests.
 */
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';
import type { ScopeParent } from '../../common/index.js';
import { Scope } from '../index.js';

class FakeBlock extends Scope {
	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		new iam.Role(this, 'ServiceRole', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
	}
}

export default function (root: Construct) {
	if (process.env.TRUST_CHECK_BLOCK_ROLE) new FakeBlock(root as unknown as ScopeParent, 'block');
	const namespace = new Scope('app', { parent: root as unknown as ScopeParent });
	new iam.Role(namespace, 'NamespaceRole', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
	new iam.Role(root, 'ModuleRole', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
	const machine = new sfn.StateMachine(root, 'UserSM', {
		definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(root, 'Pass')),
	});
	new events.Rule(root, 'Every5', {
		schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
		targets: [new targets.SfnStateMachine(machine)],
	});
}
