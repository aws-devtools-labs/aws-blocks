// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// How `Database` of `@aws-blocks/bb-data` 0.5.0 turned its options into the arguments of its infrastructure
// function. FROZEN, like `aurora-infra.ts`: the same options must give the same template.

import { type BuildingBlockScope, getVpcContext, registerConfig, type VpcContext } from '@aws-cdk-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { IConstruct } from 'constructs';
import { legacyClusterConfigKey, legacyName } from '../constants.js';
import { REMOVAL_POLICY_MAP } from '../deploy/cluster-infra.js';
import { type ConnectionStore, dataApiStore } from '../deploy/external-infra.js';
import type { LegacyDatabaseClusterOptions, LegacySubnetSelection } from '../types.js';
import { DEFAULT_BACKUP_RETENTION_DAYS, materializeLegacyAurora } from './aurora-infra.js';

const SUBNET_TYPE_MAP: Record<NonNullable<LegacySubnetSelection['subnetType']>, ec2.SubnetType> = {
	isolated: ec2.SubnetType.PRIVATE_ISOLATED,
	'private-with-egress': ec2.SubnetType.PRIVATE_WITH_EGRESS,
	public: ec2.SubnetType.PUBLIC,
};

/** The VPC endpoints the earlier block asked for when the app runs in a VPC. */
export const LEGACY_VPC_REQUIREMENTS = {
	interfaceEndpoints: [
		ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
		ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
	],
};

// Only a VPC the app provides is shared; without one the cluster has a VPC of its own.
function providedVpcContext(scope: BuildingBlockScope): VpcContext | undefined {
	const ctx = getVpcContext(scope);
	return ctx?.source === 'provided' ? ctx : undefined;
}

function clusterSubnets(scope: BuildingBlockScope, sel?: LegacySubnetSelection): ec2.SubnetSelection | undefined {
	if (!sel) return undefined;
	return {
		...(sel.subnetType ? { subnetType: SUBNET_TYPE_MAP[sel.subnetType] } : {}),
		...(sel.subnetGroupName ? { subnetGroupName: sel.subnetGroupName } : {}),
		...(sel.subnetIds
			? {
					subnets: sel.subnetIds.map((sid, i) =>
						ec2.Subnet.fromSubnetId(scope, `${scope.node.id}Subnet${i}`, sid),
					),
				}
			: {}),
		...(sel.availabilityZones ? { availabilityZones: sel.availabilityZones } : {}),
		...(sel.onePerAz !== undefined ? { onePerAz: sel.onePerAz } : {}),
	};
}

// `true` or no setting is the 15-day window, `false` is Aurora's 1-day minimum, and a day count outside 1 to 35
// falls back to 15 days with a warning, as in the earlier block.
function backupRetentionDays(scope: BuildingBlockScope, options: LegacyDatabaseClusterOptions): number {
	const setting = options.pointInTimeRecovery ?? scope.defaults.pointInTimeRecovery;
	if (typeof setting === 'object' && setting !== null) {
		const days = setting.retentionDays;
		if (Number.isInteger(days) && days >= 1 && days <= 35) return days;
		cdk.Annotations.of(scope).addWarningV2(
			'@aws-cdk-blocks/bb-database:LegacyInvalidPitrDays',
			`pointInTimeRecovery.retentionDays must be an integer between 1 and 35 (got ${String(days)}). ` +
				`The cluster keeps backups for ${DEFAULT_BACKUP_RETENTION_DAYS} days.`,
		);
		return DEFAULT_BACKUP_RETENTION_DAYS;
	}
	return setting === false ? 1 : DEFAULT_BACKUP_RETENTION_DAYS;
}

export interface LegacyClusterInfra {
	/** The cluster and everything declared with it; a migration run waits for it. */
	cluster: IConstruct;
	/**
	 * Where the RDS Data API finds the database (deploy-time tokens), and the grant of the earlier block: the
	 * calls on the cluster and the read of its secret, with the secret's key.
	 */
	store: ConnectionStore;
}

/**
 * Declares the cluster of the earlier block under `owner`, whose id and scope are those of that block's
 * `Database`, so every logical id is the one in the deployed stack. Writes the three config values under the
 * keys of the earlier block and lets the app's role call the Data API.
 */
export function legacyClusterInfra(
	owner: BuildingBlockScope,
	options: LegacyDatabaseClusterOptions = {},
): LegacyClusterInfra {
	// The context key of the earlier package: an app that set it has an encrypted cluster, and must keep it.
	const ctx = owner.node.tryGetContext('@aws-blocks/bb-data:encryptStorageByDefault');
	const encryptByDefault = ctx === true || ctx === 'true';
	const hasCmk = options.storageEncryptionKeyArn !== undefined;

	const infra = materializeLegacyAurora(owner, owner.fullId, {
		minCapacity: options.minCapacity,
		maxCapacity: options.maxCapacity,
		databaseName: options.databaseName || legacyName(owner.fullId),
		removalPolicy: options.removalPolicy ? REMOVAL_POLICY_MAP[options.removalPolicy] : owner.defaults.removalPolicy,
		deletionProtection: owner.defaults.deletionProtection,
		postgresVersion: options.postgresVersion,
		storageEncrypted: encryptByDefault || hasCmk ? true : undefined,
		storageEncryptionKey: options.storageEncryptionKeyArn
			? kms.Key.fromKeyArn(owner, 'db-storage-key', options.storageEncryptionKeyArn)
			: undefined,
		backupRetention: cdk.Duration.days(backupRetentionDays(owner, options)),
		vpcContext: providedVpcContext(owner),
		clusterSubnets: clusterSubnets(owner, options.subnets),
		logRetention: owner.defaults.logRetention,
	});
	const dataApi = { clusterArn: infra.clusterArn, secretArn: infra.secretArn, database: infra.databaseName };
	registerConfig(owner, legacyClusterConfigKey(owner.fullId, 'CLUSTER_ARN'), dataApi.clusterArn);
	registerConfig(owner, legacyClusterConfigKey(owner.fullId, 'SECRET_ARN'), dataApi.secretArn);
	registerConfig(owner, legacyClusterConfigKey(owner.fullId, 'DATABASE'), dataApi.database);
	infra.grantDataApi(owner.executionRole);
	return { cluster: infra.cluster, store: dataApiStore(dataApi, infra.grantDataApi) };
}
