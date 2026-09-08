/**
 * Lambda Function URL front-door construct — the cheapest HTTPS, no-CloudFront
 * door for a STATIC site / SPA.
 *
 * A Function URL exposes ONE Lambda over a built-in HTTPS endpoint
 * (`https://<id>.lambda-url.<region>.on.aws/`) with no ALB, no NAT, no API
 * Gateway — pay-per-request, scale-to-zero. Because it is a single origin with
 * no path routing, this door serves a static/SPA site through one asset-proxy
 * Lambda (payload 2.0, shared with the API Gateway door): every request →
 * `builds/<buildId>/…` in the PRIVATE bucket, with SPA-fallback to index.html
 * on a miss. SSR / same-origin API are not available here (see
 * {@link FunctionUrlAdapter}'s support matrix — the negotiator rejects a plan
 * that requires them).
 */
import { CfnOutput, Duration } from 'aws-cdk-lib';
import { AnyPrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, FunctionUrlAuthType, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { CapabilityPlan } from '../plan/types.js';
import { generateApiGwAssetProxyCode } from './apigw_asset_proxy.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

export type FunctionUrlConstructProps = {
  plan: CapabilityPlan;
  bucket: IBucket;
};

export class FunctionUrlConstruct extends Construct {
  readonly url: string;

  constructor(scope: Construct, id: string, props: FunctionUrlConstructProps) {
    super(scope, id);
    const { plan, bucket } = props;
    const buildId = plan.release.buildId;

    const stripPrefix = plan.policies.basePath ?? plan.policies.assetPrefix ?? '';
    // Static-only door: SPA fallback whenever the manifest asked for it.
    const assetProxy = new LambdaFunction(this, 'AssetProxy', {
      runtime: DEFAULT_NODE_RUNTIME,
      handler: 'index.handler',
      code: Code.fromInline(generateApiGwAssetProxyCode({ stripPrefix, spaFallback: plan.policies.spaFallback })),
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: { ASSET_BUCKET: bucket.bucketName, ASSET_KEY_PREFIX: `builds/${buildId}` },
    });
    bucket.grantRead(assetProxy);

    // Public HTTPS endpoint (no auth) — the Function URL IS the front door.
    const fnUrl = assetProxy.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
    // `authType: NONE` still requires an explicit resource-based permission that
    // allows anyone to invoke the URL — without it the Function URL returns 403
    // ("Forbidden. For troubleshooting Function URL authorization…"). CDK does
    // not add this automatically, so grant public `lambda:InvokeFunctionUrl`.
    assetProxy.addPermission('PublicFunctionUrlInvoke', {
      principal: new AnyPrincipal(),
      action: 'lambda:InvokeFunctionUrl',
      functionUrlAuthType: FunctionUrlAuthType.NONE,
    });

    this.url = fnUrl.url;
    new CfnOutput(this, 'FunctionUrl', { value: this.url, description: 'Lambda Function URL front-door URL' });
  }
}
