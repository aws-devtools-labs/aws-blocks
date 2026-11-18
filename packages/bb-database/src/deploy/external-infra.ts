// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BuildingBlockScope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CLUSTER_ENV } from '../constants.js';
import {
	FunctionsWaitForMigrations,
	hashMigrations,
	migrationProvider,
	migrationResource,
	migrationsAsset,
} from './cluster-infra.js';

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
export function externalMigrations(props: ExternalMigrationsProps): void {
	const { owner, store } = props;
	const stack = cdk.Stack.of(owner);
	const { functions, provider } = migrationProvider(owner, { [CLUSTER_ENV.kind]: 'external' });

	// The files and the certificate authority travel as one asset: both are public text, and a certificate
	// bundle can be larger than a custom resource property should be.
	const asset = migrationsAsset(owner, { files: props.migrations, ...(props.ca ? { ca: props.ca } : {}) });
	for (const fn of functions) {
		asset.grantRead(fn);
		for (const statement of connectionReadStatements(stack, store)) fn.addToRolePolicy(statement);
	}

	const cfn = migrationResource(owner, provider, {
		migrationsHash: hashMigrations({ ...props.migrations, ...(props.ca ? { '\u0000ca': props.ca } : {}) }),
		migrationsBucket: asset.s3BucketName,
		migrationsKey: asset.s3ObjectKey,
		schemaName: props.schemaName,
		blockFullId: props.fullId,
		// The place, not the value: properties are in the template and in the function's log.
		...('ssmParameterName' in store
			? { connectionParameter: store.ssmParameterName }
			: { connectionSecretArn: store.secretArn }),
	});
	// New code must not run against the old schema: every function on the app's role waits for this resource.
	cdk.Aspects.of(stack).add(new FunctionsWaitForMigrations(stack, owner.executionRole, () => cfn));
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
