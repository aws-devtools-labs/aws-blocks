import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { HostingConstruct } from './hosting_construct.js';
import { WEB_FUNCTION_ENTRY_SHIM, WebFunctionConstruct, renderEntryShim } from './web_function_construct.js';
import { HostingError } from '../hosting_error.js';
import type { ComputeResource, DeployManifest } from '../manifest/types.js';

// ---- Helpers ----

let tmpDir: string;

const createEnvStack = (region = 'us-east-1'): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack', { env: { account: '123456789012', region } });
};

const createDirs = (): { staticDir: string; bundleDir: string } => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-function-test-'));
  const staticDir = path.join(tmpDir, 'static');
  const bundleDir = path.join(tmpDir, 'bundle');
  fs.mkdirSync(staticDir, { recursive: true });
  fs.mkdirSync(path.join(bundleDir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(bundleDir, 'server', 'entry.mjs'), 'export {};');
  return { staticDir, bundleDir };
};

const httpServer = (bundle: string, overrides: Partial<ComputeResource> = {}): ComputeResource => ({
  type: 'http-server',
  bundle,
  entrypoint: 'server/run.sh',
  serverEntry: 'server/entry.mjs',
  port: 3000,
  placement: 'regional',
  runtime: 'nodejs24.x',
  ...overrides,
});

const ssrManifest = (staticDir: string, compute: ComputeResource): DeployManifest => ({
  version: 1,
  compute: { default: compute },
  staticAssets: { directory: staticDir },
  routes: [
    { pattern: '/_astro/*', target: 'static' },
    { pattern: '/*', target: 'default' },
  ],
  buildId: 'wf-test-1',
});

const webFunctionHosting = (
  stack: Stack,
  compute: NonNullable<ConstructorParameters<typeof HostingConstruct>[2]['compute']> = {},
  resource?: (bundle: string) => ComputeResource,
): HostingConstruct => {
  const { staticDir, bundleDir } = createDirs();
  return new HostingConstruct(stack, 'Hosting', {
    manifest: ssrManifest(staticDir, resource ? resource(bundleDir) : httpServer(bundleDir)),
    compute: { type: 'web-function', ...compute },
  });
};

// ================================================================
// HostingConstruct with compute.type: 'web-function'
// ================================================================

void describe('HostingConstruct — compute.type web-function', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('provisions a Web Function, revision, and IamAuth HomeRegion endpoint', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::WebFunction', 1);
    template.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
      BuildConfig: { RuntimeConfig: { Runtime: 'nodejs24.x' } },
      ServiceConfig: Match.objectLike({
        TimeoutSeconds: 30,
        EnvironmentVariables: Match.objectLike({ AWS_LAMBDA_NODEJS_ENTRYPOINT: WEB_FUNCTION_ENTRY_SHIM }),
      }),
    });
    template.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
      EndpointName: 'default',
      EndpointType: 'HomeRegion',
      AuthType: 'IamAuth',
      RevisionWeights: [{ RevisionId: Match.anyValue(), Weight: 100 }],
    });
  });

  void it('replaces the SSR Lambda + API Gateway with an OAC-signed Web Function origin', () => {
    const stack = createEnvStack();
    const hosting = webFunctionHosting(stack);
    const template = Template.fromStack(stack);

    assert.strictEqual(hosting.computeFunctions.has('default'), false);
    assert.ok(hosting.computeWebFunctions.get('default') instanceof WebFunctionConstruct);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 'lambda',
        SigningBehavior: 'always-amz-auth',
      }),
    });

    const [distribution] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const origins = distribution.Properties.DistributionConfig.Origins as Array<Record<string, unknown>>;
    const server = origins.find((o) => o.Id === 'blocks-server');
    assert.ok(server, 'server origin present');
    const [endpointId] = Object.keys(template.findResources('AWS::Lambda::WebFunctionEndpoint'));
    assert.deepStrictEqual(server.DomainName, { 'Fn::GetAtt': [endpointId, 'DomainName'] });
    assert.ok(server.OriginAccessControlId, 'server origin is OAC-signed');
  });

  void it('grants only this distribution InvokeWebFunctionEndpoint via the resource policy', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack);
    const template = Template.fromStack(stack);

    const policies = template.findResources('AWS::CloudFormation::CustomResource', {
      Properties: { FunctionArn: Match.anyValue(), Policy: Match.anyValue() },
    });
    assert.strictEqual(Object.keys(policies).length, 1);
    const rendered = JSON.stringify(Object.values(policies)[0].Properties.Policy);
    assert.match(rendered, /lambda:InvokeWebFunctionEndpoint/);
    assert.match(rendered, /cloudfront\.amazonaws\.com/);
    assert.match(rendered, /aws:SourceArn/);
    assert.match(rendered, /HostingDistribution/);
  });

  void it('stores code in a versioned bucket readable only by this function’s revisions', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack);
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowLambdaWebFunctionCodeAccess',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: ['s3:GetObject', 's3:GetObjectVersion'],
            Condition: { ArnLike: { 'aws:SourceArn': Match.anyValue() } },
          }),
        ]),
      },
    });
  });

  void it('writes an entry shim that maps AWS_LAMBDA_HTTP_ENDPOINT and imports the server entry', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack);
    const shim = fs.readFileSync(path.join(tmpDir, 'bundle', WEB_FUNCTION_ENTRY_SHIM), 'utf-8');
    assert.match(shim, /AWS_LAMBDA_HTTP_ENDPOINT/);
    assert.match(shim, /"\.\/server\/entry\.mjs"/);
  });

  void it('falls back to a JS entrypoint when serverEntry is unset (Nitro index.mjs)', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack, {}, (bundle) => {
      fs.writeFileSync(path.join(bundle, 'index.mjs'), 'export {};');
      return httpServer(bundle, { entrypoint: 'index.mjs', serverEntry: undefined });
    });
    const shim = fs.readFileSync(path.join(tmpDir, 'bundle', WEB_FUNCTION_ENTRY_SHIM), 'utf-8');
    assert.match(shim, /"\.\/index\.mjs"/);
  });

  void it('forwards Blocks env, timeout, and webFunction tuning', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack, {
      timeout: Duration.seconds(120),
      environment: { FEATURE_FLAG: 'on' },
      webFunction: { maxConcurrencyPerEnvironment: 32, maxEnvironments: 10, rateLimit: 2000 },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
      ServiceConfig: Match.objectLike({
        TimeoutSeconds: 120,
        MaxConcurrencyPerEnvironment: 32,
        EnvironmentVariables: Match.objectLike({ FEATURE_FLAG: 'on' }),
      }),
    });
    template.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
      ScalingConfig: { MaxEnvironments: 10 },
      ThrottleConfig: { RateLimit: 2000 },
    });
  });

  void it('warns (does not fail) on Lambda-only compute options', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack, { memorySize: 1024, reservedConcurrency: 5 });
    const annotations = Annotations.fromStack(stack);
    annotations.hasWarning('*', Match.stringLikeRegexp('compute.memorySize does not apply'));
    annotations.hasWarning('*', Match.stringLikeRegexp('compute.reservedConcurrency does not apply'));
  });

  void it('keeps the default (lambda) path unchanged when type is omitted', () => {
    const stack = createEnvStack();
    const { staticDir, bundleDir } = createDirs();
    new HostingConstruct(stack, 'Hosting', { manifest: ssrManifest(staticDir, httpServer(bundleDir)) });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::WebFunction', 0);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

  void it('rejects an unsupported Region at synth', () => {
    const stack = createEnvStack('eu-central-1');
    assert.throws(
      () => webFunctionHosting(stack),
      (err: unknown) => err instanceof HostingError && err.code === 'WebFunctionUnsupportedRegionError',
    );
  });

  void it('rejects a handler-type (event) build with guidance', () => {
    const stack = createEnvStack();
    assert.throws(
      () =>
        webFunctionHosting(stack, {}, (bundle) => ({
          type: 'handler',
          bundle,
          handler: 'index.handler',
          placement: 'regional',
        })),
      (err: unknown) =>
        err instanceof HostingError &&
        err.code === 'WebFunctionUnsupportedComputeError' &&
        /node-server/.test(err.resolution ?? ''),
    );
  });

  void it('rejects out-of-range timeout and tuning values', () => {
    for (const compute of [
      { timeout: Duration.seconds(1000) },
      { webFunction: { maxConcurrencyPerEnvironment: 200 } },
      { webFunction: { maxEnvironments: 1 } },
      { webFunction: { rateLimit: 150 } },
    ]) {
      const stack = createEnvStack();
      assert.throws(() => webFunctionHosting(stack, compute), HostingError);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

void describe('web-function viewer response', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('strips lambda-web-logstream at the edge (and only for web-function compute)', () => {
    const routerResponseCode = (stack: Stack): string => {
      const fns = Template.fromStack(stack).findResources('AWS::CloudFront::Function');
      const entry = Object.entries(fns).find(([id]) => id.includes('KvsRouterResponse'));
      assert.ok(entry, 'router response function present');
      return JSON.stringify(entry[1].Properties.FunctionCode);
    };
    const wfStack = createEnvStack();
    webFunctionHosting(wfStack);
    assert.match(routerResponseCode(wfStack), /lambda-web-logstream/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    const lambdaStack = createEnvStack();
    const { staticDir, bundleDir } = createDirs();
    new HostingConstruct(lambdaStack, 'Hosting', { manifest: ssrManifest(staticDir, httpServer(bundleDir)) });
    assert.doesNotMatch(routerResponseCode(lambdaStack), /lambda-web-logstream/);
  });
});

void describe('renderEntryShim', () => {
  void it('splits host:port on the last colon and sets every framework listen var', () => {
    const shim = renderEntryShim('./index.js');
    for (const key of ['HOST', 'HOSTNAME', 'NITRO_HOST', 'PORT', 'NITRO_PORT']) {
      assert.ok(shim.includes(`'${key}'`), `sets ${key}`);
    }
    assert.match(shim, /lastIndexOf\(':'\)/);
  });
});
