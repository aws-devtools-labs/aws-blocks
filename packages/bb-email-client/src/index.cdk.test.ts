// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for EmailClient: the shared execution role gets only the SES
 * actions the runtime calls (SendEmail for send(), SendBulkEmail for
 * sendBatch()), scoped to this account's identities and configuration sets.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME, BlocksPresets, type BlocksDefaults } from '@aws-blocks/core/cdk';
import { EmailClient } from './index.cdk.js';

// Minimal BlocksStack-shaped parent exposing the shared `executionRole` the
// Building Block grants to (see bb-kv-store's index.cdk.test.ts).
class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly id: string;
	public defaults: BlocksDefaults = BlocksPresets.production;
	constructor(scope: Construct, id: string) {
		super(scope, id, { env: { account: '123456789012', region: 'us-east-1' } });
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.executionRole = new cdk.aws_iam.Role(this, 'BlocksRole', {
			assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
		});
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
}

function sesStatements(options: { maxBatchSize?: number } = {}): Array<{ Action: string | string[]; Resource: unknown }> {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	const originalWarn = console.warn;
	console.warn = () => {}; // the construct prints an SES domain-verification reminder
	try {
		new EmailClient(new Scope('app'), 'mail', { fromAddress: 'noreply@example.com', ...options });
	} finally {
		console.warn = originalWarn;
	}
	return Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy'))
		.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
		.filter((statement: any) => [statement.Action].flat().some((action: string) => action.startsWith('ses:')));
}

test('CDK: EmailClient grants exactly ses:SendEmail and ses:SendBulkEmail', () => {
	const statements = sesStatements();
	assert.strictEqual(statements.length, 1, 'one SES statement');
	assert.deepStrictEqual([statements[0].Action].flat().sort(), ['ses:SendBulkEmail', 'ses:SendEmail']);
});

test('CDK: EmailClient does not grant raw-MIME or stored-template sends', () => {
	const actions = sesStatements().flatMap((statement) => [statement.Action].flat());
	for (const unused of ['ses:SendRawEmail', 'ses:SendTemplatedEmail', 'ses:SendBulkTemplatedEmail']) {
		assert.ok(!actions.includes(unused), `${unused} must not be granted`);
	}
});

test('CDK: the SES grant stays scoped to this account', () => {
	const resources = JSON.stringify(sesStatements()[0].Resource);
	assert.ok(resources.includes(':123456789012:identity/*'), resources);
	assert.ok(resources.includes(':123456789012:configuration-set/*'), resources);
	assert.ok(!resources.includes('"*"'), 'no wildcard resource');
});

test('CDK: the SES grant is scoped to the stack region and partition, not every region', () => {
	const resources = JSON.stringify(sesStatements()[0].Resource);
	assert.ok(!resources.includes('arn:aws:ses:*:'), `no any-region wildcard: ${resources}`);
	assert.ok(resources.includes(':ses:us-east-1:123456789012:identity/*'), resources);
	assert.ok(resources.includes(':ses:us-east-1:123456789012:configuration-set/*'), resources);
	assert.ok(resources.includes('AWS::Partition'), `partition is not hard-coded: ${resources}`);
});

test('CDK: an invalid maxBatchSize fails at synth', () => {
	assert.throws(() => sesStatements({ maxBatchSize: 0 }), /maxBatchSize/);
});

// A sender on a reserved domain (RFC 2606 / RFC 6761) can never be verified as
// an SES identity, so every send from it fails on AWS. The construct flags it
// at synth with an acknowledgeable warning; a reply-to address on such a
// domain is flagged too, since replies to it can never be delivered.
function synthWarnings(
	options: { fromAddress: string; replyTo?: string[] },
	context: Record<string, string> = {},
): Array<{ id: string; message: string }> {
	const app = new cdk.App({ context });
	const stack = new StubBlocksStack(app, 'TestStack');
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		new EmailClient(new Scope('app'), 'mail', options);
	} finally {
		console.warn = originalWarn;
	}
	return Annotations.fromStack(stack)
		.findWarning('*', Match.anyValue())
		.map((entry) => {
			const message = String(entry.entry.data);
			return { id: /\[ack: ([^\]]+)\]/.exec(message)?.[1] ?? '', message };
		});
}

const SENDER_WARNING = '@aws-blocks/bb-email-client:UnverifiableSender';
const REPLY_TO_WARNING = '@aws-blocks/bb-email-client:UndeliverableReplyTo';

for (const fromAddress of [
	'noreply@example.com',
	'noreply@mail.example.org',
	'NoReply@EXAMPLE.NET',
	'App <noreply@example.com>',
	'noreply@app.test',
	'noreply@acme.example',
	'noreply@replace-me.invalid',
	'noreply@localhost',
	'noreply@dev.localhost',
]) {
	test(`CDK: a sender on a reserved domain (${fromAddress}) raises ${SENDER_WARNING}`, () => {
		const warnings = synthWarnings({ fromAddress }).filter((w) => w.id === SENDER_WARNING);
		assert.strictEqual(warnings.length, 1, `expected one ${SENDER_WARNING} warning`);
		assert.match(warnings[0].message, /can never be verified/);
	});
}

for (const fromAddress of ['noreply@acme.com', 'noreply@notexample.com', 'noreply@example.com.au', 'noreply@mytest.dev']) {
	test(`CDK: a sender on a normal domain (${fromAddress}) raises no reserved-domain warning`, () => {
		const ids = synthWarnings({ fromAddress }).map((w) => w.id);
		assert.ok(!ids.includes(SENDER_WARNING), `unexpected ${SENDER_WARNING} for ${fromAddress}`);
		assert.ok(!ids.includes(REPLY_TO_WARNING), `unexpected ${REPLY_TO_WARNING} for ${fromAddress}`);
	});
}

test('CDK: the reserved-sender warning is raised on sandbox and production synths', () => {
	const contexts: Array<Record<string, string>> = [{ sandboxMode: 'true' }, {}];
	for (const context of contexts) {
		const ids = synthWarnings({ fromAddress: 'noreply@example.com' }, context).map((w) => w.id);
		assert.ok(ids.includes(SENDER_WARNING), `expected ${SENDER_WARNING} with context ${JSON.stringify(context)}`);
	}
});

test('CDK: a reply-to address on a reserved domain raises its own warning', () => {
	const warnings = synthWarnings({ fromAddress: 'noreply@acme.com', replyTo: ['support@acme.com', 'help@example.org'] });
	const replyTo = warnings.filter((w) => w.id === REPLY_TO_WARNING);
	assert.strictEqual(replyTo.length, 1, `expected one ${REPLY_TO_WARNING} warning`);
	assert.match(replyTo[0].message, /help@example\.org/);
	assert.ok(!replyTo[0].message.includes('support@acme.com'), 'only the reserved address is named');
	assert.ok(!warnings.some((w) => w.id === SENDER_WARNING), 'the sender itself is fine');
});

test('CDK: the reserved-sender warning can be acknowledged', () => {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	cdk.Annotations.of(stack).acknowledgeWarning(SENDER_WARNING);
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		new EmailClient(new Scope('app'), 'mail', { fromAddress: 'noreply@example.com' });
	} finally {
		console.warn = originalWarn;
	}
	const messages = Annotations.fromStack(stack)
		.findWarning('*', Match.anyValue())
		.map((entry) => String(entry.entry.data));
	assert.ok(!messages.some((m) => m.includes(SENDER_WARNING)), 'acknowledged warning is not reported');
});
