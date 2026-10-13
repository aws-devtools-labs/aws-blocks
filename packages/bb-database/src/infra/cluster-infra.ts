// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provisions one cluster (DSQL or Aurora Serverless v2) and the migration
 * Lambda its blocks share. Each block calls {@link ClusterInfra.attach}, which
 * publishes the block's migrations as an S3 asset and adds a CustomResource;
 * resources on one cluster are chained so they never run concurrently.
 * Used by `DatabaseCluster` and by a `Database` that owns its cluster.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type BlocksDefaults,
	type BuildingBlockScope,
	blocksNodejsBundling,
	DEFAULT_NODE_RUNTIME,
	type VpcContext,
} from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import {
	DEFAULT_BACKUP_RETENTION_DAYS,
	DEFAULT_MAX_CAPACITY,
	DEFAULT_MIN_CAPACITY,
	DEFAULT_POSTGRES_VERSION,
	ENV_VAR_PREFIX,
	MIGRATION_LAMBDA_TIMEOUT_MINUTES,
	sanitizeDbRoleName,
	toEnvName,
	VPC_MAX_AZS,
} from '../constants.js';
import type { ClusterType, DatabaseClusterOptions, ProvisionedClusterOptions, SubnetSelection } from '../types.js';

const SUBNET_TYPE_MAP: Record<NonNullable<SubnetSelection['subnetType']>, ec2.SubnetType> = {
	isolated: ec2.SubnetType.PRIVATE_ISOLATED,
	'private-with-egress': ec2.SubnetType.PRIVATE_WITH_EGRESS,
	public: ec2.SubnetType.PUBLIC,
};

const REMOVAL_POLICY_MAP = {
	destroy: cdk.RemovalPolicy.DESTROY,
	retain: cdk.RemovalPolicy.RETAIN,
	snapshot: cdk.RemovalPolicy.SNAPSHOT,
} as const;

/** Resolve the CDK-free `subnets` option into a real `ec2.SubnetSelection`. */
function resolveClusterSubnets(
	scope: Construct,
	fullId: string,
	sel?: SubnetSelection,
): ec2.SubnetSelection | undefined {
	if (!sel) return undefined;
	const primaries = [sel.subnetType, sel.subnetGroupName, sel.subnetIds].filter((v) => v !== undefined);
	if (primaries.length > 1) {
		throw new Error(
			`DatabaseCluster "${fullId}": at most one of 'subnetType', 'subnetGroupName', or 'subnetIds' may be set in 'subnets'.`,
		);
	}
	return {
		...(sel.subnetType ? { subnetType: SUBNET_TYPE_MAP[sel.subnetType] } : {}),
		...(sel.subnetGroupName ? { subnetGroupName: sel.subnetGroupName } : {}),
		...(sel.subnetIds
			? { subnets: sel.subnetIds.map((sid, i) => ec2.Subnet.fromSubnetId(scope, `${fullId}Subnet${i}`, sid)) }
			: {}),
		...(sel.availabilityZones ? { availabilityZones: sel.availabilityZones } : {}),
		...(sel.onePerAz !== undefined ? { onePerAz: sel.onePerAz } : {}),
	};
}

/** Hash all .sql files in a directory to detect changes. */
export function hashMigrationsDir(dir: string): string {
	const hash = createHash('sha256');
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		hash.update(file);
		hash.update(readFileSync(join(dir, file), 'utf-8'));
	}
	return hash.digest('hex').slice(0, 16);
}

export interface ClusterInfraProps {
	/** The construct the cluster's resources are created under (the `DatabaseCluster`, or the owning `Database`). */
	owner: BuildingBlockScope;
	/** Names the cluster; drives resource names and the `BLOCKS_{id}_*` config keys. */
	fullId: string;
	type: ClusterType;
	options: DatabaseClusterOptions;
	defaults: BlocksDefaults;
	vpcContext?: VpcContext;
}

/** A block attached to the cluster. */
export interface AttachedBlock {
	scope: Construct;
	fullId: string;
	schemaName: string;
	/** Absolute path, when the block has migrations. */
	migrationsPath?: string;
}

export class ClusterInfra {
	readonly type: ClusterType;
	/** Config entries the runtime reads (`BLOCKS_{id}_*` → token). */
	readonly configEntries: Record<string, string>;
	/** The PostgreSQL role the app connects as on a `distributed` cluster. */
	readonly dbRole: string;

	private readonly owner: BuildingBlockScope;
	private readonly fullId: string;
	private readonly clusterResource: cdk.CfnResource;
	private readonly dependencyResources: cdk.CfnResource[] = [];
	private readonly migrationFn: lambda.NodejsFunction;
	private readonly provider: cr.Provider;
	private readonly attached: AttachedBlock[] = [];
	private lastCustomResource: cdk.CfnResource | undefined;
	private readonly grantRuntimeTo: (grantee: iam.IGrantable) => void;

	constructor(props: ClusterInfraProps) {
		this.owner = props.owner;
		this.fullId = props.fullId;
		this.type = props.type;
		this.dbRole = sanitizeDbRoleName(props.fullId);
		const stack = cdk.Stack.of(props.owner);
		const envName = toEnvName(props.fullId);
		const key = (suffix: string) => `${ENV_VAR_PREFIX}_${envName}_${suffix}`;

		const removalPolicy = props.options.removalPolicy
			? REMOVAL_POLICY_MAP[props.options.removalPolicy]
			: props.defaults.removalPolicy;

		const lambdaEnv: Record<string, string> = { CLUSTER_KIND: props.type };
		let grantAdmin: (fn: lambda.NodejsFunction) => void;

		if (props.type === 'distributed') {
			const cluster = new cdk.CfnResource(props.owner, 'DsqlCluster', {
				type: 'AWS::DSQL::Cluster',
				properties: { DeletionProtectionEnabled: props.defaults.deletionProtection },
			});
			cluster.applyRemovalPolicy(
				removalPolicy === cdk.RemovalPolicy.SNAPSHOT ? cdk.RemovalPolicy.RETAIN : removalPolicy,
			);
			this.clusterResource = cluster;
			const endpoint = cluster.getAtt('Endpoint').toString();
			const clusterArn = `arn:aws:dsql:${stack.region}:${stack.account}:cluster/${cluster.ref}`;
			this.configEntries = { [key('ENDPOINT')]: endpoint, [key('REGION')]: stack.region };
			lambdaEnv.DSQL_ENDPOINT = endpoint;
			lambdaEnv.DSQL_REGION = stack.region;
			lambdaEnv.DB_ROLE_NAME = this.dbRole;
			new cdk.CfnOutput(props.owner, 'DsqlEndpoint', { value: endpoint });
			this.grantRuntimeTo = (grantee) =>
				grantee.grantPrincipal.addToPrincipalPolicy(
					new iam.PolicyStatement({ actions: ['dsql:DbConnect'], resources: [clusterArn] }),
				);
			grantAdmin = (fn) =>
				fn.addToRolePolicy(
					new iam.PolicyStatement({ actions: ['dsql:DbConnectAdmin'], resources: [clusterArn] }),
				);
		} else {
			const aurora = this.materializeAurora(props, removalPolicy);
			this.clusterResource = aurora.cluster.node.defaultChild as cdk.CfnResource;
			if (aurora.writer) this.dependencyResources.push(aurora.writer);
			this.configEntries = {
				[key('CLUSTER_ARN')]: aurora.cluster.clusterArn,
				[key('SECRET_ARN')]: aurora.secret.secretArn,
				[key('DATABASE')]: aurora.databaseName,
			};
			lambdaEnv.CLUSTER_ARN = aurora.cluster.clusterArn;
			lambdaEnv.SECRET_ARN = aurora.secret.secretArn;
			lambdaEnv.DATABASE_NAME = aurora.databaseName;
			this.grantRuntimeTo = aurora.grantDataApi;
			grantAdmin = aurora.grantDataApi;
		}

		// The code is bundled now, before any block attaches, so migrations travel
		// as per-block S3 assets instead (see attach()).
		const here = dirname(fileURLToPath(import.meta.url));
		this.migrationFn = new lambda.NodejsFunction(props.owner, 'MigrationFn', {
			// Points at the compiled migration-lambda.js in dist/ (src/ is not published).
			entry: join(here, '..', 'migration-lambda.js'),
			handler: 'handler',
			runtime: DEFAULT_NODE_RUNTIME,
			timeout: cdk.Duration.minutes(MIGRATION_LAMBDA_TIMEOUT_MINUTES),
			logGroup: new LogGroup(props.owner, 'MigrationLogs', {
				retention: props.defaults.logRetention,
				removalPolicy: cdk.RemovalPolicy.DESTROY,
			}),
			environment: lambdaEnv,
			bundling: blocksNodejsBundling(),
		});
		grantAdmin(this.migrationFn);
		this.provider = new cr.Provider(props.owner, 'MigrationProvider', { onEventHandler: this.migrationFn });
	}

	/** Grant the app's execution role what it needs to query the cluster. */
	grantRuntime(grantee: iam.IGrantable): void {
		this.grantRuntimeTo(grantee);
	}

	/**
	 * Attach a `Database` block: publish its migrations as an asset and add the
	 * CustomResource that creates its schema, applies its migrations, and (on a
	 * `distributed` cluster) provisions the app role's grants, at deploy time.
	 */
	attach(block: AttachedBlock, appRoleArn: string): void {
		this.attached.push(block);
		const migrationsHash = block.migrationsPath ? hashMigrationsDir(block.migrationsPath) : 'no-migrations';
		const asset = block.migrationsPath ? this.migrationsAsset(block.scope, block.migrationsPath) : undefined;
		if (asset) asset.grantRead(this.migrationFn);
		const resource = new cdk.CustomResource(block.scope, 'Migrations', {
			serviceToken: this.provider.serviceToken,
			properties: {
				migrationsHash,
				...(asset ? { migrationsBucket: asset.s3BucketName, migrationsKey: asset.s3ObjectKey } : {}),
				schemaName: block.schemaName,
				blockFullId: block.fullId,
				dbRole: this.dbRole,
				// A property (not just env) so CloudFormation re-runs the resource when
				// the app role is replaced and the DSQL `AWS IAM GRANT` must be re-issued.
				appRoleArn,
			},
		});
		const cfn = resource.node.defaultChild as cdk.CfnResource;
		cfn.addDependency(this.clusterResource);
		for (const dep of this.dependencyResources) cfn.addDependency(dep);
		if (this.lastCustomResource) cfn.addDependency(this.lastCustomResource);
		this.lastCustomResource = cfn;
	}

	/** A block's migrations as one `{ fileName: sql }` JSON asset (uploaded as-is, no unzip). */
	private migrationsAsset(scope: Construct, migrationsPath: string): Asset {
		const files: Record<string, string> = {};
		for (const file of readdirSync(migrationsPath)
			.filter((f) => f.endsWith('.sql'))
			.sort()) {
			files[file] = readFileSync(join(migrationsPath, file), 'utf-8');
		}
		const dir = mkdtempSync(join(tmpdir(), 'bb-database-migrations-'));
		const path = join(dir, 'migrations.json');
		writeFileSync(path, JSON.stringify(files));
		return new Asset(scope, 'MigrationFiles', { path });
	}

	/** Aurora Serverless v2 with the Data API, in the shared VPC or a standalone isolated one. */
	private materializeAurora(props: ClusterInfraProps, removalPolicy: cdk.RemovalPolicy) {
		const options = props.options as ProvisionedClusterOptions;
		const scope = props.owner;
		const name = props.fullId;
		const databaseName = options.databaseName ?? toEnvName(name);

		const vpc =
			props.vpcContext?.vpc ??
			new ec2.Vpc(scope, 'Vpc', {
				maxAzs: VPC_MAX_AZS,
				natGateways: 0,
				subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
			});

		const explicitSubnets = resolveClusterSubnets(scope, name, options.subnets);
		let clusterSubnets: ec2.SubnetSelection;
		if (explicitSubnets) clusterSubnets = explicitSubnets;
		else if (props.vpcContext) {
			clusterSubnets = props.vpcContext.selectSubnets({ fullId: name }, 'isolated', {
				fallback: 'private-with-egress',
			});
		} else clusterSubnets = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

		// No ingress: the cluster is reached exclusively over the RDS Data API.
		const securityGroup = new ec2.SecurityGroup(scope, 'Sg', {
			vpc,
			description: `Security group for ${name} Aurora cluster`,
			allowAllOutbound: false,
		});

		const version = options.postgresVersion ?? DEFAULT_POSTGRES_VERSION;
		if (!/^\d+\.\d+$/.test(version)) {
			throw new Error(`Invalid postgresVersion "${version}"; expected "MAJOR.MINOR" like "16.13".`);
		}
		const engineVersion = rds.AuroraPostgresEngineVersion.of(version, version.split('.')[0]);

		// Backup retention is also the PITR window: true → 15 days, { retentionDays } → 1–35, false → 1-day minimum.
		const pitr = options.pointInTimeRecovery ?? props.defaults.pointInTimeRecovery;
		let backupDays = DEFAULT_BACKUP_RETENTION_DAYS;
		if (typeof pitr === 'object' && pitr !== null) {
			const days = pitr.retentionDays;
			if (!Number.isInteger(days) || days < 1 || days > 35) {
				cdk.Annotations.of(scope).addWarningV2(
					'@aws-blocks/bb-database:InvalidPitrDays',
					`pointInTimeRecovery.retentionDays must be an integer between 1 and 35 (got ${String(days)}). Using ${DEFAULT_BACKUP_RETENTION_DAYS} days.`,
				);
			} else backupDays = days;
		} else if (pitr === false) backupDays = 1;

		const storageEncryptionKey = options.storageEncryptionKeyArn
			? kms.Key.fromKeyArn(scope, 'StorageKey', options.storageEncryptionKeyArn)
			: undefined;

		const cluster = new rds.DatabaseCluster(scope, 'Cluster', {
			engine: rds.DatabaseClusterEngine.auroraPostgres({ version: engineVersion }),
			serverlessV2MinCapacity: options.minCapacity ?? DEFAULT_MIN_CAPACITY,
			serverlessV2MaxCapacity: options.maxCapacity ?? DEFAULT_MAX_CAPACITY,
			writer: rds.ClusterInstance.serverlessV2('Writer'),
			vpc,
			vpcSubnets: clusterSubnets,
			securityGroups: [securityGroup],
			defaultDatabaseName: databaseName,
			enableDataApi: true,
			// Storage is always encrypted on a new block: the AWS-managed key, or the customer's.
			storageEncrypted: true,
			storageEncryptionKey,
			credentials: storageEncryptionKey
				? rds.Credentials.fromGeneratedSecret('postgres', { encryptionKey: storageEncryptionKey })
				: undefined,
			backup: { retention: cdk.Duration.days(backupDays) },
			cloudwatchLogsExports: ['postgresql'],
			cloudwatchLogsRetention: props.defaults.logRetention,
			deletionProtection: props.defaults.deletionProtection,
			removalPolicy,
		});

		const secret = cluster.secret;
		if (!secret) throw new Error(`Aurora cluster '${name}' did not generate a Secrets Manager secret.`);

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

		new cdk.CfnOutput(scope, 'ClusterArn', { value: cluster.clusterArn });
		new cdk.CfnOutput(scope, 'SecretArn', { value: secret.secretArn });

		const writer = cluster.node
			.findAll()
			.find((c) => (c as { cfnResourceType?: string }).cfnResourceType === 'AWS::RDS::DBInstance') as
			| cdk.CfnResource
			| undefined;

		return { cluster, secret, databaseName, grantDataApi, writer };
	}
}

/** Grant Data API access to an external Aurora cluster referenced by ARN + secret. */
export function grantExternalDataApi(
	scope: Construct,
	name: string,
	conn: { host: string; secretArn: string },
	grantee: iam.IGrantable,
): void {
	grantee.grantPrincipal.addToPrincipalPolicy(
		new iam.PolicyStatement({
			actions: [
				'rds-data:ExecuteStatement',
				'rds-data:BatchExecuteStatement',
				'rds-data:BeginTransaction',
				'rds-data:CommitTransaction',
				'rds-data:RollbackTransaction',
			],
			resources: [conn.host],
		}),
	);
	cdk.aws_secretsmanager.Secret.fromSecretCompleteArn(scope, `${toEnvName(name)}ExtSecret`, conn.secretArn).grantRead(
		grantee,
	);
}
