import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { HostingPlan } from '../plan/types.js';
import { ApiGatewayConstruct } from './apigw_construct.js';
import { ApiGatewayRestConstruct } from './apigw_rest_construct.js';
import { apiGatewayDoor } from './apigw_door.js';
import { buildFrontDoor } from './custom_door.js';
import { buildDoorInput } from './door_input.js';

const staticPlan: HostingPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: {
    entries: [
      { pattern: '/assets/*', kind: 'static' },
      { pattern: '/about', kind: 'static' },
    ],
    redirects: [],
    headers: [],
  },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'testbuild' },
};

const withBackendApiUrl = (plan: HostingPlan, url: string): HostingPlan => ({
  ...plan,
  backend: { origins: [{ namespace: '*', ingress: { kind: 'url', url } }] },
});

const synth = (plan: HostingPlan) => {
  const app = new App();
  const stack = new Stack(app, 'S', { env: { account: '111111111111', region: 'us-west-2' } });
  const bucket = new Bucket(stack, 'Assets');
  new ApiGatewayConstruct(stack, 'ApiGw', { plan, bucket });
  return Template.fromStack(stack);
};

describe('ApiGatewayConstruct — static plan', () => {
  const t = synth(staticPlan);

  it('creates an HTTP API', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  it('provisions the asset-proxy Lambda with the build-id key prefix', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { ASSET_KEY_PREFIX: 'builds/testbuild' } },
    });
  });

  it('creates a route per (deduped) static entry plus the $default route', () => {
    // /assets/{proxy+} + /about + the $default catch-all route = 3
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 3);
  });
});

describe('ApiGatewayConstruct — invoke permissions', () => {
  it("one permission per function, for every route and stage of the API (the $default route's ARN has two segments)", () => {
    const stack = new Stack(new App(), 'Perm', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    const server = new LambdaFunction(stack, 'Server', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async () => ({})'),
    });
    const plan: HostingPlan = {
      ...staticPlan,
      origins: [...staticPlan.origins, { id: 'blocks-server', kind: 'server' }],
      routes: { ...staticPlan.routes, entries: [...staticPlan.routes.entries, { pattern: '/ssr/*', kind: 'server' }] },
      policies: { ...staticPlan.policies, hasServer: true },
    };
    new ApiGatewayConstruct(stack, 'ApiGw', { plan, bucket, computeFunctions: new Map([['server', server]]), serverComputeName: 'server' });
    const perms = Object.values(Template.fromStack(stack).findResources('AWS::Lambda::Permission')).filter(
      (p) => p.Properties.Principal === 'apigateway.amazonaws.com',
    );
    const byFn = new Map<string, string[]>();
    for (const p of perms) {
      const fn = JSON.stringify(p.Properties.FunctionName);
      byFn.set(fn, [...(byFn.get(fn) ?? []), JSON.stringify(p.Properties.SourceArn)]);
    }
    assert.equal(byFn.size, 2, 'the asset proxy and the server');
    for (const [fn, arns] of byFn) {
      assert.equal(arns.length, 1, `one permission for ${fn}`);
      // `…:<apiId>/*`: matches `<apiId>/$default/$default` as well as `<apiId>/$default/GET/ssr/x`.
      assert.match(arns[0], /\{"Ref":"ApiGwHttpApi[0-9A-F]+"\},"\/\*"\]\]\}$/, arns[0]);
    }
  });
});

describe('ApiGatewayConstruct — with backend proxy', () => {
  it("leaves the backend's catch-all raw route ('/*') out on HTTP and REST, and warns (as the ALB door does)", () => {
    const plan = withBackendApiUrl(staticPlan, 'https://abc.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api');
    for (const Ctor of [ApiGatewayConstruct, ApiGatewayRestConstruct]) {
      const stack = new Stack(new App(), 'C', { env: { account: '111111111111', region: 'us-west-2' } });
      new Ctor(stack, 'ApiGw', { plan, bucket: new Bucket(stack, 'Assets'), apiPaths: ['/aws-blocks/*', '/*'] });
      const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('CatchAllApiPathNotRouted'));
      assert.equal(warnings.length, 1, Ctor.name);
    }
  });

  it('adds the same-origin backend route (/aws-blocks/*, which covers sign-in) via HTTP integration', () => {
    const t = synth(withBackendApiUrl(staticPlan, 'https://abc.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api'));
    // 2 static + 2 backend (`/aws-blocks/{proxy+}`, and `/aws-blocks` itself — a
    // greedy `{proxy+}` needs at least one character) + $default = 5 routes
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 5);
    // At least one HTTP_PROXY integration to the backend
    t.hasResourceProperties('AWS::ApiGatewayV2::Integration', { IntegrationType: 'HTTP_PROXY' });
  });

  it('path-routes each named namespace to its own ingress (multi-compute)', () => {
    const plan: HostingPlan = {
      ...staticPlan,
      backend: {
        origins: [
          { namespace: 'notes', ingress: { kind: 'url', url: 'https://notes.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api' } },
          { namespace: 'users', ingress: { kind: 'url', url: 'https://users.example.com/aws-blocks/api' } },
        ],
      },
    };
    const t = synth(plan);
    // 2 static + 2 namespace routes + $default = 5
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 5);
    t.hasResourceProperties('AWS::ApiGatewayV2::Integration', { IntegrationType: 'HTTP_PROXY' });
  });
});

const synthRest = (plan: HostingPlan) => {
	const app = new App();
	const stack = new Stack(app, 'SR', { env: { account: '111111111111', region: 'us-west-2' } });
	const bucket = new Bucket(stack, 'Assets');
	new ApiGatewayRestConstruct(stack, 'ApiGwRest', { plan, bucket });
	return Template.fromStack(stack);
};

describe('ApiGatewayRestConstruct — static plan', () => {
	const t = synthRest(staticPlan);

	it('creates a REGIONAL REST API with all-binary media types', () => {
		t.resourceCountIs('AWS::ApiGateway::RestApi', 1);
		t.hasResourceProperties('AWS::ApiGateway::RestApi', {
			EndpointConfiguration: { Types: ['REGIONAL'] },
			BinaryMediaTypes: ['*/*'],
		});
	});

	it('provisions the asset-proxy Lambda with the build-id key prefix', () => {
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: { Variables: { ASSET_KEY_PREFIX: 'builds/testbuild' } },
		});
	});

	it('deploys a prod stage', () => {
		t.hasResourceProperties('AWS::ApiGateway::Stage', { StageName: 'prod' });
	});
});

describe('ApiGatewayRestConstruct — with backend proxy', () => {
	it('adds a same-origin HTTP_PROXY backend integration for /aws-blocks/*', () => {
		const t = synthRest(
			withBackendApiUrl(staticPlan, 'https://abc.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api'),
		);
		t.hasResourceProperties('AWS::ApiGateway::Method', {
			Integration: { Type: 'HTTP_PROXY' },
		});
	});
});

describe('ApiGatewayRestConstruct — custom domain', () => {
	const app = new App();
	const stack = new Stack(app, 'SRDom', { env: { account: '111111111111', region: 'us-west-2' } });
	const bucket = new Bucket(stack, 'Assets');
	// hostedZoneId (not name) avoids HostedZone.fromLookup() which needs context.
	new ApiGatewayRestConstruct(stack, 'ApiGwRest', {
		plan: staticPlan,
		bucket,
		domain: { names: ['app.example.com'], hostedZone: 'example.com', hostedZoneId: 'Z1234567890ABC' },
	});
	const t = Template.fromStack(stack);

	it('provisions a REGIONAL custom DomainName + base-path mapping', () => {
		t.hasResourceProperties('AWS::ApiGateway::DomainName', {
			DomainName: 'app.example.com',
			EndpointConfiguration: { Types: ['REGIONAL'] },
		});
		t.resourceCountIs('AWS::ApiGateway::BasePathMapping', 1);
	});

	it('creates a regional ACM cert (stack region, not us-east-1) and A+AAAA alias records', () => {
		t.resourceCountIs('AWS::CertificateManager::Certificate', 1);
		// One A + one AAAA alias.
		t.resourceCountIs('AWS::Route53::RecordSet', 2);
	});
});

describe('ApiGatewayConstruct (HTTP) — custom domain', () => {
	const app = new App();
	const stack = new Stack(app, 'SHDom', { env: { account: '111111111111', region: 'us-west-2' } });
	const bucket = new Bucket(stack, 'Assets');
	new ApiGatewayConstruct(stack, 'ApiGw', {
		plan: staticPlan,
		bucket,
		domain: { names: ['app.example.com'], hostedZone: 'example.com', hostedZoneId: 'Z1234567890ABC' },
	});
	const t = Template.fromStack(stack);

	it('provisions an HTTP API v2 DomainName + API mapping + A/AAAA alias records', () => {
		t.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: 'app.example.com' });
		t.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
		t.resourceCountIs('AWS::CertificateManager::Certificate', 1);
		t.resourceCountIs('AWS::Route53::RecordSet', 2);
	});
});

const buildApiGw = (stack: Stack, plan: HostingPlan, apiType?: 'rest' | 'http') => {
	const bucket = new Bucket(stack, 'Assets');
	const input = buildDoorInput({ plan, bucket, staticDir: '.' });
	return buildFrontDoor(stack, apiGatewayDoor, { ...input, apiType, apiGateway: { plan, bucket } }, { wiringCheck: false })
		.result;
};

describe('apiGatewayDoor — flavor selection', () => {
	it("renders an HTTP API v2 by default (apiType omitted) and for apiType: 'http' — its $default stage is rootless", () => {
		for (const apiType of [undefined, 'http' as const]) {
			const app = new App();
			const stack = new Stack(app, `FH-${apiType ?? 'default'}`, {
				env: { account: '111111111111', region: 'us-west-2' },
			});
			buildApiGw(stack, staticPlan, apiType);
			const t = Template.fromStack(stack);
			t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
			t.resourceCountIs('AWS::ApiGateway::RestApi', 0);
		}
	});

	it("renders a REST API for apiType: 'rest' (for use behind a custom domain / CloudFront)", () => {
		const app = new App();
		const stack = new Stack(app, 'FR', { env: { account: '111111111111', region: 'us-west-2' } });
		buildApiGw(stack, staticPlan, 'rest');
		const t = Template.fromStack(stack);
		t.resourceCountIs('AWS::ApiGateway::RestApi', 1);
		t.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
	});
});

describe('apiGatewayDoor — free-form build', () => {
  it('is the api-gateway service', () => assert.equal(apiGatewayDoor.service, 'api-gateway'));
  it('builds a static plan and returns an https origin handle', () => {
    const app = new App();
    const stack = new Stack(app, 'S2', { env: { account: '111111111111', region: 'us-west-2' } });
    const res = buildApiGw(stack, staticPlan);
    assert.ok(res.url);
    assert.equal(res.originHandle?.protocol, 'https');
    // The host of `https://<id>.execute-api…` (index 1 of a split on '://').
    const apiId = Object.keys(Template.fromStack(stack).findResources('AWS::ApiGatewayV2::Api'))[0];
    assert.deepEqual(stack.resolve(res.originHandle?.domainName), {
      'Fn::Select': [1, { 'Fn::Split': ['://', { 'Fn::GetAtt': [apiId, 'ApiEndpoint'] }] }],
    });
  });
  it('the REST door: the origin handle is the custom domain (index 2 of https://host/…)', () => {
    const stack = new Stack(new App(), 'S4', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    const input = buildDoorInput({ plan: staticPlan, bucket, staticDir: '.' });
    const res = buildFrontDoor(
      stack,
      apiGatewayDoor,
      {
        ...input,
        apiType: 'rest',
        apiGateway: { plan: staticPlan, bucket, domain: { names: ['app.example.com'], hostedZone: 'example.com', hostedZoneId: 'Z1' } },
      },
      { wiringCheck: false },
    ).result;
    assert.equal(stack.resolve(res.originHandle.domainName), 'app.example.com');
  });
  it('builds with no feature check: a streaming-SSR plan builds (served buffered)', () => {
    const app = new App();
    const stack = new Stack(app, 'S3', { env: { account: '111111111111', region: 'us-west-2' } });
    const streamPlan: HostingPlan = {
      ...staticPlan,
      origins: [...staticPlan.origins, { id: 'blocks-server', kind: 'server' as const }],
      policies: { ...staticPlan.policies, hasServer: true },
    };
    assert.ok(buildApiGw(stack, streamPlan).url);
  });
});
