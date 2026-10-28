// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks-iam-policies`: generate the IAM policies a shared app platform needs
 * for apps that set `defaults.app` — **EXPERIMENTAL**: review the output and test
 * it on a deployed app before relying on it.
 *
 * 1. **The permissions boundary** — one managed policy for every app in the
 *    account, attached to every role an app creates (`defaults.permissionsBoundary`).
 *    It is an **allow-list**: it allows only the services AWS Blocks uses, each
 *    on the calling role's own app's resources — by name prefix (`<id>-…`, which
 *    AWS Blocks guarantees for an app that sets `defaults.app`) or by the
 *    resource's `app` tag, keyed on `${aws:PrincipalTag/app}` — plus the few
 *    actions that only take `*` (X-Ray, metrics, VPC network interfaces). A
 *    service nobody wrote a rule for is denied by default. IAM, Organizations and
 *    STS role assumption are never allowed. `execute-api` can't be scoped by name
 *    or tag, so an app that calls its own APIs through it gets a **per-app**
 *    boundary listing exactly those API ids (`executeApiIds`).
 * 2. **The per-app CloudFormation execution policy** — attached to the app's own
 *    CDK bootstrap execution role (`cdk bootstrap --qualifier <id>
 *    --cloudformation-execution-policies <arn>`). It can only create roles that
 *    carry the boundary, are named `<id>-…` and are tagged `app=<id>`, can never
 *    remove the boundary, edit it, re-tag a role or attach a broad AWS managed
 *    policy, and can manage only the resource types the app's templates use, each
 *    scoped to the app's names or its `app` tag. Resource types it has no scoped
 *    rule for are listed in `unscoped`.
 * 3. **The deploy guard** — attached to the app's CDK bootstrap **deploy** role.
 *    CDK's default deploy role may change and delete *any* stack, and
 *    CloudFormation reuses a stack's existing service role when an update omits
 *    one, so without this an app's pipeline could deploy into — or delete —
 *    another app's stack as that app's execution role. The guard confines the
 *    deploy role to the app's own stacks and to its own execution role.
 *
 * The app's bootstrap qualifier is the app id itself (an app id is at most 10
 * characters, CDK's qualifier limit), so every app has its own bootstrap and no
 * two apps can share one.
 *
 * The generator only writes JSON; it never calls AWS.
 */

/** Options for {@link generateBoundaryPolicy} / {@link generateExecutionPolicy}. */
export interface IamPolicyOptions {
	/** The app id (`defaults.app.id`). Required for the execution policy. */
	appId?: string;
	/** The AWS account the apps deploy into. Required for the execution policy. */
	account?: string;
	/** The boundary policy's name (default `apps-boundary`). */
	boundaryName?: string;
	/** The AWS partition (default `aws`). */
	partition?: string;
	/**
	 * The ids of the app's own API Gateway APIs its roles call through
	 * `execute-api` (a Realtime WebSocket API's `ManageConnections`, an
	 * IAM-authorized API's `Invoke`). API ids aren't names and `execute-api` has
	 * no resource tags, so these can't be scoped by the shared boundary: when
	 * given, {@link generateBoundaryPolicy} returns a per-app boundary that allows
	 * `execute-api` on exactly these APIs. Without them, `execute-api` is denied.
	 */
	executeApiIds?: string[];
}

/** An IAM policy document. */
export interface PolicyDocument {
	Version: '2012-10-17';
	Statement: Record<string, unknown>[];
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: an IAM policy variable, resolved by IAM at request time
const APP = '${aws:PrincipalTag/app}';
const DEFAULT_BOUNDARY = 'apps-boundary';

/** The condition "the resource is tagged as the calling role's app". */
const thisAppsResource = { StringEquals: { 'aws:ResourceTag/app': APP } };

/**
 * The shared permissions boundary (see the module doc): an allow-list. One
 * document for every app in the account; it reads the calling role's `app` tag
 * at request time.
 */
export function generateBoundaryPolicy(options: IamPolicyOptions = {}): PolicyDocument {
	const p = options.partition ?? 'aws';
	const named = (service: string, ...resources: string[]) => resources.map((r) => `arn:${p}:${service}:${r}`);
	const allow = (Sid: string, Action: string | string[], Resource: string | string[], Condition?: unknown) => ({
		Sid,
		Effect: 'Allow',
		Action,
		Resource,
		...(Condition ? { Condition } : {}),
	});
	return {
		Version: '2012-10-17',
		Statement: [
			// By name prefix: AWS Blocks names these from the stack name, which starts with the app id.
			allow('OwnParameters', 'ssm:*', [
				...named('ssm', `*:*:parameter/${APP}`, `*:*:parameter/${APP}-*`, `*:*:parameter/${APP}/*`),
				// Cross-region references Hosting creates (`/cdk/exports/<consumer stack>/…`).
				...named('ssm', `*:*:parameter/cdk/exports/${APP}`, `*:*:parameter/cdk/exports/${APP}-*`, `*:*:parameter/cdk/exports/${APP}/*`),
			]),
			allow('OwnTables', 'dynamodb:*', named('dynamodb', `*:*:table/${APP}-*`, `*:*:table/${APP}-*/*`)),
			allow('OwnQueues', 'sqs:*', named('sqs', `*:*:${APP}-*`)),
			allow('OwnBuckets', 's3:*', [`arn:${p}:s3:::${APP}-*`, `arn:${p}:s3:::${APP}-*/*`]),
			// BucketDeployment reads the app's assets from its own bootstrap's asset bucket (qualifier = app id).
			allow('ReadOwnCdkAssets', ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:GetBucketLocation'], [
				`arn:${p}:s3:::cdk-${APP}-assets-*`,
				`arn:${p}:s3:::cdk-${APP}-assets-*/*`,
			]),
			allow('OwnFunctions', 'lambda:*', named('lambda', `*:*:function:${APP}-*`)),
			allow('OwnLogs', 'logs:*', named('logs', `*:*:log-group:${APP}-*`, `*:*:log-group:/aws/lambda/${APP}-*`)),
			// Exception: AgentCore runtimes log to AWS-named groups that can't carry the app's prefix — write only.
			allow(
				'AgentCoreRuntimeLogsWriteOnly',
				['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
				named('logs', '*:*:log-group:/aws/bedrock-agentcore/runtimes/*'),
			),
			// A table's index manager reads its own stack.
			allow(
				'OwnStacksRead',
				['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
				named('cloudformation', `*:*:stack/${APP}/*`, `*:*:stack/${APP}-*/*`),
			),
			allow('OwnSchedules', 'scheduler:*', named('scheduler', `*:*:schedule/*/${APP}-*`)),
			allow('OwnEvents', 'events:*', named('events', `*:*:rule/${APP}-*`, `*:*:event-bus/${APP}-*`)),
			allow('OwnDatabases', ['rds-data:*', 'rds:*'], named('rds', `*:*:cluster:${APP}-*`, `*:*:db:${APP}-*`)),
			// By the resource's `app` tag: these are named by id, not by a name the app controls.
			allow(
				'OwnTaggedResources',
				[
					'secretsmanager:*',
					'states:*',
					'cognito-idp:*',
					'kms:*',
					'bedrock:*',
					'bedrock-agentcore:*',
					'dsql:*',
					's3vectors:*',
					'cloudfront:*',
					'cloudfront-keyvaluestore:*',
				],
				'*',
				thisAppsResource,
			),
			// AWS-managed keys (aws/ssm, aws/secretsmanager, …) carry no tag: only through the service.
			allow('ManagedKeysViaService', ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'], '*', {
				StringLike: {
					'kms:ViaService': ['ssm.*.amazonaws.com', 'secretsmanager.*.amazonaws.com', 'dynamodb.*.amazonaws.com', 's3.*.amazonaws.com', 'sqs.*.amazonaws.com'],
				},
			}),
			// Actions that take no resource, or only `*`.
			allow(
				'ResourcelessActions',
				[
					'xray:PutTraceSegments',
					'xray:PutTelemetryRecords',
					'xray:GetSamplingRules',
					'xray:GetSamplingTargets',
					'cloudwatch:PutMetricData',
					'logs:DescribeLogGroups',
					'ec2:CreateNetworkInterface',
					'ec2:DescribeNetworkInterfaces',
					'ec2:DeleteNetworkInterface',
					'ec2:AssignPrivateIpAddresses',
					'ec2:UnassignPrivateIpAddresses',
					'ec2:DescribeSubnets',
					'ec2:DescribeVpcs',
					'ec2:DescribeSecurityGroups',
					'bedrock:InvokeModel',
					'bedrock:InvokeModelWithResponseStream',
					'ses:SendEmail',
					'ses:SendRawEmail',
					'ses:SendBulkEmail',
				],
				'*',
			),
			// WebSocket (Realtime) and IAM-authorized API calls: API ids aren't names and
			// `execute-api` has no resource tags, so only the APIs listed for this app.
			...(options.executeApiIds && options.executeApiIds.length > 0
				? [
						allow(
							'OwnApis',
							['execute-api:ManageConnections', 'execute-api:Invoke'],
							options.executeApiIds.map((apiId) => `arn:${p}:execute-api:*:*:${apiId}/*`),
						),
					]
				: []),
		],
	};
}

/** CloudFormation resource types → the scoped statements the execution role needs to manage them. */
type Rule = (ctx: { id: string; p: string; acct: string }) => Record<string, unknown>[];

const byName = (sid: string, action: string | string[], resources: string[]): Record<string, unknown> => ({
	Sid: sid,
	Effect: 'Allow',
	Action: action,
	Resource: resources,
});

const byTag = (sid: string, action: string | string[], id: string, resource = '*'): Record<string, unknown>[] => [
	{
		Sid: `${sid}Create`,
		Effect: 'Allow',
		Action: action,
		Resource: resource,
		Condition: { StringEquals: { 'aws:RequestTag/app': id } },
	},
	{
		Sid: `${sid}Manage`,
		Effect: 'Allow',
		Action: action,
		Resource: resource,
		Condition: { StringEquals: { 'aws:ResourceTag/app': id } },
	},
];

const RULES: Record<string, Rule> = {
	'AWS::Lambda::': ({ id, p, acct }) => [
		byName('Functions', 'lambda:*', [`arn:${p}:lambda:*:${acct}:function:${id}-*`]),
		// AWS Blocks names every layer in an app's stack `<id>-…` under `defaults.app`.
		byName('Layers', ['lambda:PublishLayerVersion', 'lambda:DeleteLayerVersion', 'lambda:GetLayerVersion'], [
			`arn:${p}:lambda:*:${acct}:layer:${id}-*`,
			`arn:${p}:lambda:*:${acct}:layer:${id}-*:*`,
		]),
		{
			Sid: 'EventSourceMappings',
			Effect: 'Allow',
			Action: [
				'lambda:CreateEventSourceMapping',
				'lambda:GetEventSourceMapping',
				'lambda:UpdateEventSourceMapping',
				'lambda:DeleteEventSourceMapping',
			],
			Resource: '*',
			Condition: { ArnLike: { 'lambda:FunctionArn': `arn:${p}:lambda:*:${acct}:function:${id}-*` } },
		},
	],
	'AWS::Logs::': ({ id, p, acct }) => [
		byName('LogGroups', 'logs:*', [
			`arn:${p}:logs:*:${acct}:log-group:${id}-*`,
			`arn:${p}:logs:*:${acct}:log-group:/aws/lambda/${id}-*`,
		]),
		byName('DescribeLogGroups', 'logs:DescribeLogGroups', ['*']),
	],
	'AWS::DynamoDB::': ({ id, p, acct }) => [
		byName('Tables', 'dynamodb:*', [
			`arn:${p}:dynamodb:*:${acct}:table/${id}-*`,
			`arn:${p}:dynamodb:*:${acct}:table/${id}-*/*`,
		]),
	],
	'AWS::SQS::': ({ id, p, acct }) => [byName('Queues', 'sqs:*', [`arn:${p}:sqs:*:${acct}:${id}-*`])],
	'AWS::S3::': ({ id, p }) => [byName('Buckets', 's3:*', [`arn:${p}:s3:::${id}-*`, `arn:${p}:s3:::${id}-*/*`])],
	'AWS::SSM::': ({ id, p, acct }) => [
		byName('Parameters', 'ssm:*', [
			`arn:${p}:ssm:*:${acct}:parameter/${id}`,
			`arn:${p}:ssm:*:${acct}:parameter/${id}-*`,
			`arn:${p}:ssm:*:${acct}:parameter/${id}/*`,
		]),
	],
	'AWS::SecretsManager::': ({ id }) => byTag('Secrets', 'secretsmanager:*', id),
	// REST (`AWS::ApiGateway::*`) and HTTP/WebSocket (`AWS::ApiGatewayV2::*`) APIs:
	// API ids aren't names, so these are scoped by the `app` tag.
	'AWS::ApiGateway': ({ id, p }) =>
		byTag('Apis', ['apigateway:GET', 'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE'], id, `arn:${p}:apigateway:*::/*`),
	'AWS::Scheduler::': ({ id, p, acct }) => [
		byName('Schedules', 'scheduler:*', [`arn:${p}:scheduler:*:${acct}:schedule/*/${id}-*`]),
	],
	'AWS::Events::': ({ id, p, acct }) => [byName('Rules', 'events:*', [`arn:${p}:events:*:${acct}:rule/${id}-*`])],
	'AWS::Cognito::': ({ id }) => byTag('UserPools', 'cognito-idp:*', id),
	'AWS::KMS::': ({ id }) => byTag('Keys', 'kms:*', id),
	'AWS::ResourceGroups::': ({ id, p, acct }) => [
		byName('ResourceGroups', 'resource-groups:*', [`arn:${p}:resource-groups:*:${acct}:group/${id}-*`]),
		byName('ResourceGroupsStackQuery', ['cloudformation:DescribeStacks', 'cloudformation:ListStackResources', 'tag:GetResources'], ['*']),
	],
	'AWS::CloudWatch::': ({ id, p, acct }) => [
		byName('Dashboards', ['cloudwatch:PutDashboard', 'cloudwatch:GetDashboard', 'cloudwatch:DeleteDashboards'], [
			`arn:${p}:cloudwatch::${acct}:dashboard/${id}-*`,
		]),
	],
};

/** Types the role-fence statements already cover, or that need no permission. */
const COVERED = /^(AWS::IAM::(Role|Policy|RolePolicy)|AWS::CDK::Metadata|AWS::CloudFormation::(CustomResource|WaitCondition.*)|Custom::.*)$/;

/** The rule key (`AWS::<Service>::`) for a resource type, if there is one. */
const ruleKey = (type: string) => Object.keys(RULES).find((k) => type.startsWith(k));

/** What {@link generateExecutionPolicy} returns. */
export interface ExecutionPolicy {
	document: PolicyDocument;
	/** Resource types the app's templates use that have no scoped rule: add their statements by hand. */
	unscoped: string[];
}

/**
 * The per-app CloudFormation execution policy (see the module doc), for the
 * resource types in `resourceTypes` (from the app's synthesized templates).
 *
 * @throws Error when `appId` or `account` is missing.
 */
export function generateExecutionPolicy(resourceTypes: Iterable<string>, options: IamPolicyOptions): ExecutionPolicy {
	const { appId: id, account: acct } = options;
	if (!id) throw new Error('The execution policy needs the app id (--app).');
	if (!acct || !/^\d{12}$/.test(acct)) throw new Error('The execution policy needs the 12-digit AWS account (--account).');
	const p = options.partition ?? 'aws';
	const boundaryArn = `arn:${p}:iam::${acct}:policy/${options.boundaryName ?? DEFAULT_BOUNDARY}`;
	const qualifier = id;
	const role = `arn:${p}:iam::${acct}:role/${id}-*`;

	const statements: Record<string, unknown>[] = [
		{
			Sid: 'RolesOnlyWithTheBoundary',
			Effect: 'Allow',
			Action: [
				'iam:CreateRole',
				'iam:PutRolePolicy',
				'iam:DeleteRolePolicy',
				'iam:AttachRolePolicy',
				'iam:DetachRolePolicy',
				'iam:PutRolePermissionsBoundary',
			],
			Resource: role,
			Condition: { StringEquals: { 'iam:PermissionsBoundary': boundaryArn } },
		},
		{
			Sid: 'RoleLifecycle',
			Effect: 'Allow',
			Action: [
				'iam:GetRole',
				'iam:GetRolePolicy',
				'iam:ListRolePolicies',
				'iam:ListAttachedRolePolicies',
				'iam:ListRoleTags',
				'iam:DeleteRole',
				'iam:TagRole',
				'iam:UntagRole',
				'iam:UpdateAssumeRolePolicy',
				'iam:UpdateRoleDescription',
				'iam:PassRole',
			],
			Resource: role,
		},
		{
			Sid: 'RequireThisAppsTag',
			Effect: 'Deny',
			Action: 'iam:CreateRole',
			Resource: '*',
			Condition: { StringNotEquals: { 'aws:RequestTag/app': id } },
		},
		{
			// Only a request that sets the `app` key to another value is denied, so tag
			// updates that don't touch `app` still work.
			Sid: 'NoRetaggingToAnotherApp',
			Effect: 'Deny',
			Action: 'iam:TagRole',
			Resource: '*',
			Condition: {
				StringNotEquals: { 'aws:RequestTag/app': id },
				'ForAnyValue:StringEquals': { 'aws:TagKeys': ['app'] },
			},
		},
		{
			Sid: 'NoUntaggingApp',
			Effect: 'Deny',
			Action: 'iam:UntagRole',
			Resource: '*',
			Condition: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': ['app'] } },
		},
		{ Sid: 'KeepTheBoundary', Effect: 'Deny', Action: 'iam:DeleteRolePermissionsBoundary', Resource: '*' },
		{
			Sid: 'NoEditingTheBoundary',
			Effect: 'Deny',
			Action: ['iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion'],
			Resource: boundaryArn,
		},
		{
			Sid: 'NoBroadManagedPolicies',
			Effect: 'Deny',
			Action: 'iam:AttachRolePolicy',
			Resource: '*',
			Condition: {
				ArnLike: {
					'iam:PolicyARN': [
						`arn:${p}:iam::aws:policy/AdministratorAccess`,
						`arn:${p}:iam::aws:policy/PowerUserAccess`,
						`arn:${p}:iam::aws:policy/IAMFullAccess`,
						`arn:${p}:iam::aws:policy/*FullAccess`,
					],
				},
			},
		},
		byName('ReadOwnBootstrapVersion', ['ssm:GetParameter', 'ssm:GetParameters'], [
			`arn:${p}:ssm:*:${acct}:parameter/cdk-bootstrap/${qualifier}/*`,
		]),
		byName('ReadOwnBootstrapAssets', ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:GetBucketLocation'], [
			`arn:${p}:s3:::cdk-${qualifier}-assets-${acct}-*`,
			`arn:${p}:s3:::cdk-${qualifier}-assets-${acct}-*/*`,
		]),
	];

	const unscoped = new Set<string>();
	const applied = new Set<string>();
	for (const type of [...new Set(resourceTypes)].sort()) {
		if (COVERED.test(type)) continue;
		const key = ruleKey(type);
		if (!key) {
			unscoped.add(type);
			continue;
		}
		if (applied.has(key)) continue;
		applied.add(key);
		statements.push(...RULES[key]({ id, p, acct }));
	}
	return { document: { Version: '2012-10-17', Statement: statements }, unscoped: [...unscoped].sort() };
}

/** CloudFormation actions that change a stack, or read its template. */
const STACK_ACTIONS = [
	'cloudformation:CreateChangeSet',
	'cloudformation:ExecuteChangeSet',
	'cloudformation:DeleteChangeSet',
	'cloudformation:CreateStack',
	'cloudformation:UpdateStack',
	'cloudformation:DeleteStack',
	'cloudformation:CancelUpdateStack',
	'cloudformation:ContinueUpdateRollback',
	'cloudformation:RollbackStack',
	'cloudformation:SetStackPolicy',
	'cloudformation:UpdateTerminationProtection',
	'cloudformation:SignalResource',
	'cloudformation:GetTemplate',
];

/**
 * The deploy guard for app `appId` (see the module doc): attach it to the app's
 * CDK bootstrap deploy role (`cdk-<id>-deploy-role-<account>-<region>`). It
 * denies stack changes outside the app's own stacks (`<id>`, `<id>-…` — not its
 * bootstrap stack, which only the platform re-bootstraps), and denies creating or changing a stack
 * without naming the app's own execution role — so CloudFormation can't fall back
 * to another stack's role.
 *
 * @throws Error when `appId` or `account` is missing.
 */
export function generateDeployGuardPolicy(options: IamPolicyOptions): PolicyDocument {
	const { appId: id, account: acct } = options;
	if (!id) throw new Error('The deploy guard needs the app id (--app).');
	if (!acct || !/^\d{12}$/.test(acct)) throw new Error('The deploy guard needs the 12-digit AWS account (--account).');
	const p = options.partition ?? 'aws';
	return {
		Version: '2012-10-17',
		Statement: [
			{
				Sid: 'OnlyThisAppsStacks',
				Effect: 'Deny',
				Action: STACK_ACTIONS,
				NotResource: [
					`arn:${p}:cloudformation:*:${acct}:stack/${id}/*`,
					`arn:${p}:cloudformation:*:${acct}:stack/${id}-*/*`,
				],
			},
			{
				// Without RoleARN, CloudFormation reuses the stack's previous service role,
				// so a request must name this app's own execution role.
				Sid: 'OnlyThisAppsExecutionRole',
				Effect: 'Deny',
				Action: ['cloudformation:CreateChangeSet', 'cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack'],
				Resource: '*',
				Condition: {
					StringNotLike: { 'cloudformation:RoleArn': `arn:${p}:iam::${acct}:role/cdk-${id}-cfn-exec-role-${acct}-*` },
				},
			},
		],
	};
}

/** The resource types in a set of CloudFormation templates. */
export function resourceTypesOf(templates: Iterable<{ Resources?: Record<string, { Type?: string }> }>): Set<string> {
	const types = new Set<string>();
	for (const t of templates) for (const r of Object.values(t.Resources ?? {})) if (r.Type) types.add(r.Type);
	return types;
}

/** IAM's limit on a managed policy's size, in characters excluding white space. */
export const MANAGED_POLICY_MAX_CHARS = 6144;

/** A policy's size as IAM counts it (JSON without white space). */
export function policySize(doc: PolicyDocument): number {
	return JSON.stringify(doc).replace(/\s/g, '').length;
}
