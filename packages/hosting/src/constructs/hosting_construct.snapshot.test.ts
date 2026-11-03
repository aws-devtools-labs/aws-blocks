import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { App, Stack } from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { HostingConstruct } from './hosting_construct.js';
import { DeployManifest } from '../manifest/types.js';

void describe('HostingConstruct — snapshot test', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-snapshot-test-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('SPA template renders without error', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: tmpDir },
      routes: [{ pattern: '/*', target: 'static' }],
      buildId: 'snap-spa-1',
    };

    new HostingConstruct(stack, 'Hosting', { manifest });

    const template = Template.fromStack(stack);
    const json = template.toJSON();
    assert.ok(json.Resources, 'Template should have resources');
    assert.ok(Object.keys(json.Resources).length > 0);
  });

  void it('SSR template renders without error', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const bundleDir = path.join(tmpDir, 'bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, 'index.mjs'),
      'export const handler = async () => {};',
    );

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: bundleDir,
          handler: 'index.handler',
          placement: 'regional',
          streaming: true,
        },
      },
      staticAssets: { directory: tmpDir },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/*', target: 'default' },
      ],
      buildId: 'snap-ssr-1',
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    const json = template.toJSON();
    assert.ok(json.Resources);
    assert.ok(Object.keys(json.Resources).length > 5);
  });
});
