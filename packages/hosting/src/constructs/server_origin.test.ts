import { afterEach, beforeEach, describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CdnConstruct, type CdnConstructProps } from './cdn_construct.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';
import { HostingError } from '../hosting_error.js';
import { createSecurityHeadersPolicy } from './security_headers.js';
import type { DeployManifest } from '../manifest/types.js';
import { ORIGIN_ID } from './kvs_router.js';

// The server (SSR) origin is an API Gateway REST API that CloudFront reaches
// with an origin-verify `Referer` header. These tests pin down how that origin
// is locked to CloudFront: a random per-deployment secret (not a value derived
// from the stack name), a separate secret for the image origin, an optional
// regional web ACL on the stage, and optional stage access logs.

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown>; DependsOn?: string[] }>;

const manifest = (withIpx: boolean): DeployManifest => ({
  version: 1,
  compute: {
    default: { type: 'handler', bundle: '/tmp/bundle', handler: 'index.handler', placement: 'regional' },
  },
  staticAssets: { directory: '/tmp/assets' },
  routes: [{ pattern: '/*', target: 'default' }],
  buildId: 'test-server-origin',
  ...(withIpx
    ? { imageOptimization: { bundle: '/tmp/img', handler: 'index.handler', formats: ['webp'], sizes: [640], baseURL: '/_ipx' } }
    : {}),
});

const synth = (
  opts: { stackName?: string; ipx?: boolean; props?: Partial<CdnConstructProps>; region?: string } = {},
): { stack: Stack; template: Template; resources: Resources } => {
  const app = new App();
  const stack = new Stack(app, opts.stackName ?? 'TestStack', opts.region ? { env: { region: opts.region } } : {});
  const bucket = new Bucket(stack, 'Bucket');
  const policy = createSecurityHeadersPolicy(stack, 'SH', {});
  const fn = new LambdaFunction(stack, 'SsrFn', {
    runtime: Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: Code.fromInline('exports.handler = async () => {};'),
  });
  const computeFunctions = new Map([['default', fn]]);
  if (opts.ipx) {
    computeFunctions.set(
      'image-optimization',
      new LambdaFunction(stack, 'ImageFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      }),
    );
  }
  new CdnConstruct(stack, 'Cdn', {
    bucket,
    manifest: manifest(opts.ipx ?? false),
    securityHeadersPolicy: policy,
    computeFunctions,
    ...opts.props,
  });
  const template = Template.fromStack(stack);
  return { stack, template, resources: template.toJSON().Resources as Resources };
};

/** The `aws:Referer` values the API's DENY statement accepts, per RestApi logical id. */
const policyReferers = (resources: Resources): Map<string, unknown> => {
  const out = new Map<string, unknown>();
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type !== 'AWS::ApiGateway::RestApi') continue;
    const policy = r.Properties?.Policy as { Statement: Array<Record<string, unknown>> } | undefined;
    const statements = policy?.Statement ?? [];
    const deny = statements.find((s) => s.Effect === 'Deny') as {
      Condition: { StringNotEquals: Record<string, unknown> };
    };
    out.set(id, deny.Condition.StringNotEquals['aws:Referer']);
  }
  return out;
};

/** The `Referer` custom header value on a distribution origin. */
const originReferer = (resources: Resources, originId: string): unknown => {
  const dist = Object.values(resources).find((r) => r.Type === 'AWS::CloudFront::Distribution');
  const origins = (dist?.Properties?.DistributionConfig as {
    Origins: Array<{ Id: string; OriginCustomHeaders?: Array<{ HeaderName: string; HeaderValue: unknown }> }>;
  } | undefined)?.Origins ?? [];
  const origin = origins.find((o) => o.Id === originId);
  return origin?.OriginCustomHeaders?.find((h) => h.HeaderName === 'Referer')?.HeaderValue;
};

const legacySecret = (stackName: string): string =>
  createHash('sha256').update(stackName).update(`${stackName}/Cdn`).update('origin-verify-v1').digest('hex');

/** Logical id of the one resource of `type` whose logical id contains `fragment`. */
const logicalId = (resources: Resources, type: string, fragment: string): string => {
  const ids = Object.entries(resources)
    .filter(([id, r]) => r.Type === type && id.includes(fragment))
    .map(([id]) => id);
  assert.strictEqual(ids.length, 1, `one ${type} matching ${fragment} (got ${ids.join(', ')})`);
  return ids[0];
};

/** Path parts of the resources on a REST API, e.g. `['{proxy+}', '_ipx']`. */
const apiPathParts = (resources: Resources, apiId: string): string[] =>
  Object.values(resources)
    .filter((r) => r.Type === 'AWS::ApiGateway::Resource' && JSON.stringify(r.Properties?.RestApiId).includes(apiId))
    .map((r) => String(r.Properties?.PathPart));

/** The custom header names on a distribution origin. */
const originHeaderNames = (resources: Resources, originId: string): string[] => {
  const dist = Object.values(resources).find((r) => r.Type === 'AWS::CloudFront::Distribution');
  const origins = (dist?.Properties?.DistributionConfig as {
    Origins: Array<{ Id: string; OriginCustomHeaders?: Array<{ HeaderName: string }> }>;
  } | undefined)?.Origins ?? [];
  return origins.find((o) => o.Id === originId)?.OriginCustomHeaders?.map((h) => h.HeaderName) ?? [];
};

void describe('server origin lock-down', () => {
  void describe('origin-verify secret', () => {
    void it('is a Secrets Manager dynamic reference, not a value derived from the stack name', () => {
      const { stack, resources } = synth();
      const header = stack.resolve(originReferer(resources, ORIGIN_ID.server));
      assert.notStrictEqual(header, legacySecret('TestStack'), 'header must not be the derivable SHA-256');
      assert.strictEqual(typeof header, 'object', 'header must be a token, not a literal string');
      assert.match(JSON.stringify(header), /\{\{resolve:secretsmanager:/);
      // The value is generated by Secrets Manager at deploy time.
      const secrets = Object.values(resources).filter((r) => r.Type === 'AWS::SecretsManager::Secret');
      assert.ok(secrets.length >= 1, 'a Secrets Manager secret backs the header');
      assert.ok(secrets.every((s) => s.Properties?.GenerateSecretString !== undefined));
    });

    void it('policy condition and origin header are the same reference', () => {
      const { resources } = synth();
      const [value] = [...policyReferers(resources).values()];
      assert.deepStrictEqual(value, originReferer(resources, ORIGIN_ID.server));
    });

    void it('no literal hex secret appears anywhere in the template', () => {
      const { template } = synth({ stackName: 'GuessableName' });
      const json = JSON.stringify(template.toJSON());
      assert.ok(!json.includes(legacySecret('GuessableName')));
      assert.ok(!/"[0-9a-f]{64}"/.test(json), 'no 64-hex literal (the old derived secret) in the template');
    });

    void it('the image (IPX) origin has its own secret and its own API', () => {
      const { resources } = synth({ ipx: true });
      const ssrHeader = originReferer(resources, ORIGIN_ID.server);
      const imgHeader = originReferer(resources, ORIGIN_ID.image);
      assert.ok(ssrHeader && imgHeader);
      assert.notDeepStrictEqual(ssrHeader, imgHeader, 'SSR and IPX must not share the origin-verify secret');
      const referers = [...policyReferers(resources).values()];
      assert.strictEqual(referers.length, 2, 'SSR and IPX are separate REST APIs, each with its own policy');
      assert.deepStrictEqual(new Set(referers.map((r) => JSON.stringify(r))), new Set([ssrHeader, imgHeader].map((r) => JSON.stringify(r))));
      const secrets = Object.values(resources).filter((r) => r.Type === 'AWS::SecretsManager::Secret');
      assert.strictEqual(secrets.length, 2);
    });

    void it('verifySecretRotation replaces the secret (and so the value) on the next deploy', () => {
      const ids = (rotation?: number): string[] =>
        Object.entries(synth({ props: { serverOrigin: { verifySecretRotation: rotation } } }).resources)
          .filter(([, r]) => r.Type === 'AWS::SecretsManager::Secret')
          .map(([id]) => id);
      assert.notDeepStrictEqual(ids(1), ids(undefined));
      assert.deepStrictEqual(ids(0), ids(undefined), 'rotation 0 is the default secret');
    });

    void it('acceptLegacyVerifyHeader also accepts the previous derived value, for a zero-downtime upgrade', () => {
      const { stack, resources } = synth({ props: { serverOrigin: { acceptLegacyVerifyHeader: true } } });
      const [value] = [...policyReferers(resources).values()];
      const resolved = stack.resolve(value) as unknown[];
      assert.ok(Array.isArray(resolved) && resolved.length === 2);
      assert.ok(resolved.includes(legacySecret('TestStack')));
      // The header CloudFront sends is still only the new secret.
      assert.match(JSON.stringify(originReferer(resources, ORIGIN_ID.server)), /resolve:secretsmanager/);
    });

    void it('acceptLegacyVerifyHeader adds the derived value to the SSR API only, not the new image API', () => {
      const { stack, resources } = synth({ ipx: true, props: { serverOrigin: { acceptLegacyVerifyHeader: true } } });
      const referers = policyReferers(resources);
      const ssr = stack.resolve(referers.get(logicalId(resources, 'AWS::ApiGateway::RestApi', 'SsrRestApi')));
      const image = stack.resolve(referers.get(logicalId(resources, 'AWS::ApiGateway::RestApi', 'ImageRestApi')));
      assert.ok(Array.isArray(ssr) && ssr.length === 2 && ssr.includes(legacySecret('TestStack')));
      // No edge on the previous distribution config targets the new image API.
      assert.ok(!Array.isArray(image), 'the image API accepts only its own secret');
      assert.match(JSON.stringify(image), /resolve:secretsmanager/);
    });

    void it('acceptLegacyVerifyHeader keeps the IPX routes on the SSR API, for edges still on the previous origin', () => {
      const plain = synth({ ipx: true }).resources;
      assert.deepStrictEqual(
        apiPathParts(plain, logicalId(plain, 'AWS::ApiGateway::RestApi', 'SsrRestApi')).sort(),
        ['{proxy+}'],
        'without the flag the SSR API serves only SSR',
      );
      const legacy = synth({ ipx: true, props: { serverOrigin: { acceptLegacyVerifyHeader: true } } }).resources;
      const ssrApi = logicalId(legacy, 'AWS::ApiGateway::RestApi', 'SsrRestApi');
      assert.deepStrictEqual(apiPathParts(legacy, ssrApi).sort(), ['_ipx', '{proxy+}', '{proxy+}']);
      // `/_ipx` and `/_ipx/{proxy+}` on the SSR API invoke the image Lambda.
      const ipxMethods = Object.values(legacy).filter(
        (r) =>
          r.Type === 'AWS::ApiGateway::Method' &&
          JSON.stringify(r.Properties?.RestApiId).includes(ssrApi) &&
          JSON.stringify(r.Properties?.Integration).includes('ImageFn'),
      );
      assert.strictEqual(ipxMethods.length, 2);
    });

    void it('acceptLegacyVerifyHeader warns at synth until it is removed', () => {
      const { stack } = synth({ props: { serverOrigin: { acceptLegacyVerifyHeader: true } } });
      Annotations.fromStack(stack).hasWarning(
        '*',
        Match.stringLikeRegexp('Remove frontDoor\\.features\\.serverOrigin\\.acceptLegacyVerifyHeader'),
      );
      const plain = synth().stack;
      Annotations.fromStack(plain).hasNoWarning('*', Match.stringLikeRegexp('acceptLegacyVerifyHeader'));
    });
  });

  void describe('stage access logging', () => {
    void it('is off by default (no account-level CloudWatch role is provisioned)', () => {
      const { template } = synth();
      template.hasResourceProperties('AWS::ApiGateway::Stage', { AccessLogSetting: Match.absent() });
      template.resourceCountIs('AWS::ApiGateway::Account', 0);
    });

    void it('serverOrigin.accessLogging puts JSON access logs in a log group with explicit retention', () => {
      const { template, resources } = synth({
        ipx: true,
        props: { serverOrigin: { accessLogging: true, logRetention: RetentionDays.ONE_WEEK } },
      });
      const stages = Object.values(resources).filter((r) => r.Type === 'AWS::ApiGateway::Stage');
      assert.strictEqual(stages.length, 2);
      for (const stage of stages) {
        const setting = stage.Properties?.AccessLogSetting as { DestinationArn: unknown; Format: string } | undefined;
        assert.ok(setting, 'every server-origin stage has AccessLogSetting');
        assert.match(setting.Format, /requestId/);
        assert.ok(stage.DependsOn?.some((d) => d.includes('BlocksApiGatewayAccount')), 'stage waits for the account role');
      }
      template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
      template.resourceCountIs('AWS::ApiGateway::Account', 1);
    });

    void it('the account-level CloudWatch role trusts API Gateway without a condition', () => {
      const { template } = synth({ props: { serverOrigin: { accessLogging: true } } });
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Action: 'sts:AssumeRole',
              Principal: { Service: 'apigateway.amazonaws.com' },
              Condition: Match.absent(),
            },
          ],
        },
      });
    });
  });

  void describe('regional web ACL on the stage', () => {
    void it('is not created when the distribution has no Blocks-managed web ACL', () => {
      const { template } = synth();
      template.resourceCountIs('AWS::WAFv2::WebACL', 0);
      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    });

    void it('originWafRateLimit attaches a REGIONAL web ACL (managed rules + rate rule) to every server-origin stage, with logging', () => {
      const { template, resources } = synth({ ipx: true, props: { originWafRateLimit: 500 } });
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'REGIONAL',
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: { ManagedRuleGroupStatement: Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }) },
          }),
          Match.objectLike({
            Statement: { RateBasedStatement: Match.objectLike({ Limit: 500, AggregateKeyType: 'IP' }) },
          }),
        ]),
      });
      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 2);
      const assoc = Object.values(resources).filter((r) => r.Type === 'AWS::WAFv2::WebACLAssociation');
      for (const a of assoc) assert.match(JSON.stringify(a.Properties?.ResourceArn), /restapis/);
      template.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 1);
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: Match.stringLikeRegexp('^aws-waf-logs-'),
        RetentionInDays: Match.anyValue(),
      });
    });

    void it('redacts the origin-verify secret and the viewer credentials from the web ACL logs', () => {
      const { template } = synth({ props: { originWafRateLimit: 500 } });
      template.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
        RedactedFields: [
          { SingleHeader: { Name: 'referer' } },
          { SingleHeader: { Name: 'cookie' } },
          { SingleHeader: { Name: 'authorization' } },
        ],
      });
    });

    void it('keeps no sampled requests on the REGIONAL web ACL (they would carry the secret unredacted)', () => {
      const { resources } = synth({ props: { originWafRateLimit: 500 } });
      const acl = Object.values(resources).find((r) => r.Type === 'AWS::WAFv2::WebACL');
      assert.ok(acl, 'web ACL exists');
      const props = acl.Properties as {
        VisibilityConfig: { SampledRequestsEnabled: boolean };
        Rules: { VisibilityConfig: { SampledRequestsEnabled: boolean } }[];
      };
      assert.strictEqual(props.VisibilityConfig.SampledRequestsEnabled, false);
      for (const rule of props.Rules) assert.strictEqual(rule.VisibilityConfig.SampledRequestsEnabled, false);
    });

    void it('logs only the requests the web ACL blocks or counts', () => {
      const { template } = synth({ props: { originWafRateLimit: 500 } });
      template.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
        LoggingFilter: {
          DefaultBehavior: 'DROP',
          Filters: [
            {
              Behavior: 'KEEP',
              Requirement: 'MEETS_ANY',
              Conditions: [{ ActionCondition: { Action: 'BLOCK' } }, { ActionCondition: { Action: 'COUNT' } }],
            },
          ],
        },
      });
    });

    void it('CloudFront sends the rate-rule marker even without a web ACL, so turning waf on later has no window', () => {
      const { resources } = synth({ ipx: true });
      assert.ok(originHeaderNames(resources, ORIGIN_ID.server).includes('x-blocks-front-door'));
      assert.ok(originHeaderNames(resources, ORIGIN_ID.image).includes('x-blocks-front-door'));
    });

    void it('with acceptLegacyVerifyHeader, the SSR stage web ACL waits for the next deploy (edges on the old config send no marker)', () => {
      const { template, resources } = synth({
        ipx: true,
        props: { originWafRateLimit: 500, serverOrigin: { acceptLegacyVerifyHeader: true } },
      });
      // Only the new image API, which no edge on the old config targets, gets it now.
      const assoc = Object.keys(resources).filter((id) => resources[id].Type === 'AWS::WAFv2::WebACLAssociation');
      assert.strictEqual(assoc.length, 1);
      assert.ok(assoc[0].includes('AssociationImageRestApi'), assoc[0]);
      template.resourceCountIs('AWS::WAFv2::WebACL', 1);
      // Without IPX there is no stage web ACL at all for this deploy.
      synth({ props: { originWafRateLimit: 500, serverOrigin: { acceptLegacyVerifyHeader: true } } }).template.resourceCountIs(
        'AWS::WAFv2::WebACL',
        0,
      );
      // The marker is sent in this deploy, so every edge carries it by the next.
      assert.ok(originHeaderNames(resources, ORIGIN_ID.server).includes('x-blocks-front-door'));
    });

    void it('names each stage association after its REST API, so it does not depend on which stages exist', () => {
      const withIpx = synth({ ipx: true, props: { originWafRateLimit: 500 } }).resources;
      const ids = Object.entries(withIpx)
        .filter(([, r]) => r.Type === 'AWS::WAFv2::WebACLAssociation')
        .map(([id]) => id);
      assert.ok(ids.some((id) => id.includes('AssociationSsrRestApi')), `SSR association in ${ids.join(', ')}`);
      assert.ok(ids.some((id) => id.includes('AssociationImageRestApi')), `image association in ${ids.join(', ')}`);
    });
  });

  void describe('through HostingConstruct frontDoor.features', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-origin-'));
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
      fs.mkdirSync(path.join(tmpDir, 'bundle'));
      fs.writeFileSync(path.join(tmpDir, 'bundle', 'index.mjs'), 'export const handler = async () => {};');
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const hosting = (frontDoor: HostingConstructProps['frontDoor']): Template => {
      const stack = new Stack(new App(), 'TestStack', { env: { region: 'us-east-1', account: '111111111111' } });
      new HostingConstruct(stack, 'Hosting', {
        manifest: {
          version: 1,
          compute: {
            default: { type: 'handler', bundle: path.join(tmpDir, 'bundle'), handler: 'index.handler', placement: 'regional' },
          },
          staticAssets: { directory: tmpDir },
          routes: [{ pattern: '/*', target: 'default' }],
          buildId: 'server-origin',
        },
        frontDoor,
      });
      return Template.fromStack(stack);
    };

    void it('waf: { enabled: true } also puts a REGIONAL web ACL with the same rate limit on the server origin stage', () => {
      const template = hosting({ features: { waf: { enabled: true, rateLimit: 300 } } });
      template.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'CLOUDFRONT' });
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'REGIONAL',
        Rules: Match.arrayWith([
          Match.objectLike({ Statement: { RateBasedStatement: Match.objectLike({ Limit: 300 }) } }),
        ]),
      });
      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
      // CloudFront marks its requests so the regional rate rule skips them.
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Origins: Match.arrayWith([
            Match.objectLike({
              OriginCustomHeaders: Match.arrayWith([Match.objectLike({ HeaderName: 'x-blocks-front-door' })]),
            }),
          ]),
        }),
      });
    });

    void it('without a Blocks-managed web ACL, the server origin gets none', () => {
      const template = hosting(undefined);
      template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    });

    void it('serverOrigin.accessLogging turns on stage access logs', () => {
      const template = hosting({ features: { serverOrigin: { accessLogging: true } } });
      template.hasResourceProperties('AWS::ApiGateway::Stage', { AccessLogSetting: Match.objectLike({ Format: Match.anyValue() }) });
      template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    });

    void it('rejects an unknown serverOrigin key and a bad rotation', () => {
      assert.throws(
        () => hosting({ features: { serverOrigin: { accesslogging: true } as never } }),
        (e: unknown) => e instanceof HostingError && /serverOrigin\.accesslogging/.test(e.message),
      );
      assert.throws(
        () => hosting({ features: { serverOrigin: { verifySecretRotation: -1 } } }),
        (e: unknown) =>
          e instanceof HostingError &&
          e.message.includes('`frontDoor.features.serverOrigin.verifySecretRotation` must be a non-negative integer'),
      );
    });
  });
});
