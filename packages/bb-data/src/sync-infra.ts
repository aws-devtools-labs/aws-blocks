// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK infrastructure for `Database({ sync })`: the Electric sync service.
 *
 * ```
 * browser ─▶ API Gateway ─▶ app Lambda (shape endpoint: verify token)
 *                              │ SigV4
 *                              ▼
 *                         HTTP API (IAM auth) ─▶ VPC link ─▶ Cloud Map ─▶ Electric (Fargate)
 *                                                                              │ 5432, logical replication
 *                                                                              ▼
 *                                                                           Aurora
 * ```
 *
 * Networking. The app Lambda runs outside a VPC and reaches Aurora over the
 * Data API; Electric needs a direct Postgres connection. The HTTP API gives the
 * Lambda a TLS, IAM-authorized path to Electric without putting the Lambda in a
 * VPC. Where Electric runs depends on the database's VPC:
 *
 * - Standalone (Blocks-created, isolated, no NAT): Electric gets its own small
 *   VPC with public subnets (so the task can pull its image without a NAT
 *   gateway), peered to the database VPC. The database VPC is not modified
 *   beyond two routes and one security-group rule, so enabling sync on an
 *   existing database never replaces its subnets.
 * - Shared (`defaults.vpc`): Electric runs in that VPC's private-with-egress
 *   subnets, next to the cluster.
 *
 * Inbound access to the task is limited to the VPC link's security group; the
 * cluster accepts 5432 only from Electric.
 */

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { VpcContext } from '@aws-blocks/core/cdk';
import { blocksNodejsBundling, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpServiceDiscoveryIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { ENV_NAME_SANITIZE_PATTERN, ENV_VAR_PREFIX } from './constants.js';
import type { AuroraInfraOutputs } from './infra.js';
import type { ElectricServiceOptions } from './types.js';
import { DEFAULT_ELECTRIC_VERSION, electricImage } from './sync-image.js';

const ELECTRIC_PORT = 3000;
/** CIDR of the standalone Electric VPC. Must not overlap the database VPC (CDK default 10.0.0.0/16). */
export const ELECTRIC_VPC_CIDR = '10.254.0.0/24';

/** Configuration for {@link materializeSync}. */
export interface SyncInfraConfig {
  /** Database `fullId`. */
  name: string;
  databaseName: string;
  tables: string[];
  electric?: ElectricServiceOptions;
  /** The Database's Aurora infrastructure. */
  aurora: AuroraInfraOutputs;
  /** Shared VPC context, when the app brought its own VPC. */
  vpcContext?: VpcContext;
  logRetention?: cdk.aws_logs.RetentionDays;
}

/** Outputs of {@link materializeSync}. */
export interface SyncInfraOutputs {
  /** Config the shape endpoint reads at runtime (`BLOCKS_{id}_SYNC_*`). */
  envVars: Record<string, string>;
  /** Grant the app runtime what the shape endpoint needs. */
  grantRuntime: (grantee: iam.IGrantable) => void;
  /** The Electric Fargate service. */
  service: ecs.FargateService;
  /** The HTTP API in front of Electric. */
  httpApi: apigwv2.HttpApi;
}

/** Provision the Electric sync service for a Database. */
export function materializeSync(scope: Construct, config: SyncInfraConfig): SyncInfraOutputs {
  const { name, aurora, databaseName, tables } = config;
  const envName = name.replace(ENV_NAME_SANITIZE_PATTERN, '_');
  const id = (suffix: string) => `${name}Sync${suffix}`;

  // ── Secrets ─────────────────────────────────────────────────────────────
  // Alphanumeric only: both values are embedded in a Postgres URL / SQL / query
  // string, so no character ever needs escaping.
  const dbPassword = new secretsmanager.Secret(scope, id('DbPassword'), {
    description: `Password of the Electric replication role for ${name}`,
    generateSecretString: { passwordLength: 32, excludePunctuation: true },
  });
  const serviceSecret = new secretsmanager.Secret(scope, id('ServiceSecret'), {
    description: `Electric API secret (and shape-token signing root) for ${name}`,
    generateSecretString: { passwordLength: 40, excludePunctuation: true },
  });

  // ── Database setup: role, grants, replica identity, publication ─────────
  const setupFn = new lambda.NodejsFunction(scope, id('SetupFn'), {
    // Compiled sibling in dist/ (src/ is not shipped).
    entry: join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'sync-setup-lambda.js'),
    handler: 'handler',
    runtime: DEFAULT_NODE_RUNTIME,
    timeout: cdk.Duration.minutes(5),
    logGroup: new LogGroup(scope, id('SetupLogs'), {
      retention: config.logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    environment: {
      CLUSTER_ARN: aurora.clusterArn,
      SECRET_ARN: aurora.secretArn,
      DATABASE_NAME: databaseName,
      ELECTRIC_DB_SECRET_ARN: dbPassword.secretArn,
    },
    bundling: blocksNodejsBundling({ externalModules: ['@aws-sdk/*'] }),
  });
  aurora.grantDataApi(setupFn);
  dbPassword.grantRead(setupFn);
  const setupProvider = new cr.Provider(scope, id('SetupProvider'), { onEventHandler: setupFn });
  const setup = new cdk.CustomResource(scope, id('Setup'), {
    serviceToken: setupProvider.serviceToken,
    // Re-run when the table list or the password secret changes.
    properties: { tables: tables.join(','), passwordSecret: dbPassword.secretArn },
  });
  if (aurora.migrationResource) setup.node.addDependency(aurora.migrationResource);
  else if (aurora.writerResource) (setup.node.defaultChild as cdk.CfnResource).addDependency(aurora.writerResource);

  // ── Network placement ───────────────────────────────────────────────────
  let vpc: ec2.IVpc;
  let subnets: ec2.SubnetSelection;
  let assignPublicIp: boolean;
  const electricSg = (targetVpc: ec2.IVpc) =>
    new ec2.SecurityGroup(scope, id('ServiceSg'), {
      vpc: targetVpc,
      description: `Electric sync service for ${name}`,
      allowAllOutbound: true,
    });
  let serviceSg: ec2.SecurityGroup;

  if (config.vpcContext) {
    vpc = config.vpcContext.vpc;
    subnets = config.vpcContext.selectSubnets({ fullId: name }, 'private-with-egress');
    assignPublicIp = false;
    serviceSg = electricSg(vpc);
    aurora.securityGroup.addIngressRule(serviceSg, ec2.Port.tcp(5432), 'Electric sync service');
  } else {
    const electricVpc = new ec2.Vpc(scope, id('Vpc'), {
      ipAddresses: ec2.IpAddresses.cidr(ELECTRIC_VPC_CIDR),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26 }],
    });
    const peering = new ec2.CfnVPCPeeringConnection(scope, id('Peering'), {
      vpcId: electricVpc.vpcId,
      peerVpcId: aurora.vpc.vpcId,
    });
    electricVpc.publicSubnets.forEach((subnet, i) => {
      new ec2.CfnRoute(scope, id(`RouteToDb${i}`), {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: aurora.vpc.vpcCidrBlock,
        vpcPeeringConnectionId: peering.ref,
      });
    });
    aurora.vpc.selectSubnets(aurora.clusterSubnets).subnets.forEach((subnet, i) => {
      new ec2.CfnRoute(scope, id(`RouteFromDb${i}`), {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: ELECTRIC_VPC_CIDR,
        vpcPeeringConnectionId: peering.ref,
      });
    });
    aurora.securityGroup.addIngressRule(ec2.Peer.ipv4(ELECTRIC_VPC_CIDR), ec2.Port.tcp(5432), 'Electric sync service');
    vpc = electricVpc;
    subnets = { subnetType: ec2.SubnetType.PUBLIC };
    assignPublicIp = true;
    serviceSg = electricSg(vpc);
  }

  // ── Electric on Fargate ─────────────────────────────────────────────────
  const image = electricImage(scope, {
    id,
    version: config.electric?.version ?? DEFAULT_ELECTRIC_VERSION,
    image: config.electric?.image,
    logRetention: config.logRetention,
  });
  const cluster = new ecs.Cluster(scope, id('Cluster'), { vpc });
  const taskDefinition = new ecs.FargateTaskDefinition(scope, id('Task'), {
    cpu: config.electric?.cpu ?? 512,
    memoryLimitMiB: config.electric?.memoryMiB ?? 1024,
    runtimePlatform: { cpuArchitecture: image.cpuArchitecture, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
  });
  const logGroup = new LogGroup(scope, id('Logs'), {
    retention: config.logRetention,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  taskDefinition.addContainer('electric', {
    image: image.image,
    // Electric takes one connection URL; build it from parts so the password
    // stays an ECS secret instead of a plain environment value.
    entryPoint: ['/bin/sh', '-c'],
    command: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variables, expanded by /bin/sh in the container
      'export DATABASE_URL="postgresql://${ELECTRIC_DB_USER}:${ELECTRIC_DB_PASSWORD}@${ELECTRIC_DB_HOST}:${ELECTRIC_DB_PORT}/${ELECTRIC_DB_NAME}?sslmode=require" && exec /app/bin/entrypoint start',
    ],
    environment: {
      ELECTRIC_DB_USER: 'electric',
      ELECTRIC_DB_HOST: aurora.cluster.clusterEndpoint.hostname,
      ELECTRIC_DB_PORT: '5432',
      ELECTRIC_DB_NAME: databaseName,
      ELECTRIC_PORT: String(ELECTRIC_PORT),
      // The publication is managed by the setup custom resource.
      ELECTRIC_MANUAL_TABLE_PUBLISHING: 'true',
      ELECTRIC_DB_POOL_SIZE: '10',
      ELECTRIC_STORAGE_DIR: '/app/persistent',
    },
    secrets: {
      ELECTRIC_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbPassword),
      ELECTRIC_SECRET: ecs.Secret.fromSecretsManager(serviceSecret),
    },
    portMappings: [{ containerPort: ELECTRIC_PORT }],
    healthCheck: {
      command: ['CMD-SHELL', `curl -fsS http://localhost:${ELECTRIC_PORT}/v1/health || exit 1`],
      startPeriod: cdk.Duration.seconds(60),
    },
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'electric', logGroup }),
  });

  const namespaceHash = createHash('sha256').update(`${cdk.Stack.of(scope).stackName}/${name}`).digest('hex').slice(0, 10);
  const namespace = new servicediscovery.PrivateDnsNamespace(scope, id('Namespace'), {
    name: `electric-${namespaceHash}.internal`,
    vpc,
  });

  const service = new ecs.FargateService(scope, id('Service'), {
    cluster,
    taskDefinition,
    desiredCount: 1,
    assignPublicIp,
    vpcSubnets: subnets,
    securityGroups: [serviceSg],
    // One replication slot: stop the old task before starting the new one.
    minHealthyPercent: 0,
    maxHealthyPercent: 100,
    circuitBreaker: { rollback: true },
    cloudMapOptions: {
      name: 'electric',
      cloudMapNamespace: namespace,
      dnsRecordType: servicediscovery.DnsRecordType.SRV,
      containerPort: ELECTRIC_PORT,
    },
  });
  service.node.addDependency(setup);
  if (image.build) service.node.addDependency(image.build);

  // ── HTTP API (IAM auth) → VPC link → Cloud Map ──────────────────────────
  const vpcLinkSg = new ec2.SecurityGroup(scope, id('VpcLinkSg'), {
    vpc,
    description: `API Gateway VPC link to Electric for ${name}`,
    allowAllOutbound: true,
  });
  serviceSg.addIngressRule(vpcLinkSg, ec2.Port.tcp(ELECTRIC_PORT), 'API Gateway VPC link');
  const vpcLink = new apigwv2.VpcLink(scope, id('VpcLink'), {
    vpc,
    subnets,
    securityGroups: [vpcLinkSg],
  });
  const httpApi = new apigwv2.HttpApi(scope, id('Api'), {
    description: `Electric shape API for ${name} (IAM auth; called by the app Lambda)`,
  });
  const discoveryService = service.cloudMapService;
  if (!discoveryService) throw new Error(`Electric service for ${name} has no Cloud Map service`);
  const [route] = httpApi.addRoutes({
    path: '/v1/shape',
    methods: [apigwv2.HttpMethod.GET],
    integration: new HttpServiceDiscoveryIntegration(id('Integration'), discoveryService, { vpcLink }),
    authorizer: new HttpIamAuthorizer(),
  });

  cdk.Annotations.of(scope).addInfoV2(
    'bb-data:sync:reboot',
    `Database "${name}" enables logical replication. A new cluster picks it up at creation. ` +
      'If this cluster existed before sync was enabled, reboot its writer instance once after this deploy ' +
      '(rds.logical_replication is a static parameter); Electric retries until then.',
  );

  return {
    envVars: {
      [`${ENV_VAR_PREFIX}_${envName}_SYNC_URL`]: `${httpApi.apiEndpoint}/v1/shape`,
      [`${ENV_VAR_PREFIX}_${envName}_SYNC_SECRET_ARN`]: serviceSecret.secretArn,
    },
    grantRuntime: (grantee) => {
      serviceSecret.grantRead(grantee);
      route.grantInvoke(grantee);
    },
    service,
    httpApi,
  };
}
