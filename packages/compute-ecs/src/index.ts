// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cr from 'aws-cdk-lib/custom-resources';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import type {
  ComputeBindContext,
  ComputeBindResult,
  ComputePrincipal,
  ComputeTarget,
} from '@aws-blocks/core/cdk';
import { getConfigDeployment } from '@aws-blocks/core/cdk';
import {
  CloudFrontFrontDoor,
  buildBackendImageAsset,
  mirrorHandlerEnvironmentToContainer,
} from '@aws-blocks/compute-common';

const CONTAINER_PORT = 8080;
const HEALTH_PATH = '/aws-blocks/health';

export interface EcsFargateAutoscaling {
  /** Minimum running tasks. Default: 2 (multi-AZ availability). */
  minCapacity?: number;
  /** Maximum running tasks. Default: 10. */
  maxCapacity?: number;
  /** Target average CPU percent. Default: 50. */
  targetCpuPercent?: number;
  /** Requests per task before scaling out. Default: 500. */
  requestsPerTarget?: number;
}

export interface EcsFargateComputeProps {
  /** Bring your own VPC. Default: a dedicated 2-AZ VPC. */
  vpc?: ec2.IVpc;
  /**
   * Task networking. `private` (default) places tasks in private subnets
   * behind one NAT gateway. `public` places tasks in public subnets with
   * public IPs and no NAT — cheaper, suited to sandboxes.
   */
  networkMode?: 'private' | 'public';
  /** Task CPU units. Default: 512 (0.5 vCPU). */
  cpu?: number;
  /** Task memory in MiB. Default: 2048 (Lambda default parity). */
  memoryLimitMiB?: number;
  /** Tasks to run before autoscaling adjusts. Default: 2. */
  desiredCount?: number;
  autoscaling?: EcsFargateAutoscaling;
  /** Custom domain for the front door (requires `certificate`). */
  domainName?: string;
  /** ACM certificate in us-east-1 for `domainName`. */
  certificate?: acm.ICertificate;
  /** Backend log retention. Default: two weeks. */
  logRetention?: logs.RetentionDays;
  /** Container image platform. Default: LINUX_AMD64. */
  containerImagePlatform?: ecr_assets.Platform;
  /**
   * Bring your own container image instead of building one from the backend
   * handler. The image must serve the Blocks HTTP protocol on port 8080
   * (see `@aws-blocks/core/http-server`). Mainly an escape hatch and a test
   * seam — the default built image is the supported path.
   */
  image?: ecs.ContainerImage;
  /** Request deadline in milliseconds (BLOCKS_HTTP_TIMEOUT_MS). Default: 55000. */
  requestTimeoutMs?: number;
}

/**
 * Run the Blocks backend on ECS Fargate behind an internal ALB with a
 * CloudFront front door.
 *
 * ```ts
 * import { EcsFargateCompute } from '@aws-blocks/compute-ecs';
 *
 * const stack = await BlocksStack.create(app, name, {
 *   backendHandlerPath,
 *   backendCDKPath,
 *   compute: new EcsFargateCompute(),
 * });
 * ```
 *
 * The companion Lambda continues to serve event sources (AsyncJob, CronJob,
 * Realtime); the containers serve all HTTP traffic. Both run the same bundle
 * and share one execution role, so every Building Block works unchanged.
 */
export class EcsFargateCompute implements ComputeTarget {
  readonly requiredPrincipals: ReadonlyArray<ComputePrincipal> = ['ecs-tasks.amazonaws.com'];

  private readonly props: EcsFargateComputeProps;
  private containerEnv: Record<string, string> = {};

  // Escape hatches for composition and tests. Set during bind().
  public vpc!: ec2.IVpc;
  public cluster!: ecs.Cluster;
  public taskDefinition!: ecs.FargateTaskDefinition;
  public service!: ecs.FargateService;
  public loadBalancer!: elbv2.ApplicationLoadBalancer;
  public frontDoor!: CloudFrontFrontDoor;

  constructor(props: EcsFargateComputeProps = {}) {
    if (props.domainName && !props.certificate) {
      throw new Error('EcsFargateCompute: `domainName` requires `certificate` (ACM, us-east-1).');
    }
    this.props = props;
  }

  bind(ctx: ComputeBindContext): ComputeBindResult {
    const scope = new Construct(ctx.scope, 'ContainerCompute');
    const networkMode = this.props.networkMode ?? (ctx.isSandbox ? 'public' : 'private');
    const isPublic = networkMode === 'public';

    // CloudFront VPC origins require the origin resource in PRIVATE subnets —
    // the origin-facing ENIs black-hole through an IGW route table (verified
    // on a live deploy: healthy targets, deployed VPC origin, CloudFront 504).
    // So the ALB always gets private subnets. In `public` mode those are
    // ISOLATED (the ALB only forwards within the VPC, so it needs no NAT and
    // the mode stays NAT-free); tasks keep public IPs for egress.
    this.vpc =
      this.props.vpc ??
      new ec2.Vpc(scope, 'Vpc', {
        maxAzs: 2,
        natGateways: isPublic ? 0 : 1,
        subnetConfiguration: isPublic
          ? [
              { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
              { name: 'alb', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            ]
          : [
              { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
              { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            ],
      });
    const taskSubnets: ec2.SubnetSelection = isPublic
      ? { subnetType: ec2.SubnetType.PUBLIC }
      : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
    const albSubnets: ec2.SubnetSelection = isPublic
      ? { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
      : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    this.cluster = new ecs.Cluster(scope, 'Cluster', {
      vpc: this.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const image =
      this.props.image ??
      ecs.ContainerImage.fromDockerImageAsset(
        buildBackendImageAsset(scope, 'BackendImage', {
          backendHandlerPath: ctx.backendHandlerPath,
          platform: this.props.containerImagePlatform,
          port: CONTAINER_PORT,
        }),
      );

    this.taskDefinition = new ecs.FargateTaskDefinition(scope, 'TaskDef', {
      cpu: this.props.cpu ?? 512,
      memoryLimitMiB: this.props.memoryLimitMiB ?? 2048,
      taskRole: ctx.sharedRole,
    });
    this.taskDefinition.addContainer('backend', {
      image,
      portMappings: [{ containerPort: CONTAINER_PORT }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'backend',
        logGroup: new logs.LogGroup(scope, 'BackendLogs', {
          logGroupName: `/aws-blocks/${ctx.id}/backend`,
          retention: this.props.logRetention ?? logs.RetentionDays.TWO_WEEKS,
          removalPolicy: ctx.isSandbox ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        }),
      }),
    });

    this.service = new ecs.FargateService(scope, 'Service', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: this.props.desiredCount ?? 2,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      vpcSubnets: taskSubnets,
      assignPublicIp: isPublic,
      enableExecuteCommand: ctx.isSandbox,
    });

    // Internal ALB: CloudFront reaches it through a VPC origin, so it never
    // needs to be internet-facing.
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(scope, 'Alb', {
      vpc: this.vpc,
      internetFacing: false,
      vpcSubnets: albSubnets,
    });
    const listener = this.loadBalancer.addListener('Http', { port: 80, open: false });
    const targetGroup = listener.addTargets('Backend', {
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: HEALTH_PATH,
        interval: cdk.Duration.seconds(15),
        healthyThresholdCount: 2,
      },
    });
    // CloudFront VPC-origin traffic passes through the origin-facing ENIs
    // WITHOUT source NAT: packets arrive at the ALB with CloudFront's public
    // origin-facing source IPs (verified via VPC flow logs on a live deploy —
    // a VPC-CIDR rule REJECTs them). Allow the CloudFront origin-facing
    // managed prefix list. Its id is region-specific, and PrefixList.fromLookup
    // needs an env-pinned stack (Blocks stacks are env-agnostic), so resolve it
    // at deploy time.
    const cloudFrontOriginFacing = new cr.AwsCustomResource(scope, 'CfOriginFacingLookup', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: {
          Filters: [
            { Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of('cloudfront-origin-facing-prefix-list'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    this.loadBalancer.connections.allowFrom(
      ec2.Peer.prefixList(cloudFrontOriginFacing.getResponseField('PrefixLists.0.PrefixListId')),
      ec2.Port.tcp(80),
      'CloudFront origin-facing',
    );

    const scaling = this.props.autoscaling ?? {};
    const scalableTarget = this.service.autoScaleTaskCount({
      minCapacity: scaling.minCapacity ?? this.props.desiredCount ?? 2,
      maxCapacity: scaling.maxCapacity ?? 10,
    });
    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: scaling.targetCpuPercent ?? 50,
    });
    scalableTarget.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: scaling.requestsPerTarget ?? 500,
      targetGroup,
    });

    this.frontDoor = new CloudFrontFrontDoor(scope, 'FrontDoor', {
      origin: origins.VpcOrigin.withApplicationLoadBalancer(this.loadBalancer, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      }),
      domain:
        this.props.domainName && this.props.certificate
          ? { domainName: this.props.domainName, certificate: this.props.certificate }
          : undefined,
      comment: `AWS Blocks backend (${ctx.id})`,
    });

    this.containerEnv = {
      PORT: String(CONTAINER_PORT),
      BLOCKS_COMPUTE: 'ecs',
      BLOCKS_PUBLIC_ORIGIN: this.frontDoor.publicOrigin,
      BLOCKS_HTTP_TIMEOUT_MS: String(this.props.requestTimeoutMs ?? 55_000),
    };

    return { apiUrl: this.frontDoor.apiUrl, apiOrigin: this.frontDoor.apiOrigin };
  }

  finalize(ctx: ComputeBindContext): void {
    // The handler env is complete now (all Building Blocks registered, config
    // registry finalized) — mirror it into the container at synth time.
    mirrorHandlerEnvironmentToContainer(ctx.handler, this.taskDefinition, this.containerEnv);

    // Tasks read blocks-config.json from S3 at boot; never start them before
    // the config object exists.
    const configDeployment = getConfigDeployment(ctx.scope);
    if (configDeployment) {
      this.service.node.addDependency(configDeployment);
    }
  }
}
