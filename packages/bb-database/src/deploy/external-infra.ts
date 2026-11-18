// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BuildingBlockScope, blocksNodejsBundling, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { deployTimeLambdaEntry, scopeProviderWaiterTrust } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import {
	CLUSTER_ENV,
	MIGRATION_LAMBDA_TIMEOUT_MINUTES,
	MIGRATION_POLL_INTERVAL_SECONDS,
	MIGRATION_SERVICE_TIMEOUT_SECONDS,
	MIGRATION_TOTAL_TIMEOUT_MINUTES,
} from '../constants.js';
import { FunctionsWaitForMigrations, hashMigrations } from './cluster-infra.js';

/** Where the migration function reads the connection string from: a name or an ARN, never the value. */
export type ConnectionStore = { ssmParameterName: string } | { secretArn: string };

interface ExternalMigrationsProps {
	/** The `Database` block; the functions and the custom resource are its children. */
	owner: BuildingBlockScope;
	fullId: string;
	schemaName: string;
	migrations: Record<string, string>;
	ca?: string;
	store: ConnectionStore;
}

/**
 * The deploy-time migrations of a block on an existing database: the same handler the provisioned kinds use,
 * outside any VPC, with read access to the connection string and to the migration files. There is no cluster
 * resource; the functions connect to the database the way the app does.
 */
export class ExternalMigrations {
	constructor(props: ExternalMigrationsProps) {
		const { owner, store } = props;
		const stack = cdk.Stack.of(owner);
		const logGroup = new LogGroup(owner, 'MigrationLogs', {
			retention: owner.defaults.logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});
		const migrationFunction = (id: string, handler: 'handler' | 'isComplete') =>
			new lambda.NodejsFunction(owner, id, {
				entry: deployTimeLambdaEntry({ moduleUrl: import.meta.url, source: './migration-lambda' }),
				handler,
				runtime: DEFAULT_NODE_RUNTIME,
				timeout: cdk.Duration.minutes(MIGRATION_LAMBDA_TIMEOUT_MINUTES),
				logGroup,
				environment: { [CLUSTER_ENV.kind]: 'external' },
				bundling: blocksNodejsBundling(),
			});
		const functions = [
			migrationFunction('MigrationFn', 'handler'),
			migrationFunction('MigrationIsCompleteFn', 'isComplete'),
		];

		// The files and the certificate authority travel as one asset: both are public text, and a certificate
		// bundle can be larger than a custom resource property should be.
		const dir = mkdtempSync(join(tmpdir(), 'bb-database-migrations-'));
		const path = join(dir, 'migrations.json');
		writeFileSync(path, JSON.stringify({ files: props.migrations, ...(props.ca ? { ca: props.ca } : {}) }));
		const asset = new Asset(owner, 'MigrationFiles', { path });

		for (const fn of functions) {
			asset.grantRead(fn);
			for (const statement of connectionReadStatements(stack, store)) fn.addToRolePolicy(statement);
		}

		const provider = new cr.Provider(owner, 'MigrationProvider', {
			onEventHandler: functions[0],
			isCompleteHandler: functions[1],
			queryInterval: cdk.Duration.seconds(MIGRATION_POLL_INTERVAL_SECONDS),
			totalTimeout: cdk.Duration.minutes(MIGRATION_TOTAL_TIMEOUT_MINUTES),
		});
		scopeProviderWaiterTrust(provider);

		const resource = new cdk.CustomResource(owner, 'Migrations', {
			serviceToken: provider.serviceToken,
			serviceTimeout: cdk.Duration.seconds(MIGRATION_SERVICE_TIMEOUT_SECONDS),
			properties: {
				migrationsHash: hashMigrations({ ...props.migrations, ...(props.ca ? { '\u0000ca': props.ca } : {}) }),
				migrationsBucket: asset.s3BucketName,
				migrationsKey: asset.s3ObjectKey,
				schemaName: props.schemaName,
				blockFullId: props.fullId,
				// The place, not the value: properties are in the template and in the function's log.
				...('ssmParameterName' in store
					? { connectionParameter: store.ssmParameterName }
					: { connectionSecretArn: store.secretArn }),
			},
		});
		const cfn = resource.node.defaultChild as cdk.CfnResource;
		// aws-cdk-lib renders the Duration as a string, and CloudFormation's validator warns about a non-numeric value.
		cfn.addPropertyOverride('ServiceTimeout', MIGRATION_SERVICE_TIMEOUT_SECONDS);
		// New code must not run against the old schema: every function on the app's role waits for this resource.
		cdk.Aspects.of(stack).add(new FunctionsWaitForMigrations(stack, owner.executionRole, () => cfn));
	}
}

/** What lets a role read the connection string from `store`: the one parameter or secret, and nothing else. */
export function connectionReadStatements(stack: cdk.Stack, store: ConnectionStore): iam.PolicyStatement[] {
	if ('secretArn' in store) {
		return [new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [store.secretArn] })];
	}
	return [
		new iam.PolicyStatement({
			actions: ['ssm:GetParameter'],
			resources: [
				stack.formatArn({
					service: 'ssm',
					resource: 'parameter',
					resourceName: store.ssmParameterName.replace(/^\//, ''),
				}),
			],
		}),
		// A SecureString under the default aws/ssm key; the condition keeps the wildcard to calls SSM makes.
		new iam.PolicyStatement({
			actions: ['kms:Decrypt'],
			resources: ['*'],
			conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
		}),
	];
}
