// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BuildingBlockScope } from '@aws-cdk-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';
import { CLUSTER_ENV } from '../constants.js';
import type { DataApiOptions } from '../types.js';
import {
	FunctionsWaitForMigrations,
	hashMigrations,
	migrationProvider,
	migrationResource,
	migrationsAsset,
} from './cluster-infra.js';

/**
 * Where the migration function finds the database, and how a principal gets to read it. `properties` go to the
 * custom resource: the name or the ARN of the place that holds the connection string, or the coordinates of the
 * RDS Data API. Never a credential: properties are in the template and in the function's log.
 */
export interface ConnectionStore {
	properties: Record<string, unknown>;
	grantRead(grantee: iam.IGrantable): void;
}

const granting =
	(statements: iam.PolicyStatement[]) =>
	(grantee: iam.IGrantable): void => {
		for (const statement of statements) grantee.grantPrincipal.addToPrincipalPolicy(statement);
	};

const readsSecret = (secretArn: string): iam.PolicyStatement =>
	new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [secretArn] });

/** The SSM SecureString `parameterName`: that one parameter, and nothing else. */
export const ssmStore = (stack: cdk.Stack, parameterName: string): ConnectionStore => ({
	properties: { connectionParameter: parameterName },
	grantRead: granting([
		new iam.PolicyStatement({
			actions: ['ssm:GetParameter'],
			resources: [
				stack.formatArn({
					service: 'ssm',
					resource: 'parameter',
					resourceName: parameterName.replace(/^\//, ''),
				}),
			],
		}),
		// A SecureString under the default aws/ssm key; the condition keeps the wildcard to calls SSM makes.
		new iam.PolicyStatement({
			actions: ['kms:Decrypt'],
			resources: ['*'],
			conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
		}),
	]),
});

/** A Secrets Manager secret that holds the connection string: that one secret. */
export const secretStore = (secretArn: string): ConnectionStore => ({
	properties: { connectionSecretArn: secretArn },
	grantRead: granting([readsSecret(secretArn)]),
});

/** The calls of the RDS Data API that a statement or a transaction makes. */
const DATA_API_ACTIONS = [
	'rds-data:ExecuteStatement',
	'rds-data:BeginTransaction',
	'rds-data:CommitTransaction',
	'rds-data:RollbackTransaction',
];

/**
 * A database behind the RDS Data API: the calls on that one cluster and the read of that one secret. `grantRead`
 * takes the place of that grant when the secret needs more than its ARN names, such as a key of its own.
 */
export const dataApiStore = (dataApi: DataApiOptions, grantRead?: ConnectionStore['grantRead']): ConnectionStore => ({
	properties: { dataApi },
	grantRead:
		grantRead ??
		granting([
			new iam.PolicyStatement({ actions: DATA_API_ACTIONS, resources: [dataApi.clusterArn] }),
			readsSecret(dataApi.secretArn),
		]),
});

interface ExternalMigrationsProps {
	/** The `Database` block; the functions and the custom resource are its children. */
	owner: BuildingBlockScope;
	fullId: string;
	schemaName: string;
	migrations: Record<string, string>;
	ca?: string;
	store: ConnectionStore;
	/** What the first run waits for: the cluster, when this stack declares it (a `LegacyDatabaseCluster`). */
	dependsOn?: IConstruct;
}

/**
 * The deploy-time migrations of a block on an existing database: the same handler the provisioned kinds use,
 * outside any VPC, with read access to the database's store and to the migration files. The functions reach the
 * database the way the app does.
 */
export function externalMigrations(props: ExternalMigrationsProps): void {
	const { owner, store } = props;
	const stack = cdk.Stack.of(owner);
	const { functions, provider } = migrationProvider(owner, { [CLUSTER_ENV.kind]: 'external' });

	// The files and the certificate authority travel as one asset: both are public text, and a certificate
	// bundle can be larger than a custom resource property should be.
	const asset = migrationsAsset(owner, { files: props.migrations, ...(props.ca ? { ca: props.ca } : {}) });
	for (const fn of functions) {
		asset.grantRead(fn);
		store.grantRead(fn);
	}

	const cfn = migrationResource(owner, provider, {
		migrationsHash: hashMigrations({ ...props.migrations, ...(props.ca ? { '\u0000ca': props.ca } : {}) }),
		migrationsBucket: asset.s3BucketName,
		migrationsKey: asset.s3ObjectKey,
		schemaName: props.schemaName,
		blockFullId: props.fullId,
		...store.properties,
	});
	if (props.dependsOn) cfn.node.addDependency(props.dependsOn);
	// New code must not run against the old schema: every function on the app's role waits for this resource.
	cdk.Aspects.of(stack).add(new FunctionsWaitForMigrations(stack, owner.executionRole, () => cfn));
}
