import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Construct } from 'constructs';
import { CustomResource, Duration } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type { IKeyValueStore } from 'aws-cdk-lib/aws-cloudfront';

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives at <repo>/packages/hosting/dist/constructs/kv_keys.js.
// NodejsFunction requires `entry` to sit UNDER `projectRoot` and a
// `depsLockFilePath` under it too. When this construct runs from a CONSUMING
// app (cwd elsewhere), the default projectRoot is that app and the handler is
// "not under root" (PathNotUnderRoot). Anchor both to the monorepo root (4
// levels up: dist/constructs → dist → hosting → packages → repo), which is the
// only place with a package-lock.json + node_modules for esbuild to bundle the
// kvs SDK dep.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

export type KvKeysProps = {
  /** The CloudFront KeyValueStore to write into. */
  store: IKeyValueStore;
  /**
   * Desired key→value map. The custom resource diffs this against what's in
   * the store and applies the minimal set of put/delete operations (chunked to
   * the 50-key / 3 MB UpdateKeys ceiling).
   */
  entries: Record<string, string>;
};

/**
 * Writes/updates entries in a CloudFront KeyValueStore at deploy time via the
 * `cloudfront-keyvaluestore` data-plane API (the CDK `KeyValueStore` construct
 * only SEEDS at create time; this performs live updates on redeploys).
 *
 * Wire this to depend on the asset deployments so the KV flip that activates a
 * new `buildId` happens only after the new build's assets are in S3 — the
 * atomic-deploy cutover. Use {@link node} `addDependency` from the caller.
 */
export class KvKeys extends Construct {
  /** The underlying CustomResource, so callers can add dependencies. */
  readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: KvKeysProps) {
    super(scope, id);

    // The compiled handler ships next to this file in dist/. esbuild
    // (NodejsFunction) re-bundles it, pulling in the kvs SDK client which is
    // not in the Lambda runtime baseline.
    const handler = new NodejsFunction(this, 'Fn', {
      entry: join(__dirname, 'kv_keys_handler.js'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.minutes(5),
      // Anchor to the monorepo root so `entry` is under `projectRoot` even when
      // a consuming app (different cwd) instantiates this construct.
      projectRoot: REPO_ROOT,
      depsLockFilePath: join(REPO_ROOT, 'package-lock.json'),
      bundling: { minify: true },
    });

    // Data-plane KVS access: describe/list to diff, update to apply.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudfront-keyvaluestore:DescribeKeyValueStore',
          'cloudfront-keyvaluestore:ListKeys',
          'cloudfront-keyvaluestore:GetKey',
          'cloudfront-keyvaluestore:PutKey',
          'cloudfront-keyvaluestore:DeleteKey',
          'cloudfront-keyvaluestore:UpdateKeys',
        ],
        resources: [props.store.keyValueStoreArn],
      }),
    );

    const provider = new Provider(this, 'Provider', {
      onEventHandler: handler,
    });

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        KvsArn: props.store.keyValueStoreArn,
        // Stringify so CloudFormation sees a single property that changes
        // whenever any entry changes (triggers Update → diff → UpdateKeys).
        Entries: JSON.stringify(props.entries),
      },
    });
  }
}
