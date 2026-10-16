/**
 * Golden regression guard for the DEFAULT CloudFront path.
 *
 * The sibling `*.snapshot.test.ts` only smoke-checks that synth produces
 * resources; it does NOT catch logical-ID / resource drift — which is the exact
 * danger of any refactor that touches the CloudFront construction path (a moved
 * logical ID makes CloudFormation REPLACE the resource → S3 data loss / CF domain
 * churn; see hosting-revamp doc 10 §10.1).
 *
 * This test pins the `{ logicalId → resource Type }` map + count of the default
 * CloudFront stack (SPA + SSR) to a committed golden. Any rename / add / drop of
 * a resource fails here, locally, with no deploy. Property-level replacement
 * (e.g. a changed bucket name) is caught by `cdk diff` in the deploy step; this
 * guard targets the logical-ID-drift class specifically.
 *
 * Regenerate intentionally (after a REVIEWED change) with `UPDATE_GOLDEN=1`.
 */
import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { HostingConstruct } from './hosting_construct.js';
import type { DeployManifest } from '../manifest/types.js';

// Tests run from `dist/constructs`; keep the goldens in the committed source at
// `src/constructs/__golden__` so they are version-controlled and reviewed.
const GOLDEN_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'constructs', '__golden__');

/** Stable `{ logicalId: Type }` map — the drift-sensitive projection we pin. */
const resourceMap = (stack: Stack): Record<string, string> => {
  const resources = (Template.fromStack(stack).toJSON().Resources ?? {}) as Record<string, { Type: string }>;
  const map: Record<string, string> = {};
  for (const [id, r] of Object.entries(resources)) map[id] = r.Type;
  return map;
};

const checkGolden = (name: string, map: Record<string, string>) => {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const serialized = `${JSON.stringify(map, Object.keys(map).sort(), 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, serialized);
    return;
  }
  assert.ok(fs.existsSync(file), `Missing golden ${file} — run with UPDATE_GOLDEN=1 to create it.`);
  const golden = fs.readFileSync(file, 'utf8');
  assert.equal(
    serialized,
    golden,
    `Default CloudFront template drifted for '${name}'. If intentional and REVIEWED, regenerate with UPDATE_GOLDEN=1.`,
  );
};

void describe('HostingConstruct — golden (default CloudFront) resource map', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-golden-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  void it('SPA default (CloudFront → S3) resource map is unchanged', () => {
    const stack = new Stack(new App(), 'TestStack');
    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: tmpDir },
      routes: [{ pattern: '/*', target: 'static' }],
      buildId: 'golden-spa',
    };
    new HostingConstruct(stack, 'Hosting', { manifest });
    checkGolden('spa-cloudfront', resourceMap(stack));
  });

  void it('SSR default (CloudFront → S3 + server) resource map is unchanged', () => {
    const stack = new Stack(new App(), 'TestStack');
    const bundleDir = path.join(tmpDir, 'bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'index.mjs'), 'export const handler = async () => {};');
    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: { type: 'handler', bundle: bundleDir, handler: 'index.handler', placement: 'regional', streaming: true },
      },
      staticAssets: { directory: tmpDir },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/*', target: 'default' },
      ],
      buildId: 'golden-ssr',
    };
    new HostingConstruct(stack, 'Hosting', { manifest, skipRegionValidation: true });
    checkGolden('ssr-cloudfront', resourceMap(stack));
  });
});
