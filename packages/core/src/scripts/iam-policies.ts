// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks-iam-policies`: generate the two IAM policies a shared app platform
 * needs for apps that set `defaults.app` — **EXPERIMENTAL**: review the output
 * and test it on a deployed app before relying on it.
 *
 * 1. **The permissions boundary** — one managed policy for every app in the
 *    account. Attach it to every role an app creates (`defaults.permissionsBoundary`).
 *    It allows everything except reaching another app's resources, keyed on the
 *    role's `app` tag (`${aws:PrincipalTag/app}`): parameters, tables, queues and
 *    buckets by name prefix (`<id>-…`, which AWS Blocks guarantees for an app that
 *    sets `defaults.app`), secrets and Lambda functions by the `app` tag on the
 *    resource. It also denies IAM, Organizations and `sts:AssumeRole`.
 * 2. **The per-app CloudFormation execution policy** — attached to the app's own
 *    CDK bootstrap execution role (`cdk bootstrap --qualifier <q>
 *    --cloudformation-execution-policies <arn>`). It can only create roles that
 *    carry the boundary, are named `<id>-…` and are tagged `app=<id>`, can never
 *    remove the boundary, edit it, or re-tag a role, and can manage only the
 *    resource types the app's templates use, each scoped to the app's names or
 *    its `app` tag. Resource types it has no scoped rule for are listed in
 *    `unscoped` for the platform team to add by hand.
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
	/** The app's CDK bootstrap qualifier (default: the app id, truncated to 10 characters). */
	qualifier?: string;
	/** The AWS partition (default `aws`). */
	partition?: string;
}

/** An IAM policy document. */
export interface PolicyDocument {
	Version: '2012-10-17';
	Statement: Record<string, unknown>[];
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: an IAM policy variable, resolved by IAM at request time
const APP = '${aws:PrincipalTag/app}';
const DEFAULT_BOUNDARY = 'apps-boundary';

/** The resource-tag condition "the resource belongs to the calling role's app". */
const notThisAppsResource = { StringNotEquals: { 'aws:ResourceTag/app': APP } };

/**
 * The shared permissions boundary (see the module doc). One document for every
 * app in the account: it reads the calling role's `app` tag at request time.
 */
export function generateBoundaryPolicy(options: IamPolicyOptions = {}): PolicyDocument {
	const p = options.partition ?? 'aws';
	return {
		Version: '2012-10-17',
		Statement: [
			// A boundary only removes: this allows everything the role's own policies
			// grant, and the Deny statements below carve other apps out. Narrow it to the
			// services the platform's apps use.
			{ Sid: 'Ceiling', Effect: 'Allow', Action: '*', Resource: '*' },
			{
				Sid: 'OnlyOwnAppParameters',
				Effect: 'Deny',
				Action: 'ssm:*',
				NotResource: [
					`arn:${p}:ssm:*:*:parameter/${APP}`,
					`arn:${p}:ssm:*:*:parameter/${APP}-*`,
					`arn:${p}:ssm:*:*:parameter/${APP}/*`,
					// Cross-region references Hosting creates (`/cdk/exports/<consumer stack>/…`).
					`arn:${p}:ssm:*:*:parameter/cdk/exports/${APP}*`,
				],
			},
			{
				Sid: 'OnlyOwnAppTables',
				Effect: 'Deny',
				Action: 'dynamodb:*',
				NotResource: [`arn:${p}:dynamodb:*:*:table/${APP}-*`, `arn:${p}:dynamodb:*:*:table/${APP}-*/*`],
			},
			{ Sid: 'OnlyOwnAppQueues', Effect: 'Deny', Action: 'sqs:*', NotResource: `arn:${p}:sqs:*:*:${APP}-*` },
			{
				Sid: 'OnlyOwnAppBuckets',
				Effect: 'Deny',
				Action: 's3:*',
				NotResource: [
					`arn:${p}:s3:::${APP}-*`,
					`arn:${p}:s3:::${APP}-*/*`,
					// CDK asset buckets: BucketDeployment reads the app's assets from them.
					`arn:${p}:s3:::cdk-*-assets-*`,
					`arn:${p}:s3:::cdk-*-assets-*/*`,
				],
			},
			{
				Sid: 'ReadOnlyCdkAssets',
				Effect: 'Deny',
				Action: ['s3:Put*', 's3:Delete*', 's3:Restore*', 's3:Replicate*'],
				Resource: [`arn:${p}:s3:::cdk-*-assets-*`, `arn:${p}:s3:::cdk-*-assets-*/*`],
			},
			{ Sid: 'OnlyOwnAppSecrets', Effect: 'Deny', Action: 'secretsmanager:*', Resource: '*', Condition: notThisAppsResource },
			{
				Sid: 'OnlyOwnAppFunctions',
				Effect: 'Deny',
				Action: ['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl', 'lambda:InvokeAsync'],
				Resource: '*',
				Condition: notThisAppsResource,
			},
			{
				Sid: 'UntaggedRolesReachNoAppData',
				Effect: 'Deny',
				Action: ['ssm:*', 'dynamodb:*', 'sqs:*', 's3:*', 'secretsmanager:*', 'lambda:Invoke*'],
				Resource: '*',
				Condition: { Null: { 'aws:PrincipalTag/app': 'true' } },
			},
			{
				Sid: 'NoIamFromApps',
				Effect: 'Deny',
				Action: ['iam:*', 'organizations:*', 'account:*', 'sts:AssumeRole'],
				Resource: '*',
			},
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
		byName('Layers', ['lambda:PublishLayerVersion', 'lambda:DeleteLayerVersion', 'lambda:GetLayerVersion'], [
			`arn:${p}:lambda:*:${acct}:layer:*`,
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
	const qualifier = options.qualifier ?? id.slice(0, 10);
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
