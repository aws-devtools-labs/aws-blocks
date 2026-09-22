import { describe, it } from 'node:test';
import assert from 'node:assert';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Key } from 'aws-cdk-lib/aws-kms';
import {
  StorageConstruct,
  BUILD_STATE_TAG_KEY,
  BUILD_STATE_SUPERSEDED,
} from './storage_construct.js';

// ---- Test helpers ----

const createStack = (): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack');
};

// ================================================================
// StorageConstruct — isolated unit tests
// ================================================================

void describe('StorageConstruct', () => {
  // ---- Default bucket security ----

  void describe('default S3 bucket', () => {
    void it('creates bucket with BlockPublicAccess.BLOCK_ALL', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    void it('enables versioning', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        VersioningConfiguration: { Status: 'Enabled' },
      });
    });

    void it('uses SSE-S3 encryption', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
      });
    });

    void it('enforces SSL via bucket policy', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      // CDK enforceSSL adds a bucket policy denying non-SSL requests
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: Match.objectLike({
                // eslint-disable-next-line spellcheck/spell-checker
                Bool: { 'aws:SecureTransport': 'false' },
              }),
            }),
          ]),
        }),
      });
    });
  });

  // ---- Lifecycle rules ----

  void describe('lifecycle rules', () => {
    void it('sets default build retention of 30 days', () => {
      // P2.1: default lowered from 365 → 30 days. Customers who need
      // longer rollback windows must opt in via
      // `storage.buildRetentionDays`. The previous default produced
      // ~50 MB × hundreds of builds/year of S3 with negligible
      // practical value (rollback >30 days back is rare and the
      // back-end has usually moved on).
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'DeleteOldBuilds',
              Prefix: 'builds/',
              ExpirationInDays: 30,
              Status: 'Enabled',
            }),
          ]),
        }),
      });
    });

    void it('sets noncurrent version expiration to 30 days', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'ExpireNoncurrentVersions',
              NoncurrentVersionExpiration: {
                NoncurrentDays: 30,
              },
              Status: 'Enabled',
            }),
          ]),
        }),
      });
    });
  });

  // ---- Retain on delete ----

  void describe('retainOnDelete', () => {
    void it('sets RemovalPolicy.RETAIN when retainOnDelete is true', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', { retainOnDelete: true });
      const template = Template.fromStack(stack);

      // With RETAIN, DeletionPolicy is Retain
      const buckets = template.findResources('AWS::S3::Bucket');
      const hostingBucket = Object.entries(buckets).find(([key]) =>
        key.includes('HostingBucket'),
      );
      assert.ok(hostingBucket, 'Should find HostingBucket');
      assert.strictEqual(
        (hostingBucket[1] as Record<string, unknown>).DeletionPolicy,
        'Retain',
        'DeletionPolicy should be Retain',
      );
    });

    void it('sets RemovalPolicy.DESTROY when retainOnDelete is false (default)', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      const buckets = template.findResources('AWS::S3::Bucket');
      const hostingBucket = Object.entries(buckets).find(([key]) =>
        key.includes('HostingBucket'),
      );
      assert.ok(hostingBucket, 'Should find HostingBucket');
      assert.strictEqual(
        (hostingBucket[1] as Record<string, unknown>).DeletionPolicy,
        'Delete',
        'DeletionPolicy should be Delete',
      );
    });
  });

  // ---- Access logging ----

  void describe('access logging', () => {
    void it('creates access log bucket when accessLogging is true', () => {
      const stack = createStack();
      const storage = new StorageConstruct(stack, 'Storage', {
        accessLogging: true,
      });
      const template = Template.fromStack(stack);

      assert.ok(storage.accessLogBucket, 'Should expose accessLogBucket');
      // 2 buckets: hosting + access log
      template.resourceCountIs('AWS::S3::Bucket', 2);
    });

    void it('sets default access log retention to 90 days', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', { accessLogging: true });
      const template = Template.fromStack(stack);

      // Find the access log bucket via lifecycle rule ID
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'ExpireAccessLogs',
              ExpirationInDays: 90,
              Status: 'Enabled',
            }),
          ]),
        }),
      });
    });

    void it('does not create access log bucket when accessLogging is false (default)', () => {
      const stack = createStack();
      const storage = new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      assert.strictEqual(
        storage.accessLogBucket,
        undefined,
        'accessLogBucket should be undefined',
      );
      // Only the hosting bucket (+ CDK autoDeleteObjects custom resource bucket if any)
      // At minimum: just 1 S3 bucket
      const buckets = template.findResources('AWS::S3::Bucket');
      const accessLogBuckets = Object.entries(buckets).filter(([key]) =>
        key.includes('AccessLogBucket'),
      );
      assert.strictEqual(
        accessLogBuckets.length,
        0,
        'Should not have AccessLogBucket',
      );
    });
  });

  // ---- KMS encryption ----

  void describe('encryption', () => {
    void it('uses S3_MANAGED encryption by default', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
      });
    });

    void it('uses S3_MANAGED encryption when explicitly set', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', { encryption: 'S3_MANAGED' });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
      });
    });

    void it('uses KMS encryption when encryption is KMS', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', { encryption: 'KMS' });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'aws:kms',
              },
            },
          ],
        },
      });
    });

    void it('uses BYO KMS key when encryptionKey is provided', () => {
      const stack = createStack();
      const key = new Key(stack, 'MyKey');
      new StorageConstruct(stack, 'Storage', {
        encryption: 'KMS',
        encryptionKey: key,
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: Match.objectLike({
                SSEAlgorithm: 'aws:kms',
                KMSMasterKeyID: Match.anyValue(),
              }),
            },
          ],
        },
      });
    });
  });

  // ---- buildRetentionDays ----

  void describe('buildRetentionDays', () => {
    void it('uses custom build retention days', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', { buildRetentionDays: 90 });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'DeleteOldBuilds',
              Prefix: 'builds/',
              ExpirationInDays: 90,
              Status: 'Enabled',
            }),
          ]),
        }),
      });
    });

    void it('defaults to 30 days when not specified', () => {
      // P2.1 default. See "sets default build retention of 30 days"
      // above for the rationale.
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'DeleteOldBuilds',
              ExpirationInDays: 30,
            }),
          ]),
        }),
      });
    });
  });

  // ---- logRetentionDays ----

  void describe('logRetentionDays', () => {
    void it('uses custom log retention days for access log bucket', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', {
        accessLogging: true,
        logRetentionDays: 30,
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'ExpireAccessLogs',
              ExpirationInDays: 30,
              Status: 'Enabled',
            }),
          ]),
        }),
      });
    });

    void it('defaults to 90 days for access log bucket', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', { accessLogging: true });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'ExpireAccessLogs',
              ExpirationInDays: 90,
            }),
          ]),
        }),
      });
    });
  });

  // ---- SSL enforcement ----

  void describe('SSL enforcement', () => {
    void it('creates bucket with enforceSSL (bucket policy with SecureTransport)', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: {
                // eslint-disable-next-line spellcheck/spell-checker
                Bool: { 'aws:SecureTransport': 'false' },
              },
            }),
          ]),
        }),
      });
    });
  });

  // ---- Versioning ----

  void describe('versioning', () => {
    void it('enables versioning on the hosting bucket', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        VersioningConfiguration: {
          Status: 'Enabled',
        },
      });
    });
  });

  // ---- ISR lifecycle rule ----

  void describe('adapter-supplied lifecycle (3.2)', () => {
    void it('emits adapter lifecycle rules from extraLifecycleRules', () => {
      // 3.2: framework-specific orphan-data rules are now declared
      // by the adapter (Next: `_next/data/`), not hardcoded in the
      // storage construct. The construct emits one
      // `AdapterLifecycle<idx>` rule per entry.
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', {
        extraLifecycleRules: [{ prefix: '_next/data/', days: 30 }],
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'AdapterLifecycle0',
              Prefix: '_next/data/',
              ExpirationInDays: 30,
              Status: 'Enabled',
            }),
          ]),
        }),
      });
    });

    void it('emits no adapter rules when extraLifecycleRules is empty', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage');
      const template = Template.fromStack(stack);
      const buckets = template.findResources('AWS::S3::Bucket');
      // The CFN template uses PascalCase property names, so we
      // serialize and grep for the AdapterLifecycle id token rather
      // than thread typed paths through naming-convention rules.
      const json = JSON.stringify(Object.values(buckets));
      const matches = json.match(/AdapterLifecycle\d+/g) ?? [];
      assert.strictEqual(matches.length, 0);
    });
  });

  // ---- Access log bucket security ----

  void describe('access log bucket security', () => {
    void it('access log bucket has BlockPublicAccess.BLOCK_ALL', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', { accessLogging: true });
      const template = Template.fromStack(stack);

      // Both hosting and access log bucket should have BLOCK_ALL
      const buckets = template.findResources('AWS::S3::Bucket');
      const accessLogBucket = Object.entries(buckets).find(([key]) =>
        key.includes('AccessLogBucket'),
      );
      assert.ok(accessLogBucket, 'Should find AccessLogBucket');
      const props = (
        accessLogBucket[1] as Record<string, Record<string, unknown>>
      ).Properties;
      const pab = props?.PublicAccessBlockConfiguration as
        | Record<string, boolean>
        | undefined;
      assert.strictEqual(pab?.BlockPublicAcls, true);
      assert.strictEqual(pab?.BlockPublicPolicy, true);
      assert.strictEqual(pab?.IgnorePublicAcls, true);
      assert.strictEqual(pab?.RestrictPublicBuckets, true);
    });

    void it('access log bucket uses S3_MANAGED encryption', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', { accessLogging: true });
      const template = Template.fromStack(stack);

      const buckets = template.findResources('AWS::S3::Bucket');
      const accessLogBucket = Object.entries(buckets).find(([key]) =>
        key.includes('AccessLogBucket'),
      );
      assert.ok(accessLogBucket, 'Should find AccessLogBucket');
      const props = (
        accessLogBucket[1] as Record<string, Record<string, unknown>>
      ).Properties;
      const encryption = props?.BucketEncryption as Record<string, unknown[]>;
      const config = encryption?.ServerSideEncryptionConfiguration as Array<
        Record<string, Record<string, string>>
      >;
      assert.strictEqual(
        config?.[0]?.ServerSideEncryptionByDefault?.SSEAlgorithm,
        'AES256',
      );
    });

    void it('access log bucket uses BUCKET_OWNER_PREFERRED for CloudFront log delivery', () => {
      const stack = createStack();
      new StorageConstruct(stack, 'Storage', { accessLogging: true });
      const template = Template.fromStack(stack);

      const buckets = template.findResources('AWS::S3::Bucket');
      const accessLogBucket = Object.entries(buckets).find(([key]) =>
        key.includes('AccessLogBucket'),
      );
      assert.ok(accessLogBucket, 'Should find AccessLogBucket');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const props = (accessLogBucket[1] as any).Properties;
      assert.strictEqual(
        props?.OwnershipControls?.Rules?.[0]?.ObjectOwnership,
        'BucketOwnerPreferred',
      );
    });
  });
});

// #480: DeleteOldBuilds must only expire builds tagged SUPERSEDED, so the
// live build (KVS meta.b) — which is never tagged — is never expired,
// regardless of deploy cadence. This is the core regression guard.
void describe('DeleteOldBuilds excludes the live build (#480)', () => {
  void it('scopes DeleteOldBuilds to the superseded tag filter', () => {
    const stack = createStack();
    new StorageConstruct(stack, 'Storage');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'DeleteOldBuilds',
            Prefix: 'builds/',
            Status: 'Enabled',
            TagFilters: Match.arrayWith([
              { Key: BUILD_STATE_TAG_KEY, Value: BUILD_STATE_SUPERSEDED },
            ]),
          }),
        ]),
      }),
    });
  });

  void it('exposes the superseded tag constants (shared with the cutover handler)', () => {
    assert.strictEqual(BUILD_STATE_TAG_KEY, 'aws-blocks:build-state');
    assert.strictEqual(BUILD_STATE_SUPERSEDED, 'superseded');
  });
});
