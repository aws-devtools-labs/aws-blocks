import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
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

  void it('grants the policy handler only the resource-policy calls it makes', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack);
    const template = Template.fromStack(stack);

    const actions = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .flatMap((s: { Action: string | string[] }) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((a: string) => a.endsWith('ResourcePolicy'));
    assert.deepStrictEqual(actions.sort(), ['lambda:DeleteResourcePolicy', 'lambda:PutResourcePolicy']);
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

void describe('web-function deploy safety', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const revisionLogicalId = (stack: Stack): string => {
    const ids = Object.keys(Template.fromStack(stack).findResources('AWS::Lambda::WebFunctionRevision'));
    assert.strictEqual(ids.length, 1);
    return ids[0];
  };

  void it('content-hashes the revision logical id so a change adds a revision instead of replacing it', () => {
    // Express Mode sandbox deploys run with rollback disabled, and CloudFormation
    // rejects REPLACEMENT updates there. Every revision property is create-only,
    // so the id must change with the content (add + remove) and stay stable
    // otherwise.
    const first = createEnvStack();
    webFunctionHosting(first, { environment: { FLAG: 'a' } });
    const idA = revisionLogicalId(first);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const same = createEnvStack();
    webFunctionHosting(same, { environment: { FLAG: 'a' } });
    assert.strictEqual(revisionLogicalId(same), idA, 'unchanged content keeps the same revision');
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const changedEnv = createEnvStack();
    webFunctionHosting(changedEnv, { environment: { FLAG: 'b' } });
    assert.notStrictEqual(revisionLogicalId(changedEnv), idA, 'an env change yields a new revision resource');
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const changedCode = createEnvStack();
    webFunctionHosting(changedCode, { environment: { FLAG: 'a' } }, (bundle) => {
      fs.writeFileSync(path.join(bundle, 'server', 'entry.mjs'), 'export const changed = true;');
      return httpServer(bundle);
    });
    assert.notStrictEqual(revisionLogicalId(changedCode), idA, 'a code change yields a new revision resource');

    // The endpoint (in-place update) points at whichever revision is current.
    const endpoint = Object.values(Template.fromStack(changedCode).findResources('AWS::Lambda::WebFunctionEndpoint'))[0];
    assert.deepStrictEqual(endpoint.Properties.RevisionWeights[0].RevisionId, {
      'Fn::GetAtt': [revisionLogicalId(changedCode), 'RevisionId'],
    });
  });

  void it('copies the bundle onto one stable key and pins the revision to the copied version', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack);
    const template = Template.fromStack(stack);
    // No per-deploy key: old zips become non-current versions of code.zip and
    // the lifecycle rule expires them.
    const zipDeployments = template.findResources('Custom::CDKBucketDeployment', { Properties: { Extract: false } });
    assert.strictEqual(Object.keys(zipDeployments).length, 0, 'no per-deploy <assetHash>.zip upload');
    // The copy call (Fn::Join-rendered JSON): S3 copyObject onto a fixed key, with
    // a stable physical id so a new bundle is an update, never a replacement.
    const uploads = Object.entries(template.findResources('Custom::AWS')).filter(([id]) => id.includes('CodeUpload'));
    assert.strictEqual(uploads.length, 1);
    const create = JSON.stringify(uploads[0][1].Properties.Create);
    for (const fragment of ['copyObject', 'code.zip', 'web-function-code', 'VersionId']) {
      assert.ok(create.includes(fragment), `copy call includes ${fragment}`);
    }
    const revision = Object.values(template.findResources('AWS::Lambda::WebFunctionRevision'))[0];
    const s3Object = revision.Properties.BuildConfig.CodeConfig.S3Object;
    assert.match(s3Object.Key, /^web-function\/.+\/code\.zip$/);
    assert.ok(s3Object.VersionId['Fn::GetAtt'], 'revision pins the copied object version');
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: { Rules: [Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } })] },
    });
  });

  void it('removes lambda-web-logstream with a response headers policy (covers 4xx/5xx)', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack);
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        RemoveHeadersConfig: { Items: [{ Header: 'lambda-web-logstream' }] },
        // Same settings as the managed SecurityHeadersPolicy — notably no CSP.
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, Override: false },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'SAMEORIGIN', Override: false },
          ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: false },
          XSSProtection: { Protection: true, ModeBlock: true, Override: false },
          ContentSecurityPolicy: Match.absent(),
        }),
      }),
    });
    // Attached to the behavior that serves SSR (the router's default behavior).
    const [policyId] = Object.keys(template.findResources('AWS::CloudFront::ResponseHeadersPolicy', {
      Properties: { ResponseHeadersPolicyConfig: Match.objectLike({ RemoveHeadersConfig: Match.anyValue() }) },
    }));
    const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
    assert.deepStrictEqual(distribution.Properties.DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId, {
      Ref: policyId,
    });
  });

  void it('keeps the managed security headers policy (no extra policy) for lambda compute', () => {
    const stack = createEnvStack();
    const { staticDir, bundleDir } = createDirs();
    new HostingConstruct(stack, 'Hosting', { manifest: ssrManifest(staticDir, httpServer(bundleDir)) });
    const policies = Template.fromStack(stack).findResources('AWS::CloudFront::ResponseHeadersPolicy', {
      Properties: { ResponseHeadersPolicyConfig: Match.objectLike({ RemoveHeadersConfig: Match.anyValue() }) },
    });
    assert.strictEqual(Object.keys(policies).length, 0);
  });

  void it('warns when the bundle ships x86-64 native modules', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack, {}, (bundle) => {
      const dir = path.join(bundle, 'node_modules', '@img', 'sharp-linux-x64', 'lib');
      fs.mkdirSync(dir, { recursive: true });
      // Minimal ELF header: magic, then e_machine (bytes 18-19, LE) = 0x3e (x86-64).
      const elf = Buffer.alloc(64);
      elf.writeUInt32BE(0x7f454c46, 0);
      elf.writeUInt16LE(0x3e, 18);
      fs.writeFileSync(path.join(dir, 'sharp-linux-x64.node'), elf);
      return httpServer(bundle);
    });
    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('ships x86-64 native modules'));
  });

  void it('does not warn for Arm64 native modules', () => {
    const stack = createEnvStack();
    webFunctionHosting(stack, {}, (bundle) => {
      const dir = path.join(bundle, 'node_modules', '@img', 'sharp-linux-arm64', 'lib');
      fs.mkdirSync(dir, { recursive: true });
      const elf = Buffer.alloc(64);
      elf.writeUInt32BE(0x7f454c46, 0);
      elf.writeUInt16LE(0xb7, 18); // aarch64
      fs.writeFileSync(path.join(dir, 'sharp-linux-arm64.node'), elf);
      return httpServer(bundle);
    });
    Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('x86-64 native modules'));
  });
});

void describe('renderEntryShim', () => {
  // Runs the generated shim in a child process against a stub server entry, so the
  // assertions cover what the shim does at runtime, not the text it renders.
  const runShim = (endpoint: string | undefined): Record<string, string | null> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-function-shim-'));
    try {
      fs.mkdirSync(path.join(root, 'server'));
      fs.writeFileSync(
        path.join(root, 'server', 'entry.mjs'),
        `const keys = ['HOST', 'HOSTNAME', 'NITRO_HOST', 'PORT', 'NITRO_PORT'];
console.log(JSON.stringify({ ...Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null])), cwd: process.cwd() }));`,
      );
      fs.writeFileSync(path.join(root, WEB_FUNCTION_ENTRY_SHIM), renderEntryShim('./server/entry.mjs'));
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
      if (endpoint !== undefined) env.AWS_LAMBDA_HTTP_ENDPOINT = endpoint;
      const out = execFileSync(process.execPath, [path.join(root, WEB_FUNCTION_ENTRY_SHIM)], { env, encoding: 'utf-8' });
      const result = JSON.parse(out.trim()) as Record<string, string | null>;
      // Report the working directory relative to the bundle (tmpdir may be a symlink, e.g. on macOS).
      const serverDir = fs.realpathSync(path.join(root, 'server'));
      if (result.cwd && fs.realpathSync(result.cwd) === serverDir) result.cwd = 'server';
      return result;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  void it('maps AWS_LAMBDA_HTTP_ENDPOINT onto every framework listen var and runs from the entry directory', () => {
    assert.deepStrictEqual(runShim('127.0.0.1:8080'), {
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      PORT: '8080',
      NITRO_PORT: '8080',
      cwd: 'server',
    });
  });

  void it('splits an IPv6 endpoint on the last colon', () => {
    const result = runShim('[::1]:9000');
    assert.strictEqual(result.HOST, '[::1]');
    assert.strictEqual(result.PORT, '9000');
  });

  void it('leaves listen vars untouched when no endpoint is provided', () => {
    const result = runShim(undefined);
    assert.strictEqual(result.HOST, null);
    assert.strictEqual(result.PORT, null);
    assert.strictEqual(result.cwd, 'server');
  });
});
