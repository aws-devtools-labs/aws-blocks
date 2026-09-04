import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  InventoryFormat,
  InventoryFrequency,
  ObjectOwnership,
} from 'aws-cdk-lib/aws-s3';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { BUILD_STATE_TAG_KEY, BUILD_STATE_SUPERSEDED } from './build_tags.js';

// ---- Constants ----

/**
 * Retain build artifacts for 30 days by default.
 *
 * The previous 365-day default produced ~50 MB × hundreds of builds
 * per project per year — real S3 cost on every customer's bill, with
 * negligible practical value (rollback to a build older than ~30 days
 * is rare; the back-end has usually moved on so the old artifacts
 * wouldn't even work end-to-end). Customers who genuinely need long
 * rollback windows can extend via `storage.buildRetentionDays`.
 */
const DEFAULT_BUILD_RETENTION_DAYS = 30;

/**
 * Build-state tag constants (issue #480). Defined in the dependency-free
 * `build_tags` module so the esbuild-bundled KVS cutover handler can share
 * them without pulling `aws-cdk-lib` into the Lambda bundle. Re-exported here
 * for callers and tests that reason about the storage construct.
 */
export { BUILD_STATE_TAG_KEY, BUILD_STATE_SUPERSEDED } from './build_tags.js';
/** Default retention for access logs */
const DEFAULT_ACCESS_LOG_RETENTION_DAYS = 90;

// ---- Public types ----

/**
 * Props for the StorageConstruct.
 */
export type StorageConstructProps = {
  /** If true, the S3 bucket is retained on stack deletion. Default: false. */
  retainOnDelete?: boolean;
  /** Enable CloudFront access logging to a dedicated S3 bucket. Default: false. */
  accessLogging?: boolean;
  /** Encryption type for the hosting bucket. Default: S3_MANAGED. */
  encryption?: 'S3_MANAGED' | 'KMS';
  /** BYO KMS key for bucket encryption (requires encryption: 'KMS'). */
  encryptionKey?: IKey;
  /** Days to retain build artifacts in S3. Default: 365. */
  buildRetentionDays?: number;
  /** Days to retain access logs. Default: 90. */
  logRetentionDays?: number;
  /**
   * Adapter-supplied lifecycle rules for orphaned per-build data
   * (3.2). Empty / undefined → no extra rules. The default
   * `builds/` and noncurrent-version rules always run.
   */
  extraLifecycleRules?: Array<{ prefix: string; days: number }>;
  /**
   * Opt-in S3 inventory configuration (3.3). When true, a daily
   * CSV inventory of `builds/` lands in a dedicated destination
   * bucket so operators can audit per-build sizes without running
   * `aws s3 ls --summarize` per prefix. Off by default — inventory
   * costs $0.0025 per million objects listed which is negligible
   * but non-zero, and the destination bucket adds resources.
   */
  inventoryEnabled?: boolean;
};

// ---- Construct ----

/**
 * S3 storage for hosting assets: the primary hosting bucket and an optional
 * access log bucket.
 *
 * The hosting bucket is private (BLOCK_ALL), versioned, encrypted with
 * S3-managed keys (or KMS), and enforces SSL. Lifecycle rules expire old builds
 * and noncurrent versions automatically.
 */
export class StorageConstruct extends Construct {
  readonly bucket: Bucket;
  readonly accessLogBucket?: Bucket;
  /** Destination bucket for S3 inventory (3.3). Set when `inventoryEnabled`. */
  readonly inventoryBucket?: Bucket;

  /**
   * Create hosting storage with the given props.
   */
  constructor(scope: Construct, id: string, props: StorageConstructProps = {}) {
    super(scope, id);

    const retainOnDelete = props.retainOnDelete ?? false;
    const buildRetentionDays =
      props.buildRetentionDays ?? DEFAULT_BUILD_RETENTION_DAYS;

    const bucketEncryption =
      props.encryption === 'KMS'
        ? BucketEncryption.KMS
        : BucketEncryption.S3_MANAGED;

    // 3.3 — opt-in S3 inventory destination bucket. Created BEFORE
    // the hosting bucket so we can pass it as an inventory target.
    // We always co-locate the inventory bucket in the same stack /
    // region so cross-region transfer charges don't surprise users.
    if (props.inventoryEnabled) {
      this.inventoryBucket = new Bucket(this, 'InventoryBucket', {
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        encryption: BucketEncryption.S3_MANAGED,
        objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
        enforceSSL: true,
        // Inventory CSVs are operational artifacts — destroy on
        // stack delete, expire after 90 days. Keeps the audit trail
        // in reach for quarterly cost reviews without unbounded
        // growth.
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [
          {
            id: 'ExpireInventoryReports',
            expiration: Duration.days(90),
            enabled: true,
          },
        ],
      });
    }

    this.bucket = new Bucket(this, 'HostingBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: bucketEncryption,
      ...(props.encryptionKey ? { encryptionKey: props.encryptionKey } : {}),
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: retainOnDelete
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
      autoDeleteObjects: !retainOnDelete,
      // 3.3 — daily inventory of `builds/`, written as CSV into the
      // dedicated destination bucket. CDK requires
      // `inventoryId` + `destination` shape; the prefix scoping limits
      // cost (~$0.0025/M objects).
      ...(this.inventoryBucket
        ? {
            inventories: [
              {
                destination: {
                  bucket: this.inventoryBucket,
                  prefix: 'inventory/',
                },
                frequency: InventoryFrequency.DAILY,
                includeObjectVersions: undefined,
                format: InventoryFormat.CSV,
                objectsPrefix: 'builds/',
                inventoryId: 'BuildsInventory',
              },
            ],
          }
        : {}),
      lifecycleRules: [
        {
          id: 'DeleteOldBuilds',
          prefix: 'builds/',
          // #480: only expire builds explicitly marked superseded at the KVS
          // cutover. The live build (KVS meta.b) is never tagged, so it is
          // never matched by this rule and never expired — regardless of how
          // long it has been since the last deploy. TagFilters are
          // inclusion-only, so we tag the superseded builds, not the live one.
          tagFilters: { [BUILD_STATE_TAG_KEY]: BUILD_STATE_SUPERSEDED },
          expiration: Duration.days(buildRetentionDays),
          enabled: true,
        },
        {
          id: 'ExpireNoncurrentVersions',
          noncurrentVersionExpiration: Duration.days(30),
          enabled: true,
        },
        // 3.2 — Adapter-supplied lifecycle rules. Frameworks that
        // emit per-build data outside `builds/` (Next's
        // `_next/data/<id>/...`) declare expiration here. Previously
        // hardcoded as `_next/data/` with 30 days; now the adapter
        // owns it so Astro/Nuxt deploys don't carry a Next-specific
        // dead-weight rule.
        ...(props.extraLifecycleRules ?? []).map((rule, idx) => ({
          id: `AdapterLifecycle${idx}`,
          prefix: rule.prefix,
          expiration: Duration.days(rule.days),
          enabled: true,
        })),
      ],
    });

    if (props.accessLogging) {
      const logRetentionDays =
        props.logRetentionDays ?? DEFAULT_ACCESS_LOG_RETENTION_DAYS;

      // CloudFront standard logging requires ACL-based writes via the
      // awslogsdelivery canonical user. BUCKET_OWNER_ENFORCED disables ACLs
      // entirely, which would silently prevent log delivery. The hosting
      // bucket uses BUCKET_OWNER_ENFORCED (modern default) but the access
      // log bucket must use BUCKET_OWNER_PREFERRED to support CloudFront logging.
      this.accessLogBucket = new Bucket(this, 'AccessLogBucket', {
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        encryption: BucketEncryption.S3_MANAGED,
        objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [
          {
            id: 'ExpireAccessLogs',
            expiration: Duration.days(logRetentionDays),
            enabled: true,
          },
        ],
      });
    }
  }
}
