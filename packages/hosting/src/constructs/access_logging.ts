import type { Construct } from 'constructs';
import { Stack, Token } from 'aws-cdk-lib';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import {
  CfnDelivery,
  CfnDeliveryDestination,
  CfnDeliverySource,
} from 'aws-cdk-lib/aws-logs';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { HostingError } from '../hosting_error.js';

/**
 * CloudFront **standard logging v2** wiring (the CloudWatch Logs *vended-logs
 * delivery* pipeline), as an alternative to the legacy v1 logging that the
 * distribution enables via `enableLogging` / `logBucket`.
 *
 * v2 has three advantages over v1 for hosting access logs:
 *
 * 1. **No bucket ACLs.** v1 delivery writes through the `awslogsdelivery`
 *    canonical user and therefore forces the log bucket to keep ACLs enabled
 *    (`BUCKET_OWNER_PREFERRED`). v2 delivers through a service principal
 *    (`delivery.logs.amazonaws.com`) authorized by a bucket *policy*, so the
 *    log bucket can adopt the modern, ACL-disabled `BUCKET_OWNER_ENFORCED`
 *    ownership — one fewer S3 Block-Public-Access exception to reason about.
 * 2. **Configurable, partitioned S3 key layout.** The delivered object key is
 *    templated (`s3SuffixPath`), so logs land under `{DistributionId}/{yyyy}/
 *    {MM}/{dd}/{HH}/…` (or a Hive-compatible `year=…/month=…/` layout) with no
 *    post-processing Lambda re-organizing a flat prefix after the fact.
 * 3. **Selectable record format** (`w3c`, `plain`, `json`, `parquet`) — Athena
 *    / Glue can query `parquet` or `json` directly.
 *
 * @remarks
 * CloudFront is a global service whose access-log **delivery source** must be
 * created in **us-east-1** (mirrors the ACM-certificate constraint the hosting
 * construct already enforces). {@link wireStandardLoggingV2} validates this and
 * throws {@link HostingError} `LoggingV2RegionError` unless
 * `skipRegionValidation` is set (or the stack region is an unresolved token).
 */

/** Delivered log record formats supported by CloudFront standard logging v2. */
export type AccessLogFormat = 'plain' | 'w3c' | 'json' | 'parquet';

/** S3 key-layout strategy for delivered logs. */
export type AccessLogPartitioning = 'date' | 'hive';

/** CloudFront logs its access logs under this delivery `logType`. */
const CLOUDFRONT_ACCESS_LOGS_TYPE = 'ACCESS_LOGS';

/** The only Region in which a CloudFront delivery source may be created. */
const CLOUDFRONT_DELIVERY_REGION = 'us-east-1';

/**
 * Resolve the `(s3SuffixPath, s3EnableHiveCompatiblePath)` pair for a
 * partitioning strategy. Both strategies partition by day and hour so a
 * downstream query engine can prune on date; `hive` additionally emits the
 * `key=value` segment names Athena/Glue partition-projection expects.
 *
 * The `{DistributionId}` prefix keeps multiple distributions from colliding in
 * a shared bucket; `{yyyy}/{MM}/{dd}/{HH}` are the CloudFront-supported
 * delivery template variables.
 */
export const resolveSuffixPath = (
  partitioning: AccessLogPartitioning,
): { suffixPath: string; hiveCompatible: boolean } =>
  partitioning === 'hive'
    ? {
        suffixPath:
          '{DistributionId}/year={yyyy}/month={MM}/day={dd}/hour={HH}',
        hiveCompatible: true,
      }
    : {
        suffixPath: '{DistributionId}/{yyyy}/{MM}/{dd}/{HH}',
        hiveCompatible: false,
      };

/** Options for {@link wireStandardLoggingV2}. */
export type StandardLoggingV2Options = {
  /** The CloudFront distribution ARN whose access logs are delivered. */
  distributionArn: string;
  /** The distribution id, used to name the delivery resources uniquely. */
  distributionId: string;
  /** The destination log bucket (must be `BUCKET_OWNER_ENFORCED`). */
  logBucket: IBucket;
  /** S3 key layout. @default 'date' */
  partitioning?: AccessLogPartitioning;
  /** Delivered record format. @default 'w3c' */
  format?: AccessLogFormat;
  /**
   * Skip the us-east-1 region check. Only set this when you know the stack
   * is (or will synth into) us-east-1 but the region is unavailable at synth.
   * @default false
   */
  skipRegionValidation?: boolean;
};

/**
 * Provision the standard-logging-v2 delivery pipeline for a CloudFront
 * distribution: a `DeliverySource` (the distribution), a `DeliveryDestination`
 * (the S3 bucket), the `Delivery` that binds them with the partitioned key
 * layout, and the bucket policy that lets the delivery service write.
 *
 * @throws {@link HostingError} `LoggingV2RegionError` when the stack's Region is
 * resolved and is not us-east-1 (unless `skipRegionValidation`).
 */
export const wireStandardLoggingV2 = (
  scope: Construct,
  options: StandardLoggingV2Options,
): void => {
  const {
    distributionArn,
    distributionId,
    logBucket,
    partitioning = 'date',
    format = 'w3c',
    skipRegionValidation = false,
  } = options;

  const stack = Stack.of(scope);

  if (
    !skipRegionValidation &&
    !Token.isUnresolved(stack.region) &&
    stack.region !== CLOUDFRONT_DELIVERY_REGION
  ) {
    throw new HostingError('LoggingV2RegionError', {
      message: `CloudFront standard logging v2 requires the stack to be in ${CLOUDFRONT_DELIVERY_REGION} (the delivery source Region for the global CloudFront service), but this stack is in ${stack.region}.`,
      resolution: `Deploy this hosting stack to ${CLOUDFRONT_DELIVERY_REGION}, use v1 logging (\`logging: { version: 'v1' }\`), or set \`skipRegionValidation\` if you know the deploy Region resolves to ${CLOUDFRONT_DELIVERY_REGION}.`,
    });
  }

  // Authorize the vended-logs delivery service to write to the bucket. With
  // BUCKET_OWNER_ENFORCED there are no ACLs, so authorization is entirely by
  // this resource policy: the SourceAccount + SourceArn conditions scope the
  // grant to THIS account's THIS distribution, preventing a confused-deputy
  // write from any other account or distribution.
  logBucket.addToResourcePolicy(
    new PolicyStatement({
      sid: 'AllowCloudFrontStandardLoggingV2',
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [logBucket.arnForObjects('*')],
      conditions: {
        StringEquals: { 'aws:SourceAccount': stack.account },
        ArnLike: { 'aws:SourceArn': distributionArn },
      },
    }),
  );

  const source = new CfnDeliverySource(scope, 'AccessLogDeliverySource', {
    name: `hosting-cf-${distributionId}`,
    logType: CLOUDFRONT_ACCESS_LOGS_TYPE,
    resourceArn: distributionArn,
  });

  const destination = new CfnDeliveryDestination(
    scope,
    'AccessLogDeliveryDestination',
    {
      name: `hosting-cf-s3-${distributionId}`,
      destinationResourceArn: logBucket.bucketArn,
      outputFormat: format,
    },
  );

  const { suffixPath, hiveCompatible } = resolveSuffixPath(partitioning);
  const delivery = new CfnDelivery(scope, 'AccessLogDelivery', {
    deliverySourceName: source.name,
    deliveryDestinationArn: destination.attrArn,
    s3SuffixPath: suffixPath,
    s3EnableHiveCompatiblePath: hiveCompatible,
  });

  // The Delivery references the source by NAME (not by ref), so CloudFormation
  // does not infer the create-order dependency; make it explicit.
  delivery.addDependency(source);
  delivery.addDependency(destination);
};
