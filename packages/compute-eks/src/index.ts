// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { CfnPodIdentityAssociation } from 'aws-cdk-lib/aws-eks';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { KubectlV34Layer } from '@aws-cdk/lambda-layer-kubectl-v34';
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
  handlerEnvironmentForJson,
} from '@aws-blocks/compute-common';

const CONTAINER_PORT = 8080;
const HEALTH_PATH = '/aws-blocks/health';
const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';

export interface EksComputeProps {
  /** Bring your own VPC. Default: a dedicated 2-AZ VPC with one NAT gateway. */
  vpc?: ec2.IVpc;
  /** Kubernetes control plane version. Default: 1.34. */
  kubernetesVersion?: eks.KubernetesVersion;
  /** Namespace the backend runs in. Default: `aws-blocks`. */
  namespace?: string;
  /** Backend pod replicas. Default: 2 (spread across AZs). */
  replicas?: number;
  /** Custom domain for the front door (requires `certificate`). */
  domainName?: string;
  /** ACM certificate in us-east-1 for `domainName`. */
  certificate?: acm.ICertificate;
  /** Container image platform. Default: LINUX_AMD64. */
  containerImagePlatform?: ecr_assets.Platform;
  /**
   * Bring your own image URI instead of building one from the backend
   * handler. Must serve the Blocks HTTP protocol on port 8080 (see
   * `@aws-blocks/core/http-server`). Mainly an escape hatch and test seam.
   */
  imageUri?: string;
  /** Request deadline in milliseconds (BLOCKS_HTTP_TIMEOUT_MS). Default: 55000. */
  requestTimeoutMs?: number;
  /** How long to wait for the ingress ALB to get a hostname. Default: 10 minutes. */
  ingressReadyTimeout?: cdk.Duration;
}

/**
 * Run the Blocks backend on EKS Auto Mode behind an ALB ingress with a
 * CloudFront front door.
 *
 * ```ts
 * import { EksCompute } from '@aws-blocks/compute-eks';
 *
 * const stack = await BlocksStack.create(app, name, {
 *   backendHandlerPath,
 *   backendCDKPath,
 *   compute: new EksCompute(),
 * });
 * ```
 *
 * Auto Mode is the `aws-eks-v2` cluster default: a native AWS::EKS::Cluster
 * with managed compute, storage, and load balancing capabilities. The
 * built-in load balancing capability provisions the ALB from a standard
 * Ingress (no controller install). Pod Identity maps the backend service
 * account onto the shared execution role, so every Building Block grant
 * applies to pods unchanged.
 */
export class EksCompute implements ComputeTarget {
  readonly requiredPrincipals: ReadonlyArray<ComputePrincipal> = ['pods.eks.amazonaws.com'];

  private readonly props: EksComputeProps;
  private containerEnv: Record<string, string> = {};

  // Escape hatches for composition and tests. Set during bind().
  public vpc!: ec2.IVpc;
  public cluster!: eks.Cluster;
  public manifest!: eks.KubernetesManifest;
  public frontDoor!: CloudFrontFrontDoor;

  constructor(props: EksComputeProps = {}) {
    if (props.domainName && !props.certificate) {
      throw new Error('EksCompute: `domainName` requires `certificate` (ACM, us-east-1).');
    }
    this.props = props;
  }

  bind(ctx: ComputeBindContext): ComputeBindResult {
    const scope = new Construct(ctx.scope, 'ContainerCompute');
    const namespace = this.props.namespace ?? 'aws-blocks';
    const serviceAccount = 'blocks-backend';
    const appName = 'blocks-backend';

    this.vpc =
      this.props.vpc ??
      new ec2.Vpc(scope, 'Vpc', {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
          { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        ],
      });
    // Auto Mode's load balancing requires role tags to discover subnets;
    // without them the Ingress never gets an ALB (verified live: ingress
    // hostname wait timed out). https://docs.aws.amazon.com/eks/latest/userguide/tag-subnets-auto.html
    for (const subnet of this.vpc.publicSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    }
    for (const subnet of this.vpc.privateSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    }

    // aws-eks-v2 (stable since it moved into aws-cdk-lib) models Auto Mode
    // natively: AUTOMODE is the default capacity type, the node role and its
    // access entry, the Auto Mode cluster-role policies, and API
    // authentication mode are all managed by the construct.
    this.cluster = new eks.Cluster(scope, 'Cluster', {
      version: this.props.kubernetesVersion ?? eks.KubernetesVersion.V1_34,
      vpc: this.vpc,
      kubectlProviderOptions: {
        kubectlLayer: new KubectlV34Layer(scope, 'KubectlLayer'),
      },
    });

    const imageUri =
      this.props.imageUri ??
      buildBackendImageAsset(scope, 'BackendImage', {
        backendHandlerPath: ctx.backendHandlerPath,
        platform: this.props.containerImagePlatform,
        port: CONTAINER_PORT,
      }).imageUri;

    // Pod Identity: the backend service account assumes the shared execution
    // role, so Building Block grants apply to pods. Auto Mode nodes run the
    // Pod Identity agent out of the box.
    const podIdentity = new CfnPodIdentityAssociation(scope, 'PodIdentity', {
      clusterName: this.cluster.clusterName,
      namespace,
      serviceAccount,
      roleArn: ctx.sharedRole.roleArn,
    });

    // Direct-to-ALB requests must present this header (enforced by the ALB
    // listener rule from the ingress conditions annotation); CloudFront adds
    // it as an origin custom header. The value is read at deploy time with an
    // AwsCustomResource: a `{{resolve:secretsmanager:...}}` dynamic reference
    // is NOT substituted inside custom resource properties, so it would reach
    // the kubectl provider literally and the controller's CreateRule would
    // fail with "Condition value ... cannot contain more than 128 characters"
    // (verified live; the ingress then never gets an ALB).
    const originVerifySecret = new secretsmanager.Secret(scope, 'OriginVerify', {
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
      description: `CloudFront origin verification header for ${ctx.id}`,
    });
    const originVerifyValue = new cr.AwsCustomResource(scope, 'OriginVerifyValue', {
      onUpdate: {
        service: 'SecretsManager',
        action: 'getSecretValue',
        parameters: { SecretId: originVerifySecret.secretArn },
        physicalResourceId: cr.PhysicalResourceId.of('origin-verify-value'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [originVerifySecret.secretArn],
      }),
    }).getResponseField('SecretString');

    this.containerEnv = {
      PORT: String(CONTAINER_PORT),
      BLOCKS_COMPUTE: 'eks',
      BLOCKS_HTTP_TIMEOUT_MS: String(this.props.requestTimeoutMs ?? 55_000),
      // BLOCKS_PUBLIC_ORIGIN is appended after the front door exists.
    };

    // The pod env is produced lazily at synthesis so it captures every env
    // var Building Blocks and app code attach to the handler, including ones
    // added after BlocksStack.create() returns.
    const podEnv = cdk.Lazy.any({
      produce: () => {
        const merged = new Map<string, string>();
        for (const [key, value] of Object.entries(handlerEnvironmentForJson(ctx.handler))) {
          merged.set(key, value);
        }
        for (const [key, value] of Object.entries(this.containerEnv)) {
          merged.set(key, value);
        }
        return [...merged.entries()].map(([name, value]) => ({ name, value }));
      },
    });

    const probe = {
      httpGet: { path: HEALTH_PATH, port: CONTAINER_PORT },
      initialDelaySeconds: 5,
      periodSeconds: 10,
    };

    // Two manifests on purpose. The Deployment's env references the
    // CloudFront domain, and CloudFront's origin reads the ingress ALB
    // hostname â€” putting the Ingress and the Deployment in one manifest
    // would make that a dependency cycle. The infra manifest (everything the
    // ALB needs) deploys first; the Deployment follows once the front door
    // exists.
    // `overwrite: true` gives apply semantics, so re-deploys after a failed
    // attempt never trip over leftover objects from a previous rollout.
    const infraManifest = new eks.KubernetesManifest(scope, 'BackendInfra', {
      cluster: this.cluster,
      overwrite: true,
      manifest: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } },
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: serviceAccount, namespace },
      },
      // Auto Mode ships an ingress controller but not an IngressClass; this
      // pair opts the cluster's built-in ALB provisioning in.
      {
        apiVersion: 'eks.amazonaws.com/v1',
        kind: 'IngressClassParams',
        metadata: { name: 'alb' },
        spec: { scheme: 'internet-facing' },
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'IngressClass',
        metadata: { name: 'alb' },
        spec: {
          controller: 'eks.amazonaws.com/alb',
          parameters: { apiGroup: 'eks.amazonaws.com', kind: 'IngressClassParams', name: 'alb' },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: appName, namespace },
        spec: {
          type: 'ClusterIP',
          selector: { app: appName },
          ports: [{ port: 80, targetPort: CONTAINER_PORT }],
        },
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: {
          name: appName,
          namespace,
          annotations: {
            'alb.ingress.kubernetes.io/target-type': 'ip',
            'alb.ingress.kubernetes.io/healthcheck-path': HEALTH_PATH,
            'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP":80}]',
            // Only requests carrying the CloudFront origin-verify header match
            // the forwarding rule; anything hitting the ALB directly gets the
            // default 404.
            [`alb.ingress.kubernetes.io/conditions.${appName}`]: JSON.stringify([
              {
                field: 'http-header',
                httpHeaderConfig: { httpHeaderName: ORIGIN_VERIFY_HEADER, values: [originVerifyValue] },
              },
            ]),
          },
        },
        spec: {
          ingressClassName: 'alb',
          rules: [
            {
              http: {
                paths: [
                  {
                    path: '/',
                    pathType: 'Prefix',
                    backend: { service: { name: appName, port: { number: 80 } } },
                  },
                ],
              },
            },
          ],
        },
      },
      ],
    });

    this.manifest = new eks.KubernetesManifest(scope, 'Backend', {
      cluster: this.cluster,
      overwrite: true,
      manifest: [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: appName, namespace },
        spec: {
          replicas: this.props.replicas ?? 2,
          selector: { matchLabels: { app: appName } },
          template: {
            metadata: { labels: { app: appName } },
            spec: {
              serviceAccountName: serviceAccount,
              topologySpreadConstraints: [
                {
                  maxSkew: 1,
                  topologyKey: 'topology.kubernetes.io/zone',
                  whenUnsatisfiable: 'ScheduleAnyway',
                  labelSelector: { matchLabels: { app: appName } },
                },
              ],
              containers: [
                {
                  name: 'backend',
                  image: imageUri,
                  ports: [{ containerPort: CONTAINER_PORT }],
                  env: podEnv,
                  readinessProbe: probe,
                  livenessProbe: { ...probe, initialDelaySeconds: 15 },
                  resources: {
                    requests: { cpu: '500m', memory: '1Gi' },
                    limits: { memory: '2Gi' },
                  },
                },
              ],
            },
          },
        },
      },
      ],
    });
    this.manifest.node.addDependency(podIdentity);
    this.manifest.node.addDependency(infraManifest);

    // The ingress-provisioned ALB only surfaces a hostname (no ARN), so a VPC
    // origin is not wireable â€” CloudFront reaches it as an HTTP origin gated
    // by the origin-verify header.
    const ingressHost = new eks.KubernetesObjectValue(scope, 'IngressHost', {
      cluster: this.cluster,
      objectType: 'ingress',
      objectName: appName,
      objectNamespace: namespace,
      jsonPath: '.status.loadBalancer.ingress[0].hostname',
      timeout: this.props.ingressReadyTimeout ?? cdk.Duration.minutes(10),
    });
    // Wait only on the infra manifest: Auto Mode provisions the ALB from the
    // Ingress regardless of endpoint readiness, and depending on the backend
    // manifest would recreate the Deployment -> CloudFront -> IngressHost cycle.
    ingressHost.node.addDependency(infraManifest);

    this.frontDoor = new CloudFrontFrontDoor(scope, 'FrontDoor', {
      origin: new origins.HttpOrigin(ingressHost.value, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        customHeaders: { [ORIGIN_VERIFY_HEADER]: originVerifyValue },
      }),
      domain:
        this.props.domainName && this.props.certificate
          ? { domainName: this.props.domainName, certificate: this.props.certificate }
          : undefined,
      comment: `AWS Blocks backend (${ctx.id})`,
    });
    this.containerEnv.BLOCKS_PUBLIC_ORIGIN = this.frontDoor.publicOrigin;

    return { apiUrl: this.frontDoor.apiUrl, apiOrigin: this.frontDoor.apiOrigin };
  }

  finalize(ctx: ComputeBindContext): void {
    // Pods read blocks-config.json from S3 at boot; never roll them out
    // before the config object exists.
    const configDeployment = getConfigDeployment(ctx.scope);
    if (configDeployment) {
      this.manifest.node.addDependency(configDeployment);
    }
  }

}
