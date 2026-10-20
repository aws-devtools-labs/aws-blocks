import assert from 'node:assert';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { CdnConstruct } from './cdn_construct.js';
import { createSecurityHeadersPolicy } from './security_headers.js';
import { StorageConstruct } from './storage_construct.js';
import { HostingError } from '../hosting_error.js';
import type { DeployManifest } from '../manifest/types.js';
import { resolveSuffixPath } from './access_logging.js';

const spaManifest: DeployManifest = {
  version: 1,
  compute: {},
  staticAssets: { directory: '/tmp/assets' },
  routes: [{ pattern: '/*', target: 'static' }],
  buildId: 'test-log-1',
};

const envStack = (region = 'us-east-1', account = '123456789012'): Stack =>
  new Stack(new App(), 'TestStack', { env: { account, region } });

/** Build a CdnConstruct with a log bucket and the given logging options. */
const cdnWithLogging = (
  stack: Stack,
  logging: {
    accessLogVersion?: 'v1' | 'v2';
    accessLogPartitioning?: 'date' | 'hive';
    accessLogFormat?: 'plain' | 'w3c' | 'json' | 'parquet';
    skipLoggingRegionValidation?: boolean;
  },
): CdnConstruct => {
  const bucket = new Bucket(stack, 'Bucket');
  const logBucket = new Bucket(stack, 'LogBucket', {
    objectOwnership:
      logging.accessLogVersion === 'v2'
        ? ObjectOwnership.BUCKET_OWNER_ENFORCED
        : ObjectOwnership.BUCKET_OWNER_PREFERRED,
  });
  const policy = createSecurityHeadersPolicy(stack, 'SH', {});
  return new CdnConstruct(stack, 'Cdn', {
    bucket,
    manifest: spaManifest,
    securityHeadersPolicy: policy,
    accessLogBucket: logBucket,
    ...logging,
  });
};

void describe('access logging', () => {
  // ---- resolveSuffixPath ----

  void describe('resolveSuffixPath', () => {
    void it('date partitioning is non-hive and partitions by y/m/d/h', () => {
      const { suffixPath, hiveCompatible } = resolveSuffixPath('date');
      assert.equal(hiveCompatible, false);
      assert.equal(suffixPath, '{DistributionId}/{yyyy}/{MM}/{dd}/{HH}');
    });

    void it('hive partitioning emits key=value segments', () => {
      const { suffixPath, hiveCompatible } = resolveSuffixPath('hive');
      assert.equal(hiveCompatible, true);
      assert.match(suffixPath, /year=\{yyyy\}/);
      assert.match(suffixPath, /month=\{MM\}/);
    });
  });

  // ---- v1 (default) ----

  void describe('v1 (default legacy logging)', () => {
    void it('enables inline distribution logging and no delivery pipeline', () => {
      const stack = envStack();
      cdnWithLogging(stack, {});
      const template = Template.fromStack(stack);

      // Distribution carries the inline Logging config...
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Logging: Match.objectLike({ Bucket: Match.anyValue() }),
        }),
      });
      // ...and no v2 delivery resources exist.
      template.resourceCountIs('AWS::Logs::DeliverySource', 0);
      template.resourceCountIs('AWS::Logs::DeliveryDestination', 0);
      template.resourceCountIs('AWS::Logs::Delivery', 0);
    });
  });

  // ---- v2 ----

  void describe('v2 (standard logging v2)', () => {
    void it('provisions the delivery pipeline and omits inline logging', () => {
      const stack = envStack();
      cdnWithLogging(stack, { accessLogVersion: 'v2' });
      const template = Template.fromStack(stack);

      // The distribution must NOT set inline Logging under v2.
      const dist = Object.values(
        template.findResources('AWS::CloudFront::Distribution'),
      )[0] as { Properties: { DistributionConfig: { Logging?: unknown } } };
      assert.equal(
        dist.Properties.DistributionConfig.Logging,
        undefined,
        'v2 must not enable inline distribution logging',
      );

      // Delivery source is the distribution, typed as CloudFront access logs.
      template.hasResourceProperties('AWS::Logs::DeliverySource', {
        LogType: 'ACCESS_LOGS',
        ResourceArn: Match.anyValue(),
      });
      // Delivery destination is the log bucket; default format is w3c.
      template.hasResourceProperties('AWS::Logs::DeliveryDestination', {
        OutputFormat: 'w3c',
        DestinationResourceArn: Match.anyValue(),
      });
      // Delivery binds them with date partitioning by default.
      template.hasResourceProperties('AWS::Logs::Delivery', {
        S3SuffixPath: '{DistributionId}/{yyyy}/{MM}/{dd}/{HH}',
        S3EnableHiveCompatiblePath: false,
      });
    });

    void it('grants the delivery service principal write access to the bucket', () => {
      const stack = envStack();
      cdnWithLogging(stack, { accessLogVersion: 'v2' });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Principal: { Service: 'delivery.logs.amazonaws.com' },
              Action: 's3:PutObject',
            }),
          ]),
        }),
      });
    });

    void it('scopes the grant to this account and this delivery source', () => {
      const stack = envStack();
      cdnWithLogging(stack, { accessLogVersion: 'v2' });
      const template = Template.fromStack(stack);
      const [sourceId] = Object.keys(
        template.findResources('AWS::Logs::DeliverySource'),
      );

      // Vended-logs delivery writes as the DELIVERY SOURCE
      // (arn:<partition>:logs:us-east-1:<account>:delivery-source:<name>), not
      // as the distribution, so SourceArn must be the delivery-source ARN.
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowCloudFrontStandardLoggingV2',
              Condition: {
                StringEquals: { 'aws:SourceAccount': '123456789012' },
                ArnLike: {
                  'aws:SourceArn': { 'Fn::GetAtt': [sourceId, 'Arn'] },
                },
              },
            }),
          ]),
        }),
      });
    });

    void it('creates the delivery after the source and the bucket policy', () => {
      const stack = envStack();
      cdnWithLogging(stack, { accessLogVersion: 'v2' });
      const template = Template.fromStack(stack);
      const [sourceId] = Object.keys(
        template.findResources('AWS::Logs::DeliverySource'),
      );
      const [policyId] = Object.keys(
        template.findResources('AWS::S3::BucketPolicy', {
          Properties: {
            PolicyDocument: {
              Statement: Match.arrayWith([
                Match.objectLike({ Sid: 'AllowCloudFrontStandardLoggingV2' }),
              ]),
            },
          },
        }),
      );
      assert.ok(policyId, 'the v2 log-bucket policy should exist');

      const delivery = Object.values(
        template.findResources('AWS::Logs::Delivery'),
      )[0] as { DependsOn?: string[] };
      assert.ok(delivery.DependsOn?.includes(sourceId));
      assert.ok(
        delivery.DependsOn?.includes(policyId),
        'the delivery must wait for the bucket policy that authorizes its writes',
      );
    });

    void it('honors partitioning and format options', () => {
      const stack = envStack();
      cdnWithLogging(stack, {
        accessLogVersion: 'v2',
        accessLogPartitioning: 'hive',
        accessLogFormat: 'parquet',
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Logs::DeliveryDestination', {
        OutputFormat: 'parquet',
      });
      template.hasResourceProperties('AWS::Logs::Delivery', {
        S3EnableHiveCompatiblePath: true,
      });
    });

    void it('throws outside us-east-1 (delivery-source Region constraint)', () => {
      const stack = envStack('eu-west-1');
      assert.throws(
        () => cdnWithLogging(stack, { accessLogVersion: 'v2' }),
        (err: unknown) =>
          err instanceof HostingError &&
          err.name === 'LoggingV2RegionError',
      );
    });

    void it('skipLoggingRegionValidation opts out of the us-east-1 check', () => {
      const stack = envStack('eu-west-1');
      assert.doesNotThrow(() =>
        cdnWithLogging(stack, {
          accessLogVersion: 'v2',
          skipLoggingRegionValidation: true,
        }),
      );
      Template.fromStack(stack).resourceCountIs('AWS::Logs::DeliverySource', 1);
      Annotations.fromStack(stack).hasNoWarning(
        '*',
        Match.stringLikeRegexp('LoggingV2RegionUnresolved'),
      );
    });

    void it('warns instead of throwing when the stack Region is an unresolved token', () => {
      // No `env`: stack.region is the AWS::Region pseudo-parameter token.
      const stack = new Stack(new App(), 'EnvAgnosticStack');
      assert.doesNotThrow(() =>
        cdnWithLogging(stack, { accessLogVersion: 'v2' }),
      );
      Annotations.fromStack(stack).hasWarning(
        '*',
        Match.stringLikeRegexp('LoggingV2RegionUnresolved'),
      );
    });

    void it('does not warn when the stack Region is resolved to us-east-1', () => {
      const stack = envStack();
      cdnWithLogging(stack, { accessLogVersion: 'v2' });
      Annotations.fromStack(stack).hasNoWarning(
        '*',
        Match.stringLikeRegexp('LoggingV2RegionUnresolved'),
      );
    });
  });

  // ---- storage bucket ownership ----

  void describe('StorageConstruct access-log bucket ownership', () => {
    // The access-log bucket is uniquely identified by its `ExpireAccessLogs`
    // lifecycle rule (the primary hosting bucket also sets OwnershipControls,
    // so we can't select on that alone).
    const ownership = (version: 'v1' | 'v2'): string => {
      const stack = envStack();
      new StorageConstruct(stack, 'Storage', {
        accessLogging: true,
        accessLogVersion: version,
      });
      const template = Template.fromStack(stack);
      type BucketProps = {
        Properties: {
          OwnershipControls?: { Rules: { ObjectOwnership: string }[] };
          LifecycleConfiguration?: { Rules: { Id?: string }[] };
        };
      };
      const logBucket = Object.values(
        template.findResources('AWS::S3::Bucket'),
      ).find((b) =>
        (b as BucketProps).Properties.LifecycleConfiguration?.Rules.some(
          (r) => r.Id === 'ExpireAccessLogs',
        ),
      ) as BucketProps | undefined;
      assert.ok(logBucket, 'access-log bucket should exist');
      assert.ok(logBucket.Properties.OwnershipControls);
      return logBucket.Properties.OwnershipControls.Rules[0].ObjectOwnership;
    };

    void it('v1 keeps ACLs (BucketOwnerPreferred)', () => {
      assert.equal(ownership('v1'), 'BucketOwnerPreferred');
    });

    void it('v2 disables ACLs (BucketOwnerEnforced)', () => {
      assert.equal(ownership('v2'), 'BucketOwnerEnforced');
    });
  });
});
