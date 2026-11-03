import { describe, it } from 'node:test';
import assert from 'node:assert';
import { App, Stack } from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { DnsConstruct } from './dns_construct.js';
import { HostingError } from '../hosting_error.js';

// ---- Test helpers ----

/**
 * Create a stack with explicit env (required for HostedZone.fromLookup).
 */
const createEnvStack = (
  region = 'us-east-1',
  account = '123456789012',
): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack', { env: { account, region } });
};

/**
 * Create a minimal CloudFront distribution for testing DNS records.
 */
const createDistribution = (stack: Stack): Distribution => {
  const bucket = new Bucket(stack, 'DistBucket');
  return new Distribution(stack, 'TestDist', {
    defaultBehavior: {
      origin: S3BucketOrigin.withOriginAccessControl(bucket),
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    },
  });
};

// ================================================================
// DnsConstruct — isolated unit tests
// ================================================================

void describe('DnsConstruct', () => {
  // ---- Certificate creation ----

  void describe('certificate creation', () => {
    void it('creates DnsValidatedCertificate when no BYO cert provided', () => {
      const stack = createEnvStack();
      const dns = new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
      });

      assert.ok(dns.certificate, 'Should have certificate');
      const template = Template.fromStack(stack);

      // DnsValidatedCertificate creates a custom resource
      const customResources = template.findResources(
        'AWS::CloudFormation::CustomResource',
      );
      const certResources = Object.entries(customResources).filter(([, r]) => {
        const props = (r as Record<string, Record<string, unknown>>).Properties;
        return props?.DomainName === 'www.example.com';
      });
      assert.ok(
        certResources.length > 0,
        'Should create DnsValidatedCertificate custom resource',
      );
    });

    void it('uses BYO certificate when provided', () => {
      const stack = createEnvStack();
      const byoCert = Certificate.fromCertificateArn(
        stack,
        'ImportedCert',
        'arn:aws:acm:us-east-1:123456789012:certificate/abc-123',
      );

      const dns = new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
        certificate: byoCert,
      });

      assert.ok(dns.certificate, 'Should have certificate');

      const template = Template.fromStack(stack);

      // No DnsValidatedCertificate custom resource should be created
      const customResources = template.findResources(
        'AWS::CloudFormation::CustomResource',
      );
      const certResources = Object.entries(customResources).filter(([, r]) => {
        const props = (r as Record<string, Record<string, unknown>>).Properties;
        return props?.DomainName === 'www.example.com';
      });
      assert.strictEqual(
        certResources.length,
        0,
        'Should NOT create DnsValidatedCertificate when BYO cert is provided',
      );
    });
  });

  // ---- Certificate region validation ----

  void describe('certificate region validation', () => {
    void it('throws HostingError for non-us-east-1 certificate ARN', () => {
      const stack = createEnvStack();
      const nonUsEast1Cert = Certificate.fromCertificateArn(
        stack,
        'BadCert',
        'arn:aws:acm:eu-west-1:123456789012:certificate/bad-cert',
      );

      assert.throws(
        () =>
          new DnsConstruct(stack, 'Dns', {
            domainName: 'www.example.com',
            hostedZone: 'example.com',
            certificate: nonUsEast1Cert,
          }),
        (err: unknown) => {
          assert.ok(err instanceof HostingError);
          assert.strictEqual(err.name, 'InvalidCertificateRegionError');
          assert.ok(err.resolution);
          return true;
        },
      );
    });

    void it('accepts us-east-1 certificate ARN', () => {
      const stack = createEnvStack();
      const cert = Certificate.fromCertificateArn(
        stack,
        'GoodCert',
        'arn:aws:acm:us-east-1:123456789012:certificate/good-cert',
      );

      const dns = new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
        certificate: cert,
      });
      assert.ok(dns.certificate, 'Should accept us-east-1 cert');
    });

    void it('skips region check with skipRegionValidation', () => {
      const stack = createEnvStack();
      const nonUsEast1Cert = Certificate.fromCertificateArn(
        stack,
        'SkippedCert',
        'arn:aws:acm:eu-west-1:123456789012:certificate/skip-cert',
      );

      const dns = new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
        certificate: nonUsEast1Cert,
        skipRegionValidation: true,
      });
      assert.ok(
        dns.certificate,
        'Should accept non-us-east-1 cert when skip is true',
      );
    });
  });

  // ---- Domain name validation ----

  void describe('domain name validation', () => {
    void it('accepts subdomain of hosted zone', () => {
      const stack = createEnvStack();
      const dns = new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
      });
      assert.ok(dns.certificate, 'Should accept valid subdomain');
    });

    void it('accepts multi-level subdomain of hosted zone', () => {
      const stack = createEnvStack();
      const dns = new DnsConstruct(stack, 'Dns', {
        domainName: 'app.staging.example.com',
        hostedZone: 'example.com',
      });
      assert.ok(dns.certificate, 'Should accept multi-level subdomain');
    });

    void it('rejects domain not within hosted zone (suffix attack)', () => {
      assert.throws(
        () => {
          const stack = createEnvStack();
          new DnsConstruct(stack, 'Dns', {
            domainName: 'evilexample.com',
            hostedZone: 'example.com',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof HostingError);
          assert.strictEqual(err.name, 'InvalidDomainConfigError');
          return true;
        },
      );
    });

    void it('rejects completely unrelated domain', () => {
      assert.throws(
        () => {
          const stack = createEnvStack();
          new DnsConstruct(stack, 'Dns', {
            domainName: 'app.other.com',
            hostedZone: 'example.com',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof HostingError);
          assert.strictEqual(err.name, 'InvalidDomainConfigError');
          return true;
        },
      );
    });
  });

  // ---- Hosted zone lookup ----

  void describe('hosted zone lookup', () => {
    void it('exposes hostedZone property', () => {
      const stack = createEnvStack();
      const dns = new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
      });

      assert.ok(dns.hostedZone, 'Should expose hostedZone');
    });
  });

  // ---- DNS records ----

  void describe('createDnsRecords', () => {
    void it('creates A and AAAA records when distribution is passed to constructor', () => {
      const stack = createEnvStack();
      const distribution = createDistribution(stack);

      new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
        distribution,
      });

      const template = Template.fromStack(stack);
      const records = template.findResources('AWS::Route53::RecordSet');
      const recordTypes = Object.values(records).map(
        (r) => (r as Record<string, Record<string, unknown>>).Properties?.Type,
      );
      assert.ok(recordTypes.includes('A'), 'Should have an A record');
      assert.ok(recordTypes.includes('AAAA'), 'Should have an AAAA record');
    });

    void it('creates A and AAAA records when calling createDnsRecords() after construction', () => {
      const stack = createEnvStack();
      const distribution = createDistribution(stack);

      const dns = new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
      });

      // Call createDnsRecords post-construction
      dns.createDnsRecords(distribution);

      const template = Template.fromStack(stack);
      const records = template.findResources('AWS::Route53::RecordSet');
      const recordTypes = Object.values(records).map(
        (r) => (r as Record<string, Record<string, unknown>>).Properties?.Type,
      );
      assert.ok(recordTypes.includes('A'), 'Should have an A record');
      assert.ok(recordTypes.includes('AAAA'), 'Should have an AAAA record');
    });

    void it('does not create DNS records when distribution is not provided', () => {
      const stack = createEnvStack();

      new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    });

    void it('throws DuplicateDnsRecordsError when createDnsRecords() is called twice', () => {
      const stack = createEnvStack();
      const distribution = createDistribution(stack);

      const dns = new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
      });

      dns.createDnsRecords(distribution);

      assert.throws(
        () => dns.createDnsRecords(distribution),
        (err: unknown) => {
          assert.ok(err instanceof HostingError);
          assert.strictEqual(err.name, 'DuplicateDnsRecordsError');
          return true;
        },
      );
    });

    void it('throws DuplicateDnsRecordsError when distribution passed to constructor and createDnsRecords() called after', () => {
      const stack = createEnvStack();
      const distribution = createDistribution(stack);

      const dns = new DnsConstruct(stack, 'Dns', {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
        distribution,
      });

      assert.throws(
        () => dns.createDnsRecords(distribution),
        (err: unknown) => {
          assert.ok(err instanceof HostingError);
          assert.strictEqual(err.name, 'DuplicateDnsRecordsError');
          return true;
        },
      );
    });
  });
});
