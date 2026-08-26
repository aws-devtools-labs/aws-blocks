import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ComputeConstruct } from './compute_construct.js';
import { HostingError } from '../hosting_error.js';
import { ComputeResource } from '../manifest/types.js';

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

let tmpDir: string;

const createBundleDir = (): string => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compute-construct-test-'));
  fs.writeFileSync(
    path.join(tmpDir, 'index.mjs'),
    'export const handler = async () => {};',
  );
  return tmpDir;
};

const handlerResource = (bundle: string): ComputeResource => ({
  type: 'handler',
  bundle,
  handler: 'index.handler',
  placement: 'regional',
  streaming: true,
  runtime: 'nodejs24.x',
});

const httpServerResource = (bundle: string): ComputeResource => ({
  type: 'http-server',
  bundle,
  entrypoint: 'server.js',
  port: 3000,
  placement: 'regional',
  streaming: false,
  runtime: 'nodejs24.x',
});

const edgeResource = (bundle: string): ComputeResource => ({
  type: 'edge',
  bundle,
  handler: 'index.handler',
  placement: 'global',
  streaming: false,
  runtime: 'nodejs24.x',
});

// ================================================================
// ComputeConstruct — unit tests
// ================================================================

void describe('ComputeConstruct', () => {
  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- Handler type ----

  void describe('handler compute type', () => {
    void it('creates Lambda with handler directly (no Web Adapter)', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs24.x',
        Handler: 'index.handler',
      });

      // Should NOT have Web Adapter environment variables
      const functions = template.findResources('AWS::Lambda::Function');
      const fn = Object.values(functions)[0] as Record<
        string,
        Record<string, unknown>
      >;
      const env =
        (fn.Properties.Environment as Record<string, Record<string, string>>)
          ?.Variables ?? {};
      assert.strictEqual(env['AWS_LAMBDA_EXEC_WRAPPER'], undefined);
    });

    void it('sets default memorySize to 1024 MB', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 1024,
      });
    });

    void it('sets default timeout to 30 seconds', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 30,
      });
    });

    void it('creates Function URL with RESPONSE_STREAM invoke mode for streaming', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Url', {
        AuthType: 'AWS_IAM',
        InvokeMode: 'RESPONSE_STREAM',
      });
    });
  });

  // ---- HTTP Server type ----

  void describe('http-server compute type', () => {
    void it('creates Lambda with Web Adapter layer', () => {
      const bundle = createBundleDir();
      fs.writeFileSync(path.join(bundle, 'server.js'), '// server');
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: httpServerResource(bundle),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'server.js',
        Environment: {
          Variables: Match.objectLike({
            AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
            AWS_LWA_INVOKE_MODE: 'response_stream',
            PORT: '3000',
          }),
        },
      });
    });

    void it('includes Lambda Web Adapter layer', () => {
      const bundle = createBundleDir();
      fs.writeFileSync(path.join(bundle, 'server.js'), '// server');
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: httpServerResource(bundle),
      });
      const template = Template.fromStack(stack);

      const functions = template.findResources('AWS::Lambda::Function');
      const fn = Object.values(functions)[0] as Record<
        string,
        Record<string, unknown>
      >;
      const layers = fn.Properties.Layers as unknown[];
      const layerStr = JSON.stringify(layers);
      assert.ok(
        layerStr.includes('753240598075'),
        `Layer ARN should include account 753240598075, got: ${layerStr}`,
      );
    });

    void it('throws UnsupportedRegionError for unsupported region', () => {
      const bundle = createBundleDir();
      fs.writeFileSync(path.join(bundle, 'server.js'), '// server');

      assert.throws(
        () => {
          const stack = createEnvStack('eu-south-2', '123456789012');
          new ComputeConstruct(stack, 'Compute', {
            name: 'default',
            computeResource: httpServerResource(bundle),
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof HostingError);
          assert.strictEqual(err.name, 'UnsupportedRegionError');
          return true;
        },
      );
    });

    void it('bypasses region check with skipRegionValidation', () => {
      const bundle = createBundleDir();
      fs.writeFileSync(path.join(bundle, 'server.js'), '// server');
      const stack = createEnvStack('eu-south-2', '123456789012');

      const compute = new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: httpServerResource(bundle),
        skipRegionValidation: true,
      });
      assert.ok(compute.function);
    });
  });

  // ---- Runtime resolution ----

  void describe('runtime resolution', () => {
    void it('defaults to nodejs24.x when no runtime is declared', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      const { runtime: _omitted, ...withoutRuntime } = handlerResource(bundle);

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: withoutRuntime as ComputeResource,
      });

      Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs24.x',
      });
    });

    void it('honors explicitly declared supported runtimes', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: { ...handlerResource(bundle), runtime: 'nodejs22.x' },
      });

      Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
      });
    });

    void it('throws UnsupportedRuntimeError for an unrecognized runtime', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      assert.throws(
        () =>
          new ComputeConstruct(stack, 'Compute', {
            name: 'serverFn',
            computeResource: {
              ...handlerResource(bundle),
              runtime: 'python3.12',
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof HostingError);
          assert.strictEqual(error.code, 'UnsupportedRuntimeError');
          assert.match(error.message, /python3\.12/);
          assert.match(error.message, /serverFn/);
          return true;
        },
      );
    });
  });

  // ---- Edge type ----

  void describe('edge compute type', () => {
    void it('creates Lambda for edge functions', () => {
      const bundle = createBundleDir();
      const stack = createEnvStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: edgeResource(bundle),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs24.x',
        Handler: 'index.handler',
      });
    });

    void it('caps timeout at 5 seconds for edge (viewer-request limit)', () => {
      const bundle = createBundleDir();
      const stack = createEnvStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: { ...edgeResource(bundle), timeout: 60 },
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 5,
      });
    });

    void it('supports multiple edge computes on the cross-region path (unique EdgeFunction id)', () => {
      // Regression: on a non-us-east-1 stack, experimental.EdgeFunction hoists
      // every instance into one shared edge-lambda-stack. A literal
      // 'EdgeFunction' child id collided on the 2nd edge compute. The id is
      // now scoped by props.name, so two edge computes coexist.
      const bundle = createBundleDir();
      const stack = createEnvStack('eu-west-1', '123456789012');

      new ComputeConstruct(stack, 'Compute-edge1', {
        name: 'edge1',
        computeResource: edgeResource(bundle),
      });
      // Must not throw "already a Construct with name 'EdgeFunction'".
      assert.doesNotThrow(() => {
        new ComputeConstruct(stack, 'Compute-edge2', {
          name: 'edge2',
          computeResource: edgeResource(bundle),
        });
      });

      // Synthesizing the app materializes the shared edge-lambda-stack; if the
      // ids collided this would throw.
      assert.doesNotThrow(() => App.of(stack)?.synth());
    });
  });

  // ---- Custom overrides ----

  void describe('custom overrides', () => {
    void it('overrides memorySize', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
        memorySize: 1024,
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 1024,
      });
    });

    void it('overrides timeout', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
        timeout: Duration.seconds(60),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 60,
      });
    });

    void it('throws InvalidTimeoutError when timeout is not a Duration', () => {
      // Regression: AWS Blocks bug-bash repro showed `timeout: 30` (a
      // plain number) flowing through a permissive JS-compiled wrapper
      // and crashing deep in aws-cdk-lib with `props.timeout.toSeconds
      // is not a function`. We now coerce at the L3 surface, but
      // ComputeConstruct also fails fast for any internal caller that
      // bypasses normalization.
      const bundle = createBundleDir();
      const stack = createStack();

      assert.throws(
        () =>
          new ComputeConstruct(stack, 'Compute', {
            name: 'default',
            computeResource: handlerResource(bundle),
            // @ts-expect-error — exercising the runtime guard
            timeout: 30,
          }),
        (err: Error) =>
          err instanceof HostingError && err.code === 'InvalidTimeoutError',
      );
    });

    void it('sets reservedConcurrency when provided', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
        reservedConcurrency: 10,
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        ReservedConcurrentExecutions: 10,
      });
    });
  });

  // ---- IAM role ----

  void describe('IAM role', () => {
    void it('has AWSLambdaBasicExecutionRole managed policy', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::IAM::Role', {
        ManagedPolicyArns: Match.arrayWith([
          Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([
                Match.stringLikeRegexp('AWSLambdaBasicExecutionRole'),
              ]),
            ]),
          }),
        ]),
      });
    });
  });

  // ---- Log retention ----

  void describe('logRetention', () => {
    void it('uses custom logRetention when provided', () => {
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
        logRetention: RetentionDays.ONE_MONTH,
      });

      // `logRetention` is mapped to an explicit `AWS::Logs::LogGroup`
      // (the deprecated `Function#logRetention` prop emitted a
      // `Custom::LogRetention` singleton custom resource and triggered
      // a `will be removed in the next major release` warning on every
      // synth — gone after R4-#9).
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        RetentionInDays: 30,
      });
    });

    void it('defaults to ONE_MONTH when logRetention is not set', () => {
      // P3.3: bumped from TWO_WEEKS to ONE_MONTH so a regression
      // reported >2 weeks after introduction still has logs to debug
      // it. Customers can still override via `compute.logRetention`.
      const bundle = createBundleDir();
      const stack = createStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        RetentionInDays: 30,
      });
    });
  });

  // ---- Provisioned Concurrency ----

  void describe('provisioned concurrency', () => {
    void it('creates Function URL on alias when provisionedConcurrency is set', () => {
      const bundle = createBundleDir();
      const stack = createEnvStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: {
          ...handlerResource(bundle),
          provisionedConcurrency: 5,
        },
      });

      const template = Template.fromStack(stack);

      // Verify alias exists with correct provisioned concurrency
      template.hasResourceProperties('AWS::Lambda::Alias', {
        Name: 'live',
        ProvisionedConcurrencyConfig: Match.objectLike({
          ProvisionedConcurrentExecutions: 5,
        }),
      });

      // Verify Function URL exists (targets the alias, not $LATEST)
      template.hasResourceProperties('AWS::Lambda::Url', {
        AuthType: 'AWS_IAM',
        InvokeMode: 'RESPONSE_STREAM',
      });
    });

    void it('creates Function URL on $LATEST when provisionedConcurrency is not set', () => {
      const bundle = createBundleDir();
      const stack = createEnvStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
      });

      const template = Template.fromStack(stack);

      // Verify no alias is created
      const aliases = template.findResources('AWS::Lambda::Alias');
      assert.strictEqual(
        Object.keys(aliases).length,
        0,
        'Should not create an alias when provisionedConcurrency is not set',
      );

      // Verify Function URL still exists (on $LATEST)
      template.hasResourceProperties('AWS::Lambda::Url', {
        AuthType: 'AWS_IAM',
        InvokeMode: 'RESPONSE_STREAM',
      });
    });

    void it('creates the alias (no Function URL) for SSR via the provisionedConcurrency prop', () => {
      // SSR compute sets skipFunctionUrl=true; the alias must still be
      // created so the L3 can point the REST API integration at it. The
      // prop (L3 user surface) drives this, not the manifest value.
      const bundle = createBundleDir();
      const stack = createEnvStack();

      const compute = new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
        skipFunctionUrl: true,
        provisionedConcurrency: 3,
      });

      // The alias is exposed for the caller to target.
      assert.ok(compute.alias, 'alias should be exposed');
      assert.strictEqual(compute.functionUrl, undefined, 'no Function URL');

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Lambda::Alias', {
        Name: 'live',
        ProvisionedConcurrencyConfig: Match.objectLike({
          ProvisionedConcurrentExecutions: 3,
        }),
      });
      template.resourceCountIs('AWS::Lambda::Url', 0);
    });
  });

  // ---- environment passthrough ----

  void describe('environment passthrough', () => {
    void it('passes props.environment values to Lambda environment variables', () => {
      const bundle = createBundleDir();
      const stack = createEnvStack();

      new ComputeConstruct(stack, 'Compute', {
        name: 'default',
        computeResource: handlerResource(bundle),
        environment: {
          MY_API_KEY: 'secret-123',
          FEATURE_FLAG: 'enabled',
        },
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            MY_API_KEY: 'secret-123',
            FEATURE_FLAG: 'enabled',
          }),
        }),
      });
    });
  });
});
