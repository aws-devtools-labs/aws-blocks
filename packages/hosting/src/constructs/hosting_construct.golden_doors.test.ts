// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Golden regression guard for the built-in non-CloudFront doors (ALB, API
 * Gateway HTTP API) and a bring-your-own door that routes at the door (the
 * default `routing: 'door'`).
 *
 * Each case pins the WHOLE synthesized template, normalized only for content
 * hashes (asset hashes change with any bundled file), so any change to what
 * these doors deploy — a listener rule, a proxy's inline code, an environment
 * variable, a logical id — fails here. A door that opts into app routing
 * (`routing: 'app'`) is a separate mode; every door that doesn't must keep
 * synthesizing exactly these templates.
 *
 * Regenerate intentionally (after a REVIEWED change, or an aws-cdk-lib bump
 * that changes its own resources) with `UPDATE_GOLDEN=1`.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import type { DeployManifest } from '../manifest/types.js';
import { cf } from './cf_helpers.js';
import { defineFrontDoor } from './front_door.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

// Tests run from `dist/constructs`; the goldens live in the committed source.
const GOLDEN_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'constructs', '__golden__');

const API_URL = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api';

/** The whole template, with content hashes normalized. */
const normalizedTemplate = (stack: Stack): string =>
	`${JSON.stringify(Template.fromStack(stack).toJSON(), null, 2).replace(/[a-f0-9]{64}/g, '<hash>')}\n`;

const checkTemplateGolden = (name: string, stack: Stack): void => {
	const file = path.join(GOLDEN_DIR, `${name}.template.json`);
	const serialized = normalizedTemplate(stack);
	if (process.env.UPDATE_GOLDEN === '1') {
		fs.mkdirSync(GOLDEN_DIR, { recursive: true });
		fs.writeFileSync(file, serialized);
		return;
	}
	assert.ok(fs.existsSync(file), `Missing golden ${file}: run with UPDATE_GOLDEN=1 to create it.`);
	assert.equal(
		serialized,
		fs.readFileSync(file, 'utf8'),
		`The '${name}' template changed. If intentional and REVIEWED, regenerate with UPDATE_GOLDEN=1.`,
	);
};

/** A bring-your-own CloudFront door that renders the route table with the `cf.*` helpers. */
const helperDoor = defineFrontDoor({
	service: 'golden-cdn',
	build(scope, { app, origins }) {
		const dist = new Distribution(scope, 'Cdn', {
			defaultBehavior: { origin: cf.origin(origins.server ?? origins.assets) },
			additionalBehaviors: { ...cf.behaviors(app.routes), ...cf.apiBehaviors(origins.api) },
		});
		return { url: `https://${dist.distributionDomainName}` };
	},
});

void describe('HostingConstruct — golden templates of the doors that route at the door', () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-golden-doors-'));
		fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const rules = {
		redirects: [{ source: '/old/*', destination: '/new/*', statusCode: 308 as const }],
		headers: [{ source: '/assets/*', headers: { 'x-golden': '1' } }],
	};

	const spaManifest = (): DeployManifest => ({
		version: 1,
		buildId: 'golden-door-spa',
		compute: {},
		staticAssets: { directory: tmpDir, spaFallback: true },
		routes: [
			{ pattern: '/assets/*', target: 'static' },
			{ pattern: '/*', target: 'static' },
		],
		...rules,
	});

	/** A Lambda Web Adapter server (Astro / SvelteKit / Nitro node-server shape). */
	const lwaManifest = (): DeployManifest => {
		const bundle = path.join(tmpDir, 'lwa');
		fs.mkdirSync(bundle, { recursive: true });
		fs.writeFileSync(path.join(bundle, 'run.sh'), '#!/bin/sh\nexec node index.mjs\n');
		return {
			version: 1,
			buildId: 'golden-door-lwa',
			compute: {
				default: { type: 'http-server', bundle, entrypoint: 'run.sh', port: 3000, placement: 'regional' },
			},
			staticAssets: { directory: tmpDir },
			routes: [
				{ pattern: '/assets/*', target: 'static' },
				{ pattern: '/*', target: 'default' },
			],
			...rules,
		};
	};

	/** A native, buffered Lambda handler server (Nitro `aws-lambda` shape). */
	const handlerManifest = (streaming: boolean): DeployManifest => {
		const bundle = path.join(tmpDir, streaming ? 'streaming' : 'handler');
		fs.mkdirSync(bundle, { recursive: true });
		fs.writeFileSync(path.join(bundle, 'index.mjs'), 'export const handler = async () => ({ statusCode: 200 });\n');
		return {
			version: 1,
			buildId: streaming ? 'golden-door-stream' : 'golden-door-handler',
			compute: {
				default: { type: 'handler', bundle, handler: 'index.handler', placement: 'regional', streaming },
			},
			staticAssets: { directory: tmpDir },
			routes: [
				{ pattern: '/_next/static/*', target: 'static' },
				{ pattern: '/*', target: 'default' },
			],
			...rules,
		};
	};

	const synth = (manifest: DeployManifest, frontDoor: HostingConstructProps['frontDoor']): Stack => {
		const stack = new Stack(new App(), 'GoldenDoors', { env: { account: '111111111111', region: 'us-west-2' } });
		new HostingConstruct(stack, 'Hosting', {
			manifest,
			frontDoor,
			skipRegionValidation: true,
			backendApi: { url: API_URL, paths: ['/hooks/golden'] },
		});
		return stack;
	};

	const cases: Array<[string, () => DeployManifest, HostingConstructProps['frontDoor']]> = [
		['door-alb-spa', spaManifest, { kind: 'alb' }],
		['door-alb-lwa', lwaManifest, { kind: 'alb' }],
		['door-alb-handler', () => handlerManifest(false), { kind: 'alb' }],
		['door-apigw-http-spa', spaManifest, { kind: 'apiGateway' }],
		['door-apigw-http-lwa', lwaManifest, { kind: 'apiGateway' }],
		['door-custom-spa', spaManifest, { kind: 'custom', door: helperDoor }],
		['door-custom-ssr', () => handlerManifest(true), { kind: 'custom', door: helperDoor }],
	];
	for (const [name, manifest, frontDoor] of cases) {
		void it(`${name}: the template is unchanged`, () => {
			checkTemplateGolden(name, synth(manifest(), frontDoor));
		});
	}
});
