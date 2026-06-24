import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Construct } from 'constructs';
import { CustomResource, Duration } from 'aws-cdk-lib';
import { Code, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type { IKeyValueStore } from 'aws-cdk-lib/aws-cloudfront';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The handler is PRE-BUNDLED at build time (scripts/bundle-handlers.mjs →
// `kv_keys_handler.bundle.mjs`, with the kvs SDK + signature-v4a inlined into a
// single self-contained file). We ship that asset and use a plain
// `Code.fromAsset` instead of `NodejsFunction`.
//
// Why not NodejsFunction: it re-bundles `entry` at SYNTH time and requires the
// entry to sit under a `projectRoot` that also has a lockfile. That only holds
// inside this monorepo — once @aws-blocks/hosting is installed from npm this
// file lives under the consumer's `node_modules/`, projectRoot resolves into
// `node_modules/` (no package-lock), and synth fails with PathNotUnderRoot.
// Pre-bundling removes that dependency entirely: the consumer ships a ready
// asset and CDK just zips the directory.
const HANDLER_BUNDLE = join(__dirname, 'kv_keys_handler.bundle.mjs');

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

    // Pre-bundled, self-contained ESM handler (kvs SDK + signature-v4a inlined
    // at build time). `Code.fromAsset` on the single file → CDK zips it; no
    // synth-time bundling, no projectRoot/lockfile dependency.
    const handler = new LambdaFunction(this, 'Fn', {
      code: Code.fromAsset(dirname(HANDLER_BUNDLE), {
        // Ship only the bundled handler, not the sibling source/maps in dist/.
        exclude: ['*', '!kv_keys_handler.bundle.mjs'],
      }),
      handler: 'kv_keys_handler.bundle.handler',
      runtime: DEFAULT_NODE_RUNTIME,
      timeout: Duration.minutes(5),
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
