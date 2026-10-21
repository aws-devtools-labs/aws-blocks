import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, CfnResource, Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { HostingPlan } from '../plan/types.js';
import { cf } from './cf_helpers.js';
import { buildFrontDoor } from './custom_door.js';
import { buildDoorInput } from './door_input.js';
import { type DoorInput, defineFrontDoor, type FrontDoorResult } from './front_door.js';

const plan: HostingPlan = {
	origins: [{ id: 'blocks-s3', kind: 'static' }],
	routes: {
		entries: [
			{ pattern: '/assets/*', kind: 'static' },
			{ pattern: '/*', kind: 'static' },
		],
		redirects: [],
		headers: [],
	},
	policies: { spaFallback: true, hasServer: false, skewEnabled: false },
	release: { buildId: 'testbuild' },
};

const API_URL = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks';

const setup = (opts: { api?: boolean; rawRoutes?: string[] } = {}) => {
	const stack = new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-east-1' } });
	const input = buildDoorInput({
		plan,
		bucket: new Bucket(stack, 'Assets'),
		staticDir: '.',
		...(opts.api ? { api: { url: API_URL, paths: opts.rawRoutes } } : {}),
	});
	return { stack, input };
};

/** A door that builds a distribution with the cf.* helpers (assets + optionally the API). */
const helperDoor = (opts: { wireApi?: boolean; wireAssets?: boolean } = {}) =>
	defineFrontDoor({
		service: 'helper-cdn',
		build(scope, { app, origins }) {
			const dist = new Distribution(scope, 'Cdn', {
				defaultBehavior: {
					origin:
						opts.wireAssets === false
							? S3BucketOrigin.withOriginAccessControl(origins.assets.bucket)
							: cf.origin(origins.assets),
				},
				additionalBehaviors: {
					...(opts.wireAssets === false ? {} : cf.behaviors(app.routes)),
					...(opts.wireApi === false ? {} : cf.apiBehaviors(origins.api)),
				},
			});
			return { url: `https://${dist.distributionDomainName}` };
		},
	});

describe('buildFrontDoor — the url is required', () => {
	for (const [label, result] of [
		['missing', {}],
		['empty', { url: '' }],
	] as const) {
		it(`a ${label} url fails synth with MissingFrontDoorUrlError`, () => {
			const { stack, input } = setup();
			const door = defineFrontDoor({
				service: 'no-url',
				// A JS door (or an `as` cast) can still return no url — the runtime check is the guard.
				build: () => result as FrontDoorResult,
			});
			assert.throws(
				() => buildFrontDoor(stack, door, input, { wiringCheck: false }),
				(err: Error) => err.name === 'MissingFrontDoorUrlError' && /no-url/.test(err.message),
			);
		});
	}

	it('rejects something that is not a front door (no service / no build)', () => {
		const { stack, input } = setup();
		const notADoor = { service: '', build: undefined } as unknown as Parameters<typeof buildFrontDoor>[1];
		assert.throws(() => buildFrontDoor(stack, notADoor, input), (err: Error) => err.name === 'InvalidPropsError');
	});
});

describe('buildFrontDoor — the url is a bare origin', () => {
	it('drops the trailing slash a door returns (the browser Origin has none, so CORS would reject it)', () => {
		const { stack, input } = setup();
		const door = defineFrontDoor({ service: 'slash', build: () => ({ url: 'https://app.example.com/' }) });
		const { result } = buildFrontDoor(stack, door, input, { wiringCheck: false });
		assert.equal(result.url, 'https://app.example.com');
		assert.equal(result.originHandle.domainName, 'app.example.com');
	});

	it('drops it after a token too, and leaves a url without one unchanged', () => {
		const { stack, input } = setup();
		const token = new Bucket(stack, 'Tok').bucketDomainName;
		const withSlash = defineFrontDoor({ service: 'tok', build: () => ({ url: `https://${token}//` }) });
		assert.equal(buildFrontDoor(stack, withSlash, input, { wiringCheck: false }).result.url, `https://${token}`);
		const bare = defineFrontDoor({ service: 'bare', build: () => ({ url: `https://${token}` }) });
		assert.equal(buildFrontDoor(stack, bare, input, { wiringCheck: false }).result.url, `https://${token}`);
	});
});

describe('buildFrontDoor — originHandle', () => {
	it('is derived from the url (host + scheme) when the door omits it', () => {
		const { stack, input } = setup();
		const door = defineFrontDoor({
			service: 'derived',
			build(scope) {
				new CfnResource(scope, 'Res', { type: 'AWS::CloudFormation::WaitConditionHandle' });
				return { url: 'https://edge.example.com' };
			},
		});
		const { result } = buildFrontDoor(stack, door, input, { wiringCheck: false });
		assert.deepEqual(result.originHandle, { domainName: 'edge.example.com', protocol: 'https' });
	});

	it('a door-provided originHandle wins (e.g. a private inner address)', () => {
		const { stack, input } = setup();
		const door = defineFrontDoor({
			service: 'explicit',
			build: () => ({
				url: 'https://app.example.com',
				originHandle: { domainName: 'internal-alb.local', protocol: 'http' },
			}),
		});
		const { result } = buildFrontDoor(stack, door, input, { wiringCheck: false });
		assert.deepEqual(result.originHandle, { domainName: 'internal-alb.local', protocol: 'http' });
	});
});

describe('buildFrontDoor — the routes/API wiring check', () => {
	it('passes for a door that wires the assets and the API with the cf.* helpers', () => {
		const { stack, input } = setup({ api: true });
		const { wiring } = buildFrontDoor(stack, helperDoor(), input);
		assert.ok(wiring.origins.has('assets'));
		assert.ok(wiring.apiPaths.has('/aws-blocks/*'));
	});

	it('fails with ProxySameOriginApi when the app has an API and none of its paths were wired', () => {
		const { stack, input } = setup({ api: true });
		assert.throws(
			() => buildFrontDoor(stack, helperDoor({ wireApi: false }), input),
			(err: Error) =>
				err.name === 'UnsupportedFrontDoorError' &&
				/Front door 'helper-cdn' cannot serve this deploy/.test(err.message) &&
				/ProxySameOriginApi: the app has an API, but none of \/aws-blocks\/\* were wired — use cf\.apiBehaviors\(origins\.api\)/.test(
					err.message,
				),
		);
	});

	it('does not require API wiring when the app has no API', () => {
		const { stack, input } = setup();
		assert.doesNotThrow(() => buildFrontDoor(stack, helperDoor({ wireApi: false }), input));
	});

	it('fails with ServeStaticAsset when nothing reaches the assets', () => {
		const { stack, input } = setup();
		assert.throws(
			() => buildFrontDoor(stack, helperDoor({ wireAssets: false }), input),
			(err: Error) => err.name === 'UnsupportedFrontDoorError' && /ServeStaticAsset/.test(err.message),
		);
	});

	it('warns (does not fail) when some API paths — e.g. a raw route — are left unwired', () => {
		const { stack, input } = setup({ api: true, rawRoutes: ['/webhooks/*'] });
		const door = defineFrontDoor({
			service: 'partial',
			build(scope, { origins }) {
				const dist = new Distribution(scope, 'Cdn', {
					defaultBehavior: { origin: cf.origin(origins.assets) },
					additionalBehaviors: { '/aws-blocks/*': { origin: cf.origin(origins.api ?? origins.assets) } },
				});
				if (origins.api) cf.recordWired(origins.api, ['/aws-blocks/*']);
				return { url: `https://${dist.distributionDomainName}` };
			},
		});
		buildFrontDoor(stack, door, input);
		Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('/webhooks/\\*'));
	});

	describe('escape hatches for a door wired with raw CDK', () => {
		/** Wires everything correctly, but by hand — invisible to the record. */
		const rawCdkDoor = (declare: boolean) =>
			defineFrontDoor({
				service: 'raw-cdk',
				build(scope, { origins }: DoorInput) {
					const dist = new Distribution(scope, 'Cdn', {
						defaultBehavior: { origin: S3BucketOrigin.withOriginAccessControl(origins.assets.bucket) },
					});
					if (declare) {
						cf.recordWired(origins.assets);
						if (origins.api) cf.recordWired(origins.api);
					}
					return { url: `https://${dist.distributionDomainName}` };
				},
			});

		it('a raw-CDK door that declares nothing gets the (false) alarm — the documented limit', () => {
			const { stack, input } = setup({ api: true });
			assert.throws(() => buildFrontDoor(stack, rawCdkDoor(false), input), /ServeStaticAsset[\s\S]*ProxySameOriginApi/);
		});

		it('cf.recordWired(...) declares the hand-wired origins and paths', () => {
			const { stack, input } = setup({ api: true });
			assert.doesNotThrow(() => buildFrontDoor(stack, rawCdkDoor(true), input));
		});

		it('wiringCheck: false turns the check off', () => {
			const { stack, input } = setup({ api: true });
			assert.doesNotThrow(() => buildFrontDoor(stack, rawCdkDoor(false), input, { wiringCheck: false }));
		});
	});
});
