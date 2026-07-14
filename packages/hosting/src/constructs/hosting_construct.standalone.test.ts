import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostingConstruct } from './hosting_construct.js';
import { DeployManifest } from '../manifest/types.js';
import { secret } from '../secret.js';

// ---- Test helpers ----

const createStack = (): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack');
};

const createEnvStack = (
  region = 'us-east-1',
  account = '123456789012',
): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack', { env: { account, region } });
};

// ================================================================
// Standalone CDK usage (standalone CDK)
// ================================================================

void describe('Standalone CDK usage (standalone CDK)', () => {
  let tmpDir: string;
  let staticDir: string;
  let bundleDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-standalone-test-'));
    staticDir = path.join(tmpDir, 'static');
    bundleDir = path.join(tmpDir, 'bundle');

    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<html></html>');

    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, 'index.mjs'),
      'export const handler = async () => {};',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const spaManifest: DeployManifest = {
    version: 1,
    compute: {},
    staticAssets: { directory: '' }, // will be replaced
    routes: [{ pattern: '/*', target: 'static' }],
    buildId: 'standalone-spa-1',
  };

  const makeSpaManifest = (): DeployManifest => ({
    ...spaManifest,
    staticAssets: { directory: staticDir },
  });

  const makeSsrManifest = (): DeployManifest => ({
    version: 1,
    compute: {
      default: {
        type: 'handler',
        bundle: bundleDir,
        handler: 'index.handler',
        placement: 'regional',
        streaming: true,
        runtime: 'nodejs20.x',
      },
    },
    staticAssets: { directory: staticDir },
    routes: [
      { pattern: '/_next/static/*', target: 'static' },
      { pattern: '/favicon.ico', target: 'static' },
      { pattern: '/*', target: 'default' },
    ],
    buildId: 'standalone-ssr-1',
  });

  // ---- SPA hosting ----

  void describe('SPA hosting', () => {
    void it('synthesizes a valid CloudFormation template', () => {
      const stack = createStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
      const buckets = template.findResources('AWS::S3::Bucket');
      assert.ok(Object.keys(buckets).length >= 1);
    });

    void it('creates S3 bucket with correct security settings', () => {
      const stack = createStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
      });

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

    void it('creates CloudFront distribution with HTTPS redirect', () => {
      const stack = createStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties(
        'AWS::CloudFront::Distribution',
        Match.objectLike({
          DistributionConfig: Match.objectLike({
            DefaultCacheBehavior: Match.objectLike({
              ViewerProtocolPolicy: 'redirect-to-https',
            }),
          }),
        }),
      );
    });

    void it('handles SPA 404 routing to index.html', () => {
      const stack = createStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
      });

      const template = Template.fromStack(stack);
      // SPA fallback is now handled in the viewer-request CloudFront
      // Function — extensionless requests rewrite to /index.html before
      // reaching S3, so missing assets correctly 403 without a blanket
      // fallback. Verify the function is attached to the default behavior.
      template.hasResourceProperties(
        'AWS::CloudFront::Distribution',
        Match.objectLike({
          DistributionConfig: Match.objectLike({
            DefaultCacheBehavior: Match.objectLike({
              FunctionAssociations: Match.arrayWith([
                Match.objectLike({
                  EventType: 'viewer-request',
                }),
              ]),
            }),
          }),
        }),
      );
    });
  });

  // ---- SSR hosting ----

  void describe('SSR hosting', () => {
    void it('creates Lambda function for handler type (no Web Adapter)', () => {
      const stack = createStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSsrManifest(),
        skipRegionValidation: true,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
      });
    });

    void it('fronts SSR Lambda with REGIONAL API Gateway REST API + STREAM mode', () => {
      const stack = createStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSsrManifest(),
        skipRegionValidation: true,
      });

      const template = Template.fromStack(stack);
      // SSR uses API Gateway REST + lambda:InvokeFunction (no body re-hash),
      // not a Function URL — see PR for SigV4 + body-hash background.
      template.resourceCountIs('AWS::Lambda::Url', 0);
      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        EndpointConfiguration: Match.objectLike({ Types: ['REGIONAL'] }),
      });
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'ANY',
        Integration: Match.objectLike({ Type: 'AWS_PROXY' }),
      });
    });

    void it('creates error page deployment for SSR', () => {
      const stack = createStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSsrManifest(),
        skipRegionValidation: true,
      });

      const template = Template.fromStack(stack);
      const deployments = template.findResources('Custom::CDKBucketDeployment');
      assert.ok(
        Object.keys(deployments).length >= 2,
        'Should have at least 2 BucketDeployments (assets + error page)',
      );
    });

    void it('splits asset deployment into immutable + mutable when manifest declares immutablePaths', () => {
      const stack = createStack();
      const manifest = makeSpaManifest();
      manifest.staticAssets = {
        directory: staticDir,
        immutablePaths: ['_next/static/*'],
      };
      new HostingConstruct(stack, 'Hosting', { manifest });

      const template = Template.fromStack(stack);
      const deployments = template.findResources('Custom::CDKBucketDeployment');
      // Two BucketDeployments: AssetDeploymentImmutable + AssetDeploymentMutable.
      const ids = Object.keys(deployments);
      const immutable = ids.find((id) => id.includes('Immutable'));
      const mutable = ids.find((id) => id.includes('Mutable'));
      assert.ok(immutable, 'Immutable deployment present');
      assert.ok(mutable, 'Mutable deployment present');
      // Hashed paths get long-lived immutable Cache-Control.
      assert.match(
        JSON.stringify(deployments[immutable!].Properties),
        /max-age=31536000.*immutable/,
      );
      // Everything else gets the short-lived must-revalidate header so a
      // redeploy invalidates cached HTML on next request.
      assert.match(
        JSON.stringify(deployments[mutable!].Properties),
        /max-age=0.*must-revalidate/,
      );
    });

    void it('splits HTML into separate deployment with no-cache when immutablePaths absent', () => {
      const stack = createStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
      });

      const template = Template.fromStack(stack);
      const deployments = template.findResources('Custom::CDKBucketDeployment');
      const ids = Object.keys(deployments);
      const htmlDeploy = ids.find((id) => id.includes('AssetDeploymentHtml'));
      assert.ok(htmlDeploy, 'AssetDeploymentHtml present');
      // HTML files get no-cache so browsers always revalidate on redeploy.
      assert.match(
        JSON.stringify(deployments[htmlDeploy!].Properties),
        /no-cache.*must-revalidate/,
      );
      // Non-HTML gets mutable cache (s-maxage for CDN, max-age=0 for browser).
      const otherDeploy = ids.find((id) => id.includes('AssetDeploymentOther'));
      assert.ok(otherDeploy, 'AssetDeploymentOther present');
      assert.match(
        JSON.stringify(deployments[otherDeploy!].Properties),
        /max-age=0.*must-revalidate/,
      );
    });

    void it('emits a per-extension Content-Type pass for fonts present in the static dir', () => {
      // Font Content-Type via per-extension BucketDeployment. S3
      // stores fonts as `binary/octet-stream` by default; this pass
      // re-uploads the matching files with the right MIME so browsers
      // accept them under CORS. One BucketDeployment per extension,
      // each emitted only when at least one file with that extension
      // exists in the static dir (so projects without fonts pay zero
      // overhead).
      fs.writeFileSync(path.join(staticDir, 'inter.woff2'), 'fake');
      fs.writeFileSync(path.join(staticDir, 'inter.woff'), 'fake');
      const stack = createStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
      });

      const template = Template.fromStack(stack);
      const deployments = template.findResources('Custom::CDKBucketDeployment');
      const ids = Object.keys(deployments);
      const fontDeployments = ids.filter((id) =>
        id.includes('FontTypeDeployment'),
      );
      assert.equal(fontDeployments.length, 2, '2 font extensions detected');
      const json = JSON.stringify(
        fontDeployments.map((id) => deployments[id].Properties),
      );
      assert.match(json, /font\/woff2/);
      assert.match(json, /font\/woff(?!2)/);
    });

    void it('emits no font Content-Type pass when the static dir contains no fonts', () => {
      const stack = createStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
      });
      const template = Template.fromStack(stack);
      const deployments = template.findResources('Custom::CDKBucketDeployment');
      const fontDeployments = Object.keys(deployments).filter((id) =>
        id.includes('FontTypeDeployment'),
      );
      assert.equal(fontDeployments.length, 0);
    });

    void it('honors staticAssets.cacheControl override on the mutable deployment', () => {
      const stack = createStack();
      const manifest = makeSpaManifest();
      manifest.staticAssets = {
        directory: staticDir,
        cacheControl: 'public, max-age=60',
      };
      new HostingConstruct(stack, 'Hosting', { manifest });

      const template = Template.fromStack(stack);
      const deployments = template.findResources('Custom::CDKBucketDeployment');
      const ids = Object.keys(deployments);
      // The cacheControl override applies to the non-HTML "Other" deployment.
      const otherDeploy = ids.find((id) => id.includes('AssetDeploymentOther'));
      assert.ok(otherDeploy, 'AssetDeploymentOther present');
      assert.match(
        JSON.stringify(deployments[otherDeploy!].Properties),
        /public, max-age=60/,
      );
    });

    void it('provisions cache infrastructure when manifest declares cache', () => {
      const stack = createStack();
      const manifest = {
        ...makeSsrManifest(),
        cache: {
          computeResource: 'default',
          tagRevalidation: true,
          revalidationQueue: true,
        },
      };

      const construct = new HostingConstruct(stack, 'Hosting', {
        manifest,
        skipRegionValidation: true,
      });

      assert.ok(construct.cacheBucket);
      assert.ok(construct.cacheTable);
      assert.ok(construct.revalidationQueue);

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::DynamoDB::Table', 1);
      template.resourceCountIs('AWS::SQS::Queue', 2);
    });
  });

  // ---- Custom domain ----

  void describe('Custom domain', () => {
    void it('accepts pre-created certificate (BYO cert)', () => {
      const stack = createEnvStack();
      const byoCert = Certificate.fromCertificateArn(
        stack,
        'ImportedCert',
        'arn:aws:acm:us-east-1:123456789012:certificate/abc-123',
      );

      const construct = new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
        domain: {
          domainName: 'www.example.com',
          hostedZone: 'example.com',
          certificate: byoCert,
        },
      });

      assert.ok(construct.certificate);
      const template = Template.fromStack(stack);
      template.hasResourceProperties(
        'AWS::CloudFront::Distribution',
        Match.objectLike({
          DistributionConfig: Match.objectLike({
            Aliases: ['www.example.com'],
          }),
        }),
      );
    });

    void it('creates A and AAAA records', () => {
      const stack = createEnvStack();
      const byoCert = Certificate.fromCertificateArn(
        stack,
        'ImportedCert',
        'arn:aws:acm:us-east-1:123456789012:certificate/abc-123',
      );

      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
        domain: {
          domainName: 'www.example.com',
          hostedZone: 'example.com',
          certificate: byoCert,
        },
      });

      const template = Template.fromStack(stack);
      const records = template.findResources('AWS::Route53::RecordSet');
      const recordTypes = Object.values(records).map(
        (r) => (r as Record<string, Record<string, unknown>>).Properties?.Type,
      );
      assert.ok(recordTypes.includes('A'));
      assert.ok(recordTypes.includes('AAAA'));
    });
  });

  // ---- WAF ----

  void describe('WAF', () => {
    void it('creates WebACL when waf.enabled is true', () => {
      const stack = createStack();
      const construct = new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
        waf: { enabled: true },
      });

      assert.ok(construct.webAcl);
      const template = Template.fromStack(stack);
      template.hasResourceProperties(
        'AWS::WAFv2::WebACL',
        Match.objectLike({
          Scope: 'CLOUDFRONT',
        }),
      );
    });

    void it('does not create WebACL when waf is not configured', () => {
      const stack = createStack();
      const construct = new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
      });

      assert.strictEqual(construct.webAcl, undefined);
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    });
  });

  // ---- Construct exports ----

  void describe('construct exports', () => {
    void it('exposes distribution, bucket, and resources on the construct', () => {
      const stack = createStack();
      const construct = new HostingConstruct(stack, 'Hosting', {
        manifest: makeSpaManifest(),
      });

      assert.ok(construct.bucket);
      assert.ok(construct.distribution);
      assert.ok(construct.distributionUrl.startsWith('https://'));
    });

    void it('exposes compute functions for SSR mode', () => {
      const stack = createStack();
      const construct = new HostingConstruct(stack, 'Hosting', {
        manifest: makeSsrManifest(),
        skipRegionValidation: true,
      });

      assert.ok(construct.computeFunctions.has('default'));
      // SSR is fronted by API Gateway REST API, not by a Function URL,
      // so 'default' is intentionally absent from computeFunctionUrls.
      assert.ok(!construct.computeFunctionUrls.has('default'));
    });
  });

  // ---- secret() markers in environment (serves standalone + Amplify) ----
  void describe('environment secret() markers', () => {
    void it('wires a runtime secret marker on the DEFAULT store (Secrets Manager): locator + grants, no value leak', () => {
      const stack = createEnvStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSsrManifest(),
        environment: { STRIPE_KEY: secret('STRIPE_KEY') },
        secrets: { prefix: '/blocks/secrets' },
        skipRegionValidation: true,
      });
      const t = Template.fromStack(stack);
      // Secrets Manager locator is the slash-free name; the _STORE hint is set.
      t.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            HOSTING_SECRET_PARAM_STRIPE_KEY: 'blocks/secrets/STRIPE_KEY',
            HOSTING_SECRET_PARAM_STRIPE_KEY_STORE: 'secrets-manager',
          }),
        },
      });
      t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Action: 'secretsmanager:GetSecretValue' }),
          ]),
        },
      });
      // Marker value never appears; only the locator does.
      const json = JSON.stringify(t.toJSON());
      assert.ok(!json.includes('"STRIPE_KEY":'), 'secret value must not be a plaintext env var');
    });

    void it('wires a runtime secret marker on the SSM opt-in store: param name + ssm:GetParameter', () => {
      const stack = createEnvStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSsrManifest(),
        environment: { STRIPE_KEY: secret('STRIPE_KEY') },
        secrets: { prefix: '/blocks/secrets', store: 'ssm' },
        skipRegionValidation: true,
      });
      const t = Template.fromStack(stack);
      // SSM keeps the leading-slash path form and injects no _STORE hint.
      t.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            HOSTING_SECRET_PARAM_STRIPE_KEY: '/blocks/secrets/STRIPE_KEY',
          }),
        },
      });
      t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike({ Action: 'ssm:GetParameter' })]),
        },
      });
      const json = JSON.stringify(t.toJSON());
      assert.ok(
        !json.includes('HOSTING_SECRET_PARAM_STRIPE_KEY_STORE'),
        'ssm store injects no _STORE hint',
      );
    });

    void it('uses the neutral /hosting/secrets prefix by default (SM name is slash-free)', () => {
      const stack = createEnvStack();
      new HostingConstruct(stack, 'Hosting', {
        manifest: makeSsrManifest(),
        environment: { API_KEY: secret('API_KEY') },
        skipRegionValidation: true,
      });
      const json = JSON.stringify(Template.fromStack(stack).toJSON());
      // Default store is Secrets Manager → locator is the slash-free name.
      assert.ok(json.includes('hosting/secrets/API_KEY'), 'neutral default prefix');
    });

    void it('rejects an unresolved exposeAsEnv (synth-time) marker at construct level', () => {
      const stack = createEnvStack();
      assert.throws(
        () =>
          new HostingConstruct(stack, 'Hosting', {
            manifest: makeSsrManifest(),
            environment: { LEGACY: secret('LEGACY', { exposeAsEnv: true }) },
            skipRegionValidation: true,
          }),
        /unresolved|UnresolvedSecret|create\(\)/,
      );
    });
  });
});
