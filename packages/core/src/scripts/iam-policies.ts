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
 *    resource's `app` tag, keyed on `${aws:PrincipalTag/app}` — plus Hosting's
 *    `secret()` / `config()` values under `blocks/<id>/` (the app's `stackId` is
 *    its id), metadata reads of AWS-owned Bedrock models and system inference
 *    profiles, and the few actions that only take `*` (X-Ray, metrics, VPC
 *    network interfaces). A service nobody wrote a rule for is denied by default.
 *    IAM, Organizations and STS role assumption are never allowed. `execute-api`
 *    can't be scoped by name or tag, so an app that calls its own APIs through it
 *    (Realtime, Agent streaming) gets a **per-app** boundary listing exactly those
 *    API ids (`executeApiIds`); {@link callsExecuteApi} finds such apps.
 * 2. **The per-app CloudFormation execution policy** — attached to the app's own
 *    CDK bootstrap execution role (`cdk bootstrap --qualifier <id>
 *    --cloudformation-execution-policies <arn>`). It can only create roles that
 *    carry the boundary, are named `<id>-…` and are tagged `app=<id>`, can never
 *    remove the boundary, edit it, re-tag a role or attach a broad AWS managed
 *    policy, and can manage only the resource types the app's templates use, each
 *    scoped to the app's names or its `app` tag, plus the service-linked roles
 *    those types need. Every rule names the exact types it handles: a type no
 *    rule names is listed in `unscoped` (with a reason when it's left out on
 *    purpose, {@link UNSCOPED_REASONS}), and the few types the service can't scope
 *    at all (CloudFront's origin access controls and cache, origin-request and
 *    response-headers policies) are granted in a statement named
 *    `CloudFrontUnscopableConfig` and listed in `accepted`.
 * 3. **The deploy guard** — attached to the app's CDK bootstrap **deploy** role.
 *    CDK's default deploy role may change and delete *any* stack, and
 *    CloudFormation reuses a stack's existing service role when an update omits
 *    one, so without this an app's pipeline could deploy into — or delete —
 *    another app's stack as that app's execution role. The guard confines the
 *    deploy role to the app's own stacks and to its own execution role (a
 *    `DeleteStack` of the app's own stack may omit the role).
 *
 * The app's bootstrap qualifier is the app id itself (an app id is at most 10
 * characters, CDK's qualifier limit), so every app has its own bootstrap and no
 * two apps can share one.
 *
 * The generator only writes JSON; it never calls AWS.
 */

import { appIdProblem } from '../cdk/app-isolation-rules.js';

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
	/**
	 * The ids of the app's own API Gateway APIs, once deployed. When given,
	 * {@link generateExecutionPolicy} pins API Gateway management to exactly these
	 * APIs (and their children) instead of relying on the APIs' `app` tag alone.
	 */
	apiIds?: string[];
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
				// Lambda@Edge ARNs CDK publishes for Hosting (`/cdk/EdgeFunctionArn/<region>/<stack path>/…`).
				...named('ssm', `*:*:parameter/cdk/EdgeFunctionArn/*/${APP}/*`),
				// Hosting `config()` values (`/blocks/<stackId>/config/…`; `stackId` is the app id under `defaults.app`).
				...named('ssm', `*:*:parameter/blocks/${APP}/*`),
			]),
			// Hosting `secret()` values (`blocks/<stackId>/secrets/…`), which the CLI creates untagged.
			allow('OwnHostingSecrets', 'secretsmanager:*', named('secretsmanager', `*:*:secret:blocks/${APP}/*`)),
			allow('OwnTables', 'dynamodb:*', named('dynamodb', `*:*:table/${APP}-*`, `*:*:table/${APP}-*/*`)),
			allow('OwnQueues', 'sqs:*', named('sqs', `*:*:${APP}-*`)),
			allow('OwnBuckets', 's3:*', [`arn:${p}:s3:::${APP}-*`, `arn:${p}:s3:::${APP}-*/*`]),
			// BucketDeployment reads the app's assets from its own bootstrap's asset bucket (qualifier = app id).
			allow('ReadOwnCdkAssets', ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:GetBucketLocation'], [
				`arn:${p}:s3:::cdk-${APP}-assets-*`,
				`arn:${p}:s3:::cdk-${APP}-assets-*/*`,
			]),
			allow('OwnFunctions', 'lambda:*', named('lambda', `*:*:function:${APP}-*`)),
			allow(
				'OwnLogs',
				'logs:*',
				named(
					'logs',
					`*:*:log-group:${APP}-*`,
					`*:*:log-group:/aws/lambda/${APP}-*`,
					// A Database's cluster logs (CloudFormation names the cluster `<stack>-…`, lower-cased).
					`*:*:log-group:/aws/rds/cluster/${APP}-*`,
				),
			),
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
			// AgentCore issues workload access tokens against the account-wide `default`
			// directory and the runtime's workload identity: both resources are checked, so
			// the untagged directory is allowed here and the identity stays tag-scoped
			// (`OwnTaggedResources`) — another app's identity is still denied.
			allow(
				'AgentCoreDefaultDirectory',
				[
					'bedrock-agentcore:GetWorkloadAccessToken',
					'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
					'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
				],
				`arn:${p}:bedrock-agentcore:*:*:workload-identity-directory/default`,
			),
			// AWS-owned foundation models and system-defined (cross-region) inference
			// profiles carry no tag: read their metadata. An application inference profile
			// is a separate resource type (`application-inference-profile/…`), not matched here.
			allow(
				'AwsOwnedModelsRead',
				['bedrock:GetFoundationModel', 'bedrock:GetInferenceProfile'],
				[`arn:${p}:bedrock:*::foundation-model/*`, `arn:${p}:bedrock:*:*:inference-profile/*`],
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
					'bedrock:ListFoundationModels',
					'bedrock:ListInferenceProfiles',
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
type Rule = (ctx: { id: string; p: string; acct: string; apiIds?: string[] }) => Record<string, unknown>[];

const byName = (sid: string, action: string | string[], resources: string[]): Record<string, unknown> => ({
	Sid: sid,
	Effect: 'Allow',
	Action: action,
	Resource: resources,
});

/** One tag-scoped service rule: what creates, what manages, and how tags are written. */
interface TaggedService {
	/** The service prefix, e.g. `secretsmanager`. */
	service: string;
	/** Actions that create a top-level resource, and the ARNs they act on (collections, not children). */
	create: { actions: string[]; resources: string[] };
	/** Actions on existing resources (children included), and the ARNs they act on. */
	manage: { actions: string[]; resources: string[] };
	/** Actions that add / remove tags. */
	tag: { add: string[]; remove: string[] };
}

/**
 * Statements for a service whose resources are named by id, scoped by the `app`
 * tag. A request tag alone is never trusted for an existing resource:
 * - **Create** only top-level resources, and only tagged `app=<id>`;
 * - **Manage** only resources (and their children, which inherit the tag) already
 *   tagged `app=<id>` — tag writes included, so an untagged resource can't be claimed;
 * - **Deny** anything on a resource tagged as another app, and any tag write that
 *   sets `app` to another value or removes it.
 */
const byTag = (sid: string, id: string, t: TaggedService): Record<string, unknown>[] => [
	{
		Sid: `${sid}Create`,
		Effect: 'Allow',
		Action: t.create.actions,
		Resource: t.create.resources,
		Condition: { StringEquals: { 'aws:RequestTag/app': id } },
	},
	{
		Sid: `${sid}Manage`,
		Effect: 'Allow',
		Action: [...t.manage.actions, ...t.tag.add, ...t.tag.remove],
		Resource: t.manage.resources,
		Condition: { StringEquals: { 'aws:ResourceTag/app': id } },
	},
	{
		Sid: `${sid}NotAnotherApps`,
		Effect: 'Deny',
		Action: `${t.service}:*`,
		Resource: '*',
		Condition: { StringNotEquals: { 'aws:ResourceTag/app': id }, Null: { 'aws:ResourceTag/app': 'false' } },
	},
	{
		Sid: `${sid}NoRetagging`,
		Effect: 'Deny',
		Action: t.tag.add,
		Resource: '*',
		Condition: { StringNotEquals: { 'aws:RequestTag/app': id }, 'ForAnyValue:StringEquals': { 'aws:TagKeys': ['app'] } },
	},
	{
		Sid: `${sid}NoUntagging`,
		Effect: 'Deny',
		Action: t.tag.remove,
		Resource: '*',
		Condition: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': ['app'] } },
	},
];

/**
 * One execution-policy rule: the CloudFormation resource types it handles —
 * **exactly**, so a type no rule names is reported in `unscoped` instead of being
 * silently assumed covered — and the statements those types need.
 */
interface RuleDef {
	/** The resource types this rule handles (anchored). */
	types: RegExp;
	statements: Rule;
	/**
	 * The rule grants these types on `*`-like ARNs because the service can't scope
	 * them by name or tag: a documented, accepted exception, reported in `accepted`.
	 */
	accepted?: true;
	/** Service-linked roles CloudFormation creates for these types (`iam:AWSServiceName`). */
	serviceLinkedRoles?: string[];
	/**
	 * The rule manages an existing resource of these types only once it is tagged
	 * `app=<id>`: reported in `tagScoped`, because a resource created before the app
	 * set `defaults.app` must be tagged by an admin first.
	 */
	tagScoped?: true;
}

/** `ec2:Describe*` takes only `*`; shared by the rules that need it (emitted once). */
const ec2Describe = byName('Ec2Describe', 'ec2:Describe*', ['*']);

const RULES: Record<string, RuleDef> = {
	Lambda: {
		types: /^AWS::Lambda::(Function|Permission|Version|Alias|LayerVersion|LayerVersionPermission|EventSourceMapping|EventInvokeConfig|Url)$/,
		statements: ({ id, p, acct }) => [
			byName('Functions', 'lambda:*', [`arn:${p}:lambda:*:${acct}:function:${id}-*`]),
			// AWS Blocks names every layer in an app's stack `<id>-…` under `defaults.app`.
			byName('Layers', ['lambda:PublishLayerVersion', 'lambda:DeleteLayerVersion', 'lambda:GetLayerVersion'], [
				`arn:${p}:lambda:*:${acct}:layer:${id}-*`,
				`arn:${p}:lambda:*:${acct}:layer:${id}-*:*`,
			]),
			// Read-only, account-level (CloudFormation reads it while creating functions).
			byName('LambdaAccountSettings', 'lambda:GetAccountSettings', ['*']),
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
			// An event source mapping is named by id: its tags are written on create
			// (tagged as the app) and managed only once it is tagged as the app.
			{
				Sid: 'EventSourceMappingTagsOnCreate',
				Effect: 'Allow',
				Action: 'lambda:TagResource',
				Resource: `arn:${p}:lambda:*:${acct}:event-source-mapping:*`,
				Condition: { StringEquals: { 'aws:RequestTag/app': id } },
			},
			{
				Sid: 'EventSourceMappingTags',
				Effect: 'Allow',
				Action: ['lambda:TagResource', 'lambda:UntagResource', 'lambda:ListTags'],
				Resource: `arn:${p}:lambda:*:${acct}:event-source-mapping:*`,
				Condition: { StringEquals: { 'aws:ResourceTag/app': id }, StringEqualsIfExists: { 'aws:RequestTag/app': id } },
			},
		],
	},
	Logs: {
		types: /^AWS::Logs::(LogGroup|LogStream|SubscriptionFilter|MetricFilter)$|^Custom::LogRetention$/,
		statements: ({ id, p, acct }) => [
			byName('LogGroups', 'logs:*', [
				`arn:${p}:logs:*:${acct}:log-group:${id}-*`,
				`arn:${p}:logs:*:${acct}:log-group:/aws/lambda/${id}-*`,
				`arn:${p}:logs:*:${acct}:log-group:/aws/rds/cluster/${id}-*`,
			]),
			byName('DescribeLogGroups', 'logs:DescribeLogGroups', ['*']),
		],
	},
	DynamoDB: {
		types: /^AWS::DynamoDB::(Table|GlobalTable)$/,
		statements: ({ id, p, acct }) => [
			byName('Tables', 'dynamodb:*', [
				`arn:${p}:dynamodb:*:${acct}:table/${id}-*`,
				`arn:${p}:dynamodb:*:${acct}:table/${id}-*/*`,
			]),
		],
	},
	SQS: {
		types: /^AWS::SQS::(Queue|QueuePolicy)$/,
		statements: ({ id, p, acct }) => [byName('Queues', 'sqs:*', [`arn:${p}:sqs:*:${acct}:${id}-*`])],
	},
	S3: {
		types: /^AWS::S3::(Bucket|BucketPolicy)$/,
		statements: ({ id, p }) => [byName('Buckets', 's3:*', [`arn:${p}:s3:::${id}-*`, `arn:${p}:s3:::${id}-*/*`])],
	},
	SSM: {
		types: /^AWS::SSM::Parameter$/,
		statements: ({ id, p, acct }) => [
			byName('Parameters', 'ssm:*', [
				`arn:${p}:ssm:*:${acct}:parameter/${id}`,
				`arn:${p}:ssm:*:${acct}:parameter/${id}-*`,
				`arn:${p}:ssm:*:${acct}:parameter/${id}/*`,
				// The Lambda@Edge ARN CDK publishes for Hosting's edge stack (`<region>/<stack path>/…`).
				`arn:${p}:ssm:*:${acct}:parameter/cdk/EdgeFunctionArn/*/${id}/*`,
			]),
		],
	},
	// CloudFormation resolves a cross-region reference (`{{resolve:ssm:/cdk/exports/<consumer stack>/…}}`)
	// as the execution role; the parameters are named after the app's own stacks.
	CrossRegionReferences: {
		types: /^Custom::CrossRegion(ExportReader|ExportWriter|StringParameterReader)$/,
		statements: ({ id, p, acct }) => [
			byName('CrossRegionExports', ['ssm:GetParameter', 'ssm:GetParameters'], [
				`arn:${p}:ssm:*:${acct}:parameter/cdk/exports/${id}`,
				`arn:${p}:ssm:*:${acct}:parameter/cdk/exports/${id}-*`,
				`arn:${p}:ssm:*:${acct}:parameter/cdk/exports/${id}/*`,
			]),
		],
	},
	SecretsManager: {
		tagScoped: true,
		types: /^AWS::SecretsManager::(Secret|SecretTargetAttachment|ResourcePolicy|RotationSchedule)$/,
		statements: ({ id, p, acct }) => [
			...byTag('Secrets', id, {
				service: 'secretsmanager',
				create: { actions: ['secretsmanager:CreateSecret'], resources: ['*'] },
				manage: { actions: ['secretsmanager:*'], resources: [`arn:${p}:secretsmanager:*:${acct}:secret:*`] },
				tag: { add: ['secretsmanager:TagResource'], remove: ['secretsmanager:UntagResource'] },
			}),
			// A generated secret value (`GenerateSecretString`); the action takes only `*` and reads nothing.
			byName('SecretsRandomPassword', 'secretsmanager:GetRandomPassword', ['*']),
		],
	},
	// REST (`AWS::ApiGateway::*`) and HTTP/WebSocket (`AWS::ApiGatewayV2::*`) APIs and
	// their children: API ids aren't names, so these are scoped by the `app` tag.
	// Account-level types (`AWS::ApiGateway::Account`, domain names, usage plans) aren't
	// per-app and are left to `unscoped`.
	ApiGateway: {
		tagScoped: true,
		types:
			/^AWS::ApiGateway::(RestApi|Deployment|Stage|Resource|Method|Authorizer|Model|RequestValidator|GatewayResponse|DocumentationPart|DocumentationVersion)$|^AWS::ApiGatewayV2::(Api|Integration|IntegrationResponse|Route|RouteResponse|Stage|Authorizer|Deployment|Model)$/,
		statements: ({ id, p, apiIds }) => [
			...byTag('Apis', id, {
				service: 'apigateway',
				// Only the API collections: a stage, deployment or route is a child of an API,
				// so it's created under Manage, against the API's (inherited) tag.
				create: {
					actions: ['apigateway:POST', 'apigateway:TagResource'],
					resources: [`arn:${p}:apigateway:*::/restapis`, `arn:${p}:apigateway:*::/apis`],
				},
				manage: {
					actions: [
						'apigateway:GET',
						'apigateway:POST',
						'apigateway:PUT',
						'apigateway:PATCH',
						'apigateway:DELETE',
						'apigateway:UpdateRestApiPolicy',
					],
					// Pinned to the app's own API ids once known (`--api-id`); before the
					// first deploy, children are authorized against their API's `app` tag.
					resources:
						apiIds && apiIds.length > 0
							? apiIds.flatMap((api) => [
									`arn:${p}:apigateway:*::/restapis/${api}`,
									`arn:${p}:apigateway:*::/restapis/${api}/*`,
									`arn:${p}:apigateway:*::/apis/${api}`,
									`arn:${p}:apigateway:*::/apis/${api}/*`,
									`arn:${p}:apigateway:*::/tags/*${api}*`,
								])
							: [`arn:${p}:apigateway:*::/restapis/*`, `arn:${p}:apigateway:*::/apis/*`, `arn:${p}:apigateway:*::/tags/*`],
				},
				tag: { add: ['apigateway:TagResource', 'apigateway:PUT'], remove: ['apigateway:UntagResource', 'apigateway:DELETE'] },
			}),
			// Creating a REST API with a resource policy checks UpdateRestApiPolicy on the
			// `/restapis` collection, which carries no request tag: the collection only
			// (an existing API's policy is under Manage, against its tag or pinned id).
			byName('ApisPolicyOnCreate', 'apigateway:UpdateRestApiPolicy', [`arn:${p}:apigateway:*::/restapis`]),
		],
	},
	Scheduler: {
		types: /^AWS::Scheduler::Schedule$/,
		statements: ({ id, p, acct }) => [
			byName('Schedules', 'scheduler:*', [`arn:${p}:scheduler:*:${acct}:schedule/*/${id}-*`]),
		],
	},
	Events: {
		types: /^AWS::Events::Rule$/,
		statements: ({ id, p, acct }) => [byName('Rules', 'events:*', [`arn:${p}:events:*:${acct}:rule/${id}-*`])],
	},
	Cognito: {
		tagScoped: true,
		types: /^AWS::Cognito::UserPool(Client|Group|Domain|User|UserToGroupAttachment|IdentityProvider|ResourceServer|RiskConfigurationAttachment|UICustomizationAttachment)?$/,
		statements: ({ id, p, acct }) =>
			byTag('UserPools', id, {
				service: 'cognito-idp',
				create: { actions: ['cognito-idp:CreateUserPool'], resources: ['*'] },
				manage: { actions: ['cognito-idp:*'], resources: [`arn:${p}:cognito-idp:*:${acct}:userpool/*`] },
				tag: { add: ['cognito-idp:TagResource'], remove: ['cognito-idp:UntagResource'] },
			}),
	},
	KMS: {
		tagScoped: true,
		types: /^AWS::KMS::(Key|Alias)$/,
		statements: ({ id, p, acct }) => [
			...byTag('Keys', id, {
				service: 'kms',
				create: { actions: ['kms:CreateKey'], resources: ['*'] },
				manage: { actions: ['kms:*'], resources: [`arn:${p}:kms:*:${acct}:key/*`] },
				tag: { add: ['kms:TagResource'], remove: ['kms:UntagResource'] },
			}),
			byName('KeyAliases', ['kms:CreateAlias', 'kms:DeleteAlias', 'kms:UpdateAlias'], [`arn:${p}:kms:*:${acct}:alias/${id}-*`]),
		],
	},
	StepFunctions: {
		tagScoped: true,
		types: /^AWS::StepFunctions::StateMachine$/,
		statements: ({ id, p, acct }) =>
			byTag('StateMachines', id, {
				service: 'states',
				create: { actions: ['states:CreateStateMachine'], resources: ['*'] },
				manage: {
					actions: ['states:*'],
					resources: [`arn:${p}:states:*:${acct}:stateMachine:*`, `arn:${p}:states:*:${acct}:execution:*`],
				},
				tag: { add: ['states:TagResource'], remove: ['states:UntagResource'] },
			}),
	},
	ResourceGroups: {
		types: /^AWS::ResourceGroups::Group$/,
		statements: ({ id, p, acct }) => [
			byName('ResourceGroups', 'resource-groups:*', [`arn:${p}:resource-groups:*:${acct}:group/${id}-*`]),
			byName('ResourceGroupsStackQuery', ['cloudformation:DescribeStacks', 'cloudformation:ListStackResources', 'tag:GetResources'], ['*']),
		],
	},
	Dashboards: {
		types: /^AWS::CloudWatch::Dashboard$/,
		statements: ({ id, p, acct }) => [
			byName('Dashboards', ['cloudwatch:PutDashboard', 'cloudwatch:GetDashboard', 'cloudwatch:DeleteDashboards'], [
				`arn:${p}:cloudwatch::${acct}:dashboard/${id}-*`,
			]),
		],
	},
	// CloudFormation names an alarm `<stack>-<logical id>-…`.
	Alarms: {
		types: /^AWS::CloudWatch::Alarm$/,
		statements: ({ id, p, acct }) => [
			byName(
				'Alarms',
				[
					'cloudwatch:PutMetricAlarm',
					'cloudwatch:DescribeAlarms',
					'cloudwatch:DeleteAlarms',
					'cloudwatch:TagResource',
					'cloudwatch:UntagResource',
					'cloudwatch:ListTagsForResource',
				],
				[`arn:${p}:cloudwatch:*:${acct}:alarm:${id}-*`],
			),
		],
	},
	// CloudFormation names a topic `<stack>-<logical id>-…`; subscriptions are the topic's children.
	SNS: {
		types: /^AWS::SNS::(Topic|TopicPolicy|Subscription)$/,
		statements: ({ id, p, acct }) => [byName('Topics', 'sns:*', [`arn:${p}:sns:*:${acct}:${id}-*`])],
	},
	// The policies AWS Blocks splits a large role policy into (`BlocksRoleOverflowPolicy*`):
	// CloudFormation names them `<stack>-<logical id>-…`. They can be attached only to the
	// app's own roles (`RolesOnlyWithTheBoundary`); the boundary policy itself stays denied
	// (`NoEditingTheBoundary`).
	ManagedPolicies: {
		types: /^AWS::IAM::ManagedPolicy$/,
		statements: ({ id, p, acct }) => [
			byName(
				'ManagedPolicies',
				[
					'iam:CreatePolicy',
					'iam:DeletePolicy',
					'iam:GetPolicy',
					'iam:GetPolicyVersion',
					'iam:CreatePolicyVersion',
					'iam:DeletePolicyVersion',
					'iam:ListPolicyVersions',
					'iam:ListEntitiesForPolicy',
					'iam:TagPolicy',
					'iam:UntagPolicy',
					'iam:ListPolicyTags',
				],
				[`arn:${p}:iam::${acct}:policy/${id}-*`],
			),
		],
	},
	S3Vectors: {
		types: /^AWS::S3Vectors::(VectorBucket|Index|VectorBucketPolicy)$/,
		statements: ({ id, p, acct }) => [
			byName('VectorBuckets', 's3vectors:*', [
				`arn:${p}:s3vectors:*:${acct}:bucket/${id}-*`,
				`arn:${p}:s3vectors:*:${acct}:bucket/${id}-*/index/*`,
			]),
		],
	},
	DSQL: {
		tagScoped: true,
		types: /^AWS::DSQL::Cluster$/,
		serviceLinkedRoles: ['dsql.amazonaws.com'],
		statements: ({ id, p, acct }) =>
			byTag('DsqlClusters', id, {
				service: 'dsql',
				create: { actions: ['dsql:CreateCluster', 'dsql:TagResource'], resources: [`arn:${p}:dsql:*:${acct}:cluster/*`] },
				manage: { actions: ['dsql:*'], resources: [`arn:${p}:dsql:*:${acct}:cluster/*`] },
				tag: { add: ['dsql:TagResource'], remove: ['dsql:UntagResource'] },
			}),
	},
	// A data source is authorized against its knowledge base (there's no data-source resource type).
	KnowledgeBases: {
		tagScoped: true,
		types: /^AWS::Bedrock::(KnowledgeBase|DataSource)$/,
		statements: ({ id, p, acct }) =>
			byTag('KnowledgeBases', id, {
				service: 'bedrock',
				create: { actions: ['bedrock:CreateKnowledgeBase', 'bedrock:TagResource'], resources: ['*'] },
				manage: { actions: ['bedrock:*'], resources: [`arn:${p}:bedrock:*:${acct}:knowledge-base/*`] },
				tag: { add: ['bedrock:TagResource'], remove: ['bedrock:UntagResource'] },
			}),
	},
	// RDS names: CloudFormation generates `<stack>-<logical id>-…` (lower-cased) for
	// clusters, instances and subnet groups. A cluster or instance created with RDS's
	// `default…` parameter and option groups is checked against them too.
	RDS: {
		types: /^AWS::RDS::(DBCluster|DBInstance|DBSubnetGroup|DBClusterParameterGroup|DBParameterGroup|OptionGroup)$/,
		serviceLinkedRoles: ['rds.amazonaws.com'],
		statements: ({ id, p, acct }) => [
			byName('RdsResources', 'rds:*', [
				`arn:${p}:rds:*:${acct}:cluster:${id}-*`,
				`arn:${p}:rds:*:${acct}:db:${id}-*`,
				`arn:${p}:rds:*:${acct}:subgrp:${id}-*`,
				`arn:${p}:rds:*:${acct}:cluster-pg:${id}-*`,
				`arn:${p}:rds:*:${acct}:pg:${id}-*`,
				`arn:${p}:rds:*:${acct}:og:${id}-*`,
				`arn:${p}:rds:*:${acct}:cluster-snapshot:${id}-*`,
				`arn:${p}:rds:*:${acct}:snapshot:${id}-*`,
			]),
			byName(
				'RdsDefaultGroups',
				['rds:CreateDBCluster', 'rds:CreateDBInstance', 'rds:ModifyDBCluster', 'rds:ModifyDBInstance'],
				[`arn:${p}:rds:*:${acct}:cluster-pg:default*`, `arn:${p}:rds:*:${acct}:pg:default*`, `arn:${p}:rds:*:${acct}:og:default*`],
			),
			ec2Describe,
		],
	},
	// VPC resources are named by id: created only tagged as the app, managed only
	// once tagged as the app. Creating a subnet, route table or security group also
	// checks the VPC it goes into, which must be the app's own.
	EC2: {
		tagScoped: true,
		types:
			/^AWS::EC2::(VPC|Subnet|RouteTable|Route|SubnetRouteTableAssociation|SecurityGroup|SecurityGroupIngress|SecurityGroupEgress|InternetGateway|VPCGatewayAttachment|NatGateway|EIP)$/,
		statements: ({ id, p, acct }) => {
			const ec2 = (type: string) => `arn:${p}:ec2:*:${acct}:${type}/*`;
			return [
				...byTag('Ec2', id, {
					service: 'ec2',
					create: {
						actions: [
							'ec2:CreateVpc',
							'ec2:CreateSubnet',
							'ec2:CreateRouteTable',
							'ec2:CreateSecurityGroup',
							'ec2:CreateInternetGateway',
							'ec2:CreateNatGateway',
							'ec2:AllocateAddress',
							'ec2:CreateTags',
						],
						resources: ['vpc', 'subnet', 'route-table', 'security-group', 'internet-gateway', 'natgateway', 'elastic-ip'].map(ec2),
					},
					manage: { actions: ['ec2:*'], resources: [`arn:${p}:ec2:*:${acct}:*`] },
					tag: { add: ['ec2:CreateTags'], remove: ['ec2:DeleteTags'] },
				}),
				{
					Sid: 'Ec2CreateInOwnVpc',
					Effect: 'Allow',
					Action: ['ec2:CreateSubnet', 'ec2:CreateRouteTable', 'ec2:CreateSecurityGroup', 'ec2:AttachInternetGateway'],
					Resource: ec2('vpc'),
					Condition: { StringEquals: { 'aws:ResourceTag/app': id } },
				},
				// A security group's rules are its children; the group itself must be the app's own.
				byName(
					'Ec2SecurityGroupRules',
					['ec2:AuthorizeSecurityGroupEgress', 'ec2:AuthorizeSecurityGroupIngress'],
					[ec2('security-group-rule')],
				),
				ec2Describe,
			];
		},
	},
	// Distributions and KeyValueStores are named by id and support tag conditions.
	CloudFrontDistributions: {
		tagScoped: true,
		types: /^AWS::CloudFront::Distribution$/,
		statements: ({ id, p, acct }) =>
			byTag('CfDistributions', id, {
				service: 'cloudfront',
				create: {
					actions: ['cloudfront:CreateDistribution', 'cloudfront:CreateDistributionWithTags', 'cloudfront:TagResource'],
					resources: [`arn:${p}:cloudfront::${acct}:distribution/*`],
				},
				manage: {
					actions: [
						'cloudfront:GetDistribution',
						'cloudfront:GetDistributionConfig',
						'cloudfront:UpdateDistribution',
						'cloudfront:DeleteDistribution',
						'cloudfront:ListTagsForResource',
						'cloudfront:CreateInvalidation',
						'cloudfront:GetInvalidation',
					],
					resources: [`arn:${p}:cloudfront::${acct}:distribution/*`],
				},
				tag: { add: ['cloudfront:TagResource'], remove: ['cloudfront:UntagResource'] },
			}),
	},
	CloudFrontKeyValueStores: {
		tagScoped: true,
		types: /^AWS::CloudFront::KeyValueStore$/,
		statements: ({ id, p, acct }) => {
			const kvs = `arn:${p}:cloudfront::${acct}:key-value-store/*`;
			// Two statements, not `byTag`: its denies are on `cloudfront:*`, which the distribution rule already emits.
			return [
				{
					Sid: 'CfKeyValueStoresCreate',
					Effect: 'Allow',
					Action: ['cloudfront:CreateKeyValueStore', 'cloudfront:TagResource'],
					Resource: kvs,
					Condition: { StringEquals: { 'aws:RequestTag/app': id } },
				},
				{
					Sid: 'CfKeyValueStoresManage',
					Effect: 'Allow',
					Action: [
						'cloudfront:DescribeKeyValueStore',
						'cloudfront:UpdateKeyValueStore',
						'cloudfront:DeleteKeyValueStore',
						'cloudfront:ListTagsForResource',
						'cloudfront:TagResource',
						'cloudfront:UntagResource',
					],
					Resource: kvs,
					Condition: { StringEquals: { 'aws:ResourceTag/app': id } },
				},
			];
		},
	},
	// AWS Blocks names CloudFront Functions `<id>-<region>-…` under `defaults.app`.
	CloudFrontFunctions: {
		types: /^AWS::CloudFront::Function$/,
		statements: ({ id, p, acct }) => [
			byName(
				'CfFunctions',
				[
					'cloudfront:CreateFunction',
					'cloudfront:DescribeFunction',
					'cloudfront:GetFunction',
					'cloudfront:UpdateFunction',
					'cloudfront:PublishFunction',
					'cloudfront:DeleteFunction',
					'cloudfront:TestFunction',
					'cloudfront:TagResource',
					'cloudfront:UntagResource',
					'cloudfront:ListTagsForResource',
				],
				[`arn:${p}:cloudfront::${acct}:function/${id}-*`],
			),
		],
	},
	// Accepted exception: CloudFront's origin access controls and cache, origin-request
	// and response-headers policies are named by id and support no tag condition, so
	// they can't be scoped to one app. They hold configuration only (no data), but App A
	// could change or delete one of App B's.
	CloudFrontUnscopableConfig: {
		types: /^AWS::CloudFront::(OriginAccessControl|CachePolicy|OriginRequestPolicy|ResponseHeadersPolicy)$/,
		accepted: true,
		statements: ({ p, acct }) => [
			byName(
				'CloudFrontUnscopableConfig',
				['OriginAccessControl', 'CachePolicy', 'OriginRequestPolicy', 'ResponseHeadersPolicy'].flatMap((t) => [
					`cloudfront:Create${t}`,
					`cloudfront:Get${t}`,
					`cloudfront:Get${t}Config`,
					`cloudfront:Update${t}`,
					`cloudfront:Delete${t}`,
				]),
				['origin-access-control', 'cache-policy', 'origin-request-policy', 'response-headers-policy'].map(
					(t) => `arn:${p}:cloudfront::${acct}:${t}/*`,
				),
			),
		],
	},
};

/**
 * Types the execution policy deliberately leaves to the platform, with why — the
 * CLI prints the reason next to the type in `unscoped`.
 */
export const UNSCOPED_REASONS: Record<string, string> = {
	'AWS::BedrockAgentCore::Runtime':
		'CloudFormation creates each runtime\'s workload identity in the account-wide "default" workload-identity directory, ' +
		"which carries no app tag, and the runtime's name can't carry the app's `<id>-` prefix (no hyphens allowed), so " +
		'no statement scopes it to one app. A platform that accepts the risk adds bedrock-agentcore statements by hand.',
	'AWS::ApiGateway::Account': "an account-level setting (API Gateway's CloudWatch Logs role), shared by every app in the region.",
};

/** Types the role-fence statements already cover, or that need no permission. */
const COVERED = /^(AWS::IAM::(Role|Policy|RolePolicy)|AWS::CDK::Metadata|AWS::CloudFormation::(CustomResource|WaitCondition.*)|Custom::.*)$/;

/** The rule that handles a resource type exactly, if any. */
const ruleFor = (type: string) => Object.keys(RULES).find((k) => RULES[k].types.test(type));

/** What {@link generateExecutionPolicy} returns. */
export interface ExecutionPolicy {
	document: PolicyDocument;
	/**
	 * Resource types the app's templates use that have no scoped rule: add their
	 * statements by hand. {@link UNSCOPED_REASONS} says why for the ones left out
	 * on purpose.
	 */
	unscoped: string[];
	/**
	 * Resource types the policy grants without an app scope, because the service
	 * can't scope them by name or tag (CloudFront's origin access controls and
	 * cache, origin-request and response-headers policies): accepted, documented
	 * exceptions, in a statement whose Sid says so.
	 */
	accepted: string[];
	/**
	 * Resource types the policy manages by the `app` tag (only once a resource is
	 * tagged `app=<id>`). An existing resource of one of these types that predates
	 * `defaults.app` can't be updated (not even to add the tag) until an admin tags
	 * it `app=<id>`.
	 */
	tagScoped: string[];
}

/**
 * The per-app CloudFormation execution policy (see the module doc), for the
 * resource types in `resourceTypes` (from the app's synthesized templates).
 *
 * @throws Error when `appId` or `account` is missing, or `appId` isn't a usable app id (malformed or reserved).
 */
export function generateExecutionPolicy(resourceTypes: Iterable<string>, options: IamPolicyOptions): ExecutionPolicy {
	const { appId: id, account: acct } = options;
	if (!id) throw new Error('The execution policy needs the app id (--app).');
	const executionIdProblem = appIdProblem(id);
	if (executionIdProblem) throw new Error(`--app: ${executionIdProblem}`);
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
		byName('ReadOwnBootstrapAssets', ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:GetBucket*'], [
			`arn:${p}:s3:::cdk-${qualifier}-assets-${acct}-*`,
			`arn:${p}:s3:::cdk-${qualifier}-assets-${acct}-*/*`,
		]),
	];

	const unscoped = new Set<string>();
	const accepted = new Set<string>();
	const tagScoped = new Set<string>();
	const applied = new Set<string>();
	const serviceLinkedRoles = new Set<string>();
	const types = [...new Set(resourceTypes)].sort();
	for (const type of types) {
		const key = ruleFor(type);
		if (!key) {
			if (!COVERED.test(type)) unscoped.add(type);
			continue;
		}
		const rule = RULES[key];
		if (rule.accepted) accepted.add(type);
		if (rule.tagScoped) tagScoped.add(type);
		for (const service of rule.serviceLinkedRoles ?? []) serviceLinkedRoles.add(service);
		if (applied.has(key)) continue;
		applied.add(key);
		statements.push(...rule.statements({ id, p, acct, apiIds: options.apiIds }));
	}
	// An AgentCore runtime's identity needs its service-linked role, even while the
	// runtime itself is left to the platform (see UNSCOPED_REASONS).
	if (types.includes('AWS::BedrockAgentCore::Runtime')) serviceLinkedRoles.add('runtime-identity.bedrock-agentcore.amazonaws.com');
	if (serviceLinkedRoles.size > 0) {
		// The first deploy of a service in an account creates its service-linked role:
		// only for the services these templates use.
		statements.push({
			Sid: 'ServiceLinkedRoles',
			Effect: 'Allow',
			Action: 'iam:CreateServiceLinkedRole',
			Resource: `arn:${p}:iam::${acct}:role/aws-service-role/*`,
			Condition: { StringEquals: { 'iam:AWSServiceName': [...serviceLinkedRoles].sort() } },
		});
	}
	// Statements several rules share (e.g. `ec2:Describe*`) appear once.
	const seen = new Set<string>();
	const unique = statements.filter((st) => {
		const sid = String(st.Sid);
		if (seen.has(sid)) return false;
		seen.add(sid);
		return true;
	});
	return {
		document: { Version: '2012-10-17', Statement: unique },
		unscoped: [...unscoped].sort(),
		accepted: [...accepted].sort(),
		tagScoped: [...tagScoped].sort(),
	};
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
 * to another stack's role. Deleting one of the app's own stacks may omit the role
 * (CDK does so for a failed first deploy), but a role it names must be the app's own.
 *
 * @throws Error when `appId` or `account` is missing, or `appId` isn't a usable app id (malformed or reserved).
 */
export function generateDeployGuardPolicy(options: IamPolicyOptions): PolicyDocument {
	const { appId: id, account: acct } = options;
	if (!id) throw new Error('The deploy guard needs the app id (--app).');
	const guardIdProblem = appIdProblem(id);
	if (guardIdProblem) throw new Error(`--app: ${guardIdProblem}`);
	if (!acct || !/^\d{12}$/.test(acct)) throw new Error('The deploy guard needs the 12-digit AWS account (--account).');
	const p = options.partition ?? 'aws';
	const ownExecRole = `arn:${p}:iam::${acct}:role/cdk-${id}-cfn-exec-role-${acct}-*`;
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
				Action: ['cloudformation:CreateChangeSet', 'cloudformation:CreateStack', 'cloudformation:UpdateStack'],
				Resource: '*',
				Condition: { StringNotLike: { 'cloudformation:RoleArn': ownExecRole } },
			},
			{
				// DeleteStack may omit RoleARN: CDK deletes a failed first deploy's
				// ROLLBACK_COMPLETE stack without one. That reuses the stack's own role, which
				// is safe here: `OnlyThisAppsStacks` confines DeleteStack to the app's own
				// stacks, and those can only have been created (CreateStack / CreateChangeSet
				// above) with the app's own execution role. A RoleARN that is given must
				// still be the app's own.
				Sid: 'DeleteOnlyWithThisAppsExecutionRole',
				Effect: 'Deny',
				Action: 'cloudformation:DeleteStack',
				Resource: '*',
				Condition: { StringNotLike: { 'cloudformation:RoleArn': ownExecRole }, Null: { 'cloudformation:RoleArn': 'false' } },
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

/** A CloudFormation template, as far as {@link callsExecuteApi} reads it. */
type TemplateLike = { Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }> };

/**
 * What in a set of templates calls an API through `execute-api` — a WebSocket API
 * (Realtime; AWS Blocks' Agent streams over it) or a role granted an
 * `execute-api:` action — as one line each. The shared boundary denies every
 * `execute-api` call, so an app with any of these needs its own boundary
 * (`executeApiIds` / `--api-id`) or those calls fail at runtime.
 */
export function callsExecuteApi(templates: Iterable<TemplateLike>): string[] {
	const out = new Set<string>();
	const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
	for (const t of templates) {
		for (const [logicalId, r] of Object.entries(t.Resources ?? {})) {
			const props = r.Properties ?? {};
			if (r.Type === 'AWS::ApiGatewayV2::Api' && String(props.ProtocolType).toUpperCase() === 'WEBSOCKET') {
				out.add(`a WebSocket API (${logicalId})`);
			}
			const docs: unknown[] = [];
			if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy' || r.Type === 'AWS::IAM::RolePolicy') docs.push(props.PolicyDocument);
			if (r.Type === 'AWS::IAM::Role') for (const p of asList(props.Policies as { PolicyDocument?: unknown }[] | undefined)) docs.push(p.PolicyDocument);
			for (const doc of docs) {
				for (const st of asList((doc as { Statement?: { Effect?: string; Action?: string | string[] }[] } | undefined)?.Statement)) {
					if (st.Effect !== 'Allow') continue;
					for (const action of asList(st.Action)) if (/^execute-api:/i.test(action)) out.add(`a role granted ${action} (${logicalId})`);
				}
			}
		}
	}
	return [...out].sort();
}

/** IAM's limit on a managed policy's size, in characters excluding white space. */
export const MANAGED_POLICY_MAX_CHARS = 6144;

/**
 * The size `blocks-iam-policies` splits an execution policy at: below IAM's
 * limit, so every part keeps about 1,000 characters of room for statements a
 * platform adds by hand without needing another policy (and a re-bootstrap).
 */
export const EXECUTION_POLICY_SPLIT_CHARS = 5120;

/** A policy's size as IAM counts it (JSON without white space). */
export function policySize(doc: PolicyDocument): number {
	return JSON.stringify(doc).replace(/\s/g, '').length;
}

/**
 * Split a policy into as few documents as fit IAM's managed-policy size, keeping
 * statements whole and in order. `cdk bootstrap --cloudformation-execution-policies`
 * takes a comma-separated list, so an execution policy can span several.
 */
export function splitPolicy(doc: PolicyDocument, max = MANAGED_POLICY_MAX_CHARS): PolicyDocument[] {
	const parts: PolicyDocument[] = [];
	let current: PolicyDocument = { Version: '2012-10-17', Statement: [] };
	for (const statement of doc.Statement) {
		const next: PolicyDocument = { Version: '2012-10-17', Statement: [...current.Statement, statement] };
		if (current.Statement.length > 0 && policySize(next) > max) {
			parts.push(current);
			current = { Version: '2012-10-17', Statement: [statement] };
		} else {
			current = next;
		}
	}
	if (current.Statement.length > 0) parts.push(current);
	return parts;
}
