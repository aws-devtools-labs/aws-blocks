// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The Aurora infrastructure of `Database` in `@aws-blocks/bb-data` 0.5.0, as that release declared it. FROZEN:
// a `LegacyDatabaseCluster` must give CloudFormation the resources that the earlier block gave it, with the
// same logical ids and the same properties, so that a deploy changes nothing in a cluster that holds data.
// Do not change a construct id, a property or a default here. The migration function of the earlier block is
// not declared; the block's own migration resources take its place.

import type { VpcContext } from '@aws-cdk-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

/** The values of `packages/bb-data/src/constants.ts` at release 0.5.0. */
const DEFAULT_MIN_CAPACITY = 0.5;
const DEFAULT_MAX_CAPACITY = 2;
export const DEFAULT_BACKUP_RETENTION_DAYS = 15;
const VPC_MAX_AZS = 2;

/**
 * Configuration for Aurora Serverless v2 infrastructure.
 */
export interface AuroraInfraConfig {
	/** Minimum ACU capacity. @default 0.5 */
	minCapacity?: number;
	/** Maximum ACU capacity. @default 2 */
	maxCapacity?: number;
	/** PostgreSQL database name. */
	databaseName: string;
	/** CloudFormation removal policy for the Aurora cluster. @default RETAIN */
	removalPolicy?: cdk.RemovalPolicy;
	/**
	 * Whether to enable RDS deletion protection. Resolved independently of
	 * `removalPolicy` so the stack-wide `defaults.deletionProtection` is honored.
	 * @default derived from removalPolicy (protected unless DESTROY)
	 */
	deletionProtection?: boolean;
	/** Aurora PostgreSQL engine version, e.g. `'16.13'`. @default '16.13' */
	postgresVersion?: string;
	/**
	 * Customer-managed KMS key for encrypting the cluster storage at rest. When
	 * provided it is also used to encrypt the cluster's auto-generated credentials
	 * secret, and it forces storage encryption on regardless of `storageEncrypted`.
	 * When omitted, storage encryption follows `storageEncrypted` (which uses the
	 * account's AWS-managed `aws/rds` key when enabled).
	 */
	storageEncryptionKey?: kms.IKey;
	/**
	 * Whether to encrypt the cluster storage at rest. Two states, by design:
	 * - `true` → emit `storageEncrypted: true` (opt in).
	 * - `undefined` → leave the property **unset** so an existing, implicitly
	 *   unencrypted cluster is not forced into a destructive replacement by a
	 *   template change.
	 *
	 * The type is `?: true` (not `boolean`) so an explicit `false` is
	 * **unrepresentable** rather than merely discouraged: `StorageEncrypted: false`
	 * would itself be a template change that replaces an existing cluster. The CDK
	 * layer resolves this from the `@aws-blocks/bb-data:encryptStorageByDefault`
	 * context flag; a supplied `storageEncryptionKey` forces encryption on.
	 */
	storageEncrypted?: true;
	/**
	 * Retention period for the cluster's automated backups (which also drives the
	 * point-in-time-recovery window). @default `cdk.Duration.days(15)` — matches
	 * the SecureCDK baseline.
	 */
	backupRetention?: cdk.Duration;
	/**
	 * VPC context from the parent scope. When provided, Aurora is placed in the
	 * shared VPC's isolated subnets instead of creating its own VPC.
	 * @internal
	 */
	vpcContext?: VpcContext;
	/**
	 * Explicit subnet placement for the Aurora cluster, resolved from the
	 * customer's `Database({ subnets })` option by the CDK layer. When provided,
	 * it overrides the default isolated-preferred placement. Only meaningful with
	 * a shared `vpcContext`.
	 * @internal
	 */
	clusterSubnets?: ec2.SubnetSelection;
	/**
	 * CloudWatch retention applied to the log groups this stack owns. Populated
	 * from the stack-wide `defaults.logRetention`; when omitted the groups use the
	 * CDK/CloudWatch default retention. The cluster's PostgreSQL **engine** log
	 * group reads it, via the cluster's `cloudwatchLogsRetention` prop (see the
	 * note there about the LogRetention custom resource).
	 */
	logRetention?: cdk.aws_logs.RetentionDays;
}

/**
 * Output from Aurora infrastructure materialization.
 */
export interface AuroraInfraOutputs {
	/** The Aurora cluster construct. */
	cluster: rds.DatabaseCluster;
	/** Cluster ARN for Data API calls. */
	clusterArn: string;
	/** Secrets Manager secret ARN for credentials. */
	secretArn: string;
	/** Database name. */
	databaseName: string;
	/**
	 * Grant Data API permissions to a Lambda or other IAM principal.
	 *
	 * @example
	 * const infra = materializeLegacyAurora(stack, 'mydb', { databaseName: 'mydb' });
	 * infra.grantDataApi(lambdaFunction);
	 */
	grantDataApi: (grantee: iam.IGrantable) => void;
}

/**
 * Provision Aurora Serverless v2 PostgreSQL with Data API enabled.
 *
 * Creates: VPC (2 AZs, isolated subnets, no NAT), Aurora cluster,
 * Secrets Manager credentials, security group, IAM grants, and CfnOutputs.
 *
 * @param scope - CDK construct scope
 * @param name - Logical name used for resource naming and env var prefix
 * @param options - Capacity and database name configuration
 * @returns Infrastructure outputs including env vars and grant function
 *
 * @example
 * const infra = materializeLegacyAurora(stack, 'main', { databaseName: 'main' });
 * infra.grantDataApi(handler);
 */
export function materializeLegacyAurora(
	scope: Construct,
	name: string,
	options: AuroraInfraConfig,
): AuroraInfraOutputs {
	const { minCapacity = DEFAULT_MIN_CAPACITY, maxCapacity = DEFAULT_MAX_CAPACITY, databaseName } = options;

	// Determine VPC (shared or standalone)
	const vpc =
		options.vpcContext?.vpc ??
		new ec2.Vpc(scope, `${name}Vpc`, {
			maxAzs: VPC_MAX_AZS,
			natGateways: 0,
			subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
		});

	// Pick where the cluster lands.
	//
	// Standalone: we build the VPC above with a dedicated isolated tier, so pin to it.
	//
	// Shared (bring-your-own) VPC: the isolated tier is not guaranteed. The VPC in
	// every docs example (`new ec2.Vpc(app, 'AppVpc', { maxAzs: 2, natGateways: 1 })`)
	// has only public + private-with-egress subnets, so hard-requiring PRIVATE_ISOLATED
	// makes the documented setup fail synth with "no isolated subnet groups in this VPC".
	// Aurora is reached over the RDS Data API (HTTPS via the interface endpoint), never a
	// raw socket, so the placement tier doesn't affect reachability — it only has to be a
	// tier the VPC actually has. Prefer isolated when present (keeps the DB off any NAT
	// path), otherwise fall back to private-with-egress.
	let clusterSubnets: ec2.SubnetSelection;
	if (options.clusterSubnets) {
		// Customer explicitly chose placement via Database({ subnets }); honor it.
		clusterSubnets = options.clusterSubnets;
	} else if (options.vpcContext) {
		// Prefer the isolated tier when the VPC has one (keeps the DB off any NAT
		// path); otherwise fall back to private-with-egress. selectSubnets throws an
		// instructive, BB-named error if neither exists. `name` is the BB's fullId
		// here (the caller passes the cluster's fullId).
		clusterSubnets = options.vpcContext.selectSubnets({ fullId: name }, 'isolated', {
			fallback: 'private-with-egress',
		});
	} else {
		clusterSubnets = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
	}

	// Security group for the cluster. No ingress rule: the cluster runs with
	// `enableDataApi: true` and is reached exclusively over the RDS Data API
	// (HTTPS via the Secrets Manager + RDS Data interface endpoints), never a raw
	// Postgres socket. A 5432 ingress rule would imply a direct DB connection path
	// that nothing in CDK Blocks uses. Egress stays closed for the same reason.
	const securityGroup = new ec2.SecurityGroup(scope, `${name}Sg`, {
		vpc,
		description: `Security group for ${name} Aurora cluster`,
		allowAllOutbound: false,
	});

	// Aurora Serverless v2 cluster with Data API enabled
	const removalPolicy = options.removalPolicy ?? cdk.RemovalPolicy.RETAIN;

	// Aurora PostgreSQL engine version. Kept configurable because AWS periodically
	// retires older minor versions — 16.4 was retired in us-east-1, after which
	// CreateDBCluster failed with "Cannot find version 16.4 for aurora-postgresql".
	// Default to the latest available 16.x (16.13) for the longest deprecation
	// runway; callers can override via `postgresVersion` when AWS retires it too.
	// Validate the override up front so a malformed value fails fast at synth
	// time with a clear message, instead of as an opaque CreateDBCluster error.
	let engineVersion: rds.AuroraPostgresEngineVersion;
	if (options.postgresVersion === undefined) {
		engineVersion = rds.AuroraPostgresEngineVersion.VER_16_13;
	} else {
		if (!/^\d+\.\d+$/.test(options.postgresVersion)) {
			throw new Error(
				`Invalid postgresVersion "${options.postgresVersion}"; expected "MAJOR.MINOR" like "16.13".`,
			);
		}
		const majorVersion = options.postgresVersion.split('.')[0];
		engineVersion = rds.AuroraPostgresEngineVersion.of(options.postgresVersion, majorVersion);
	}

	// Backup retention for the cluster's automated backups. Aurora keeps continuous
	// backups within this window, which is also what point-in-time recovery restores
	// from. Default to 15 days to match the SecureCDK baseline; callers may
	// override via `backupRetention`.
	const backupRetention = options.backupRetention ?? cdk.Duration.days(DEFAULT_BACKUP_RETENTION_DAYS);

	// Resolve storage encryption to `true` or `undefined` — never an explicit
	// `false`. CloudFormation renders `StorageEncrypted: false` for an explicit
	// false, itself a template change that forces a cluster replacement on an
	// existing (implicitly-unencrypted) deployment; leaving the property unset
	// keeps those clusters untouched. A customer-managed key always forces
	// encryption on; otherwise honor the caller-resolved opt-in (the CDK layer
	// gates it behind the `@aws-blocks/bb-data:encryptStorageByDefault` flag).
	const storageEncrypted = options.storageEncryptionKey || options.storageEncrypted ? true : undefined;

	const cluster = new rds.DatabaseCluster(scope, `${name}Cluster`, {
		engine: rds.DatabaseClusterEngine.auroraPostgres({
			version: engineVersion,
		}),
		serverlessV2MinCapacity: minCapacity,
		serverlessV2MaxCapacity: maxCapacity,
		writer: rds.ClusterInstance.serverlessV2(`${name}Writer`),
		vpc,
		vpcSubnets: clusterSubnets,
		securityGroups: [securityGroup],
		defaultDatabaseName: databaseName,
		enableDataApi: true,
		// Storage encryption at rest. Resolved to `true` or left unset (never an
		// explicit `false`): the CDK layer gates the opt-in behind the
		// `@aws-blocks/bb-data:encryptStorageByDefault` context flag so NEW projects
		// are encrypted by default while EXISTING, implicitly-unencrypted clusters
		// are not forced into a destructive replacement by a template change. A
		// customer-managed `storageEncryptionKey` always forces it on. When a key is
		// given the cluster uses it; otherwise `true` uses the account's AWS-managed
		// `aws/rds` key.
		storageEncrypted,
		storageEncryptionKey: options.storageEncryptionKey,
		// When a CMK is supplied, also encrypt the auto-generated credentials secret
		// with it. CDK cannot set an encryption key on the cluster's auto-generated
		// secret without providing an explicit generated-secret credential, so we pin
		// the exact name of the admin user that the aurora-postgres engine defaults to
		// ('postgres'). Note this is not a no-op swap of only the secret's KMS key:
		// supplying (or changing) a CMK gives the generated secret a new logical id,
		// so CloudFormation mints a fresh secret with a NEW generated password, and
		// that generated secret carries DeletionPolicy:Delete even under production.
		// Without a CMK, credentials stay undefined so the default AWS-managed secret
		// encryption is unchanged.
		credentials: options.storageEncryptionKey
			? rds.Credentials.fromGeneratedSecret('postgres', { encryptionKey: options.storageEncryptionKey })
			: undefined,
		// Retain automated backups (and the PITR window they provide).
		backup: { retention: backupRetention },
		// Export the PostgreSQL engine log to CloudWatch Logs. Retention follows the
		// stack-wide `defaults.logRetention` when provided (the same knob every other
		// CDK Blocks-managed log group reads); when omitted, CloudWatch keeps the log
		// group at the account default retention.
		//
		// Setting `cloudwatchLogsRetention` makes CDK add a `LogRetention` custom
		// resource (a per-stack singleton Lambda + IAM role) to apply the retention,
		// because RDS owns the engine log group's name via a token id, so CDK can't
		// create the LogGroup directly. This extra Lambda is intended — see DESIGN.md.
		//
		// Known gap (deliberate, not implemented here): this engine log group is NOT
		// deleted when the cluster is destroyed — the LogRetention custom resource
		// only sets retention, it does not own the group's lifecycle — so it is left
		// orphaned on destroy. Acknowledged as a known gap; deleting it would mean
		// adopting the RDS-named group into a managed LogGroup, a larger change.
		cloudwatchLogsExports: ['postgresql'],
		cloudwatchLogsRetention: options.logRetention,
		// iamAuthentication is intentionally NOT enabled: the cluster is reached
		// exclusively over the RDS Data API (HTTPS + Secrets Manager credentials),
		// never a direct DB socket, so database-level IAM authentication does not
		// apply here. Automatic secret rotation is likewise a deliberate follow-up:
		// it requires a rotation Lambda wired into the cluster VPC, a larger change
		// than this one.
		// Read independently from defaults (falling back to the removalPolicy-derived
		// value for callers that don't pass it).
		deletionProtection: options.deletionProtection ?? removalPolicy !== cdk.RemovalPolicy.DESTROY,
		removalPolicy,
	});

	const secret = cluster.secret;
	if (!secret) {
		throw new Error(
			`Aurora cluster '${name}' did not generate a Secrets Manager secret. ` +
				`Ensure defaultDatabaseName is set.`,
		);
	}

	/**
	 * Grant rds-data:* and secretsmanager:GetSecretValue to a principal.
	 * Call this with the Lambda handler to allow Data API access.
	 */
	const grantDataApi = (grantee: iam.IGrantable) => {
		grantee.grantPrincipal.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: [
					'rds-data:ExecuteStatement',
					'rds-data:BatchExecuteStatement',
					'rds-data:BeginTransaction',
					'rds-data:CommitTransaction',
					'rds-data:RollbackTransaction',
				],
				resources: [cluster.clusterArn],
			}),
		);
		secret.grantRead(grantee);
	};

	new cdk.CfnOutput(scope, `${name}ClusterArn`, { value: cluster.clusterArn });
	new cdk.CfnOutput(scope, `${name}SecretArn`, { value: secret.secretArn });

	return {
		cluster,
		clusterArn: cluster.clusterArn,
		secretArn: secret.secretArn,
		databaseName,
		grantDataApi,
	};
}
