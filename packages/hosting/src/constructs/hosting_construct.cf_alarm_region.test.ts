/**
 * HostingConstruct — CloudFront alarm region wiring (issue #481).
 *
 * AWS/CloudFront metrics only publish in us-east-1 and a CloudWatch
 * alarm can only evaluate a metric in its own region. These tests cover
 * the two-topic fix: off-region, the CloudFront 5xx alarm is placed in a
 * hosting-owned us-east-1 support stack with its own SNS topic; in
 * us-east-1 the behavior is unchanged (single stack, alarm local).
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { HostingConstruct } from './hosting_construct.js';
import { DeployManifest } from '../manifest/types.js';
import { HostingError } from '../hosting_error.js';

let tmpDir: string;

const createStaticDir = (): string => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-cfregion-'));
  fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
  return tmpDir;
};

const spaManifest = (staticDir: string): DeployManifest => ({
  version: 1,
  compute: {},
  staticAssets: { directory: staticDir },
  routes: [{ pattern: '/*', target: 'static' }],
  buildId: 'cfregion-test-1',
});

const CF_ALARM = Match.objectLike({ Namespace: 'AWS/CloudFront' });

void describe('HostingConstruct — CloudFront alarm region (#481)', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- (iv) In-region: unchanged single-stack behavior ----
  void it('creates the CloudFront alarm locally in a single stack when region is us-east-1', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    new HostingConstruct(stack, 'Hosting', { manifest: spaManifest(staticDir) });

    const template = Template.fromStack(stack);
    // Alarm lives in this (us-east-1) stack.
    template.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', CF_ALARM, 1);
    // No second stack was synthesized.
    assert.strictEqual(
      app.node.tryFindChild('TestStack-CfMonitoring'),
      undefined,
    );
  });

  // ---- (i) Off-region: two stacks, CF alarm in us-east-1 stack ----
  void it('places the CloudFront alarm in a us-east-1 support stack when off-region', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    new HostingConstruct(stack, 'Hosting', { manifest: spaManifest(staticDir) });

    // The regional stack has NO CloudFront alarm...
    const regional = Template.fromStack(stack);
    regional.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', CF_ALARM, 0);

    // A sibling us-east-1 support stack exists and holds the alarm.
    const support = app.node.tryFindChild('TestStack-CfMonitoring') as Stack;
    assert.ok(support, 'expected a TestStack-CfMonitoring support stack');
    assert.strictEqual(support.region, 'us-east-1');

    const supportTemplate = Template.fromStack(support);
    supportTemplate.resourcePropertiesCountIs(
      'AWS::CloudWatch::Alarm',
      Match.objectLike({
        Namespace: 'AWS/CloudFront',
        MetricName: '5xxErrorRate',
        Threshold: 5,
        TreatMissingData: 'notBreaching',
      }),
      1,
    );
    // Its own SNS topic (two-topic design). No forwarder subscription —
    // consolidation is via two topics, not runtime message forwarding.
    supportTemplate.resourceCountIs('AWS::SNS::Topic', 1);
    supportTemplate.resourceCountIs('AWS::SNS::Subscription', 0);
    // The us-east-1 topic ARN is surfaced as an output of the support stack.
    supportTemplate.hasOutput(
      '*',
      Match.objectLike({ Description: Match.stringLikeRegexp('us-east-1') }),
    );
  });

  // ---- (iii) 'skip' mode: warning, no second stack ----
  void it("emits a warning and creates no support stack when cloudFrontAlarm is 'skip'", () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      monitoring: { cloudFrontAlarm: 'skip' },
    });

    const template = Template.fromStack(stack);
    template.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', CF_ALARM, 0);
    assert.strictEqual(
      app.node.tryFindChild('TestStack-CfMonitoring'),
      undefined,
    );
    Annotations.fromStack(stack).hasWarning(
      '*',
      Match.stringLikeRegexp('CloudFront 5xx alarm skipped'),
    );
  });

  // ---- (ii) Off-region without a concrete account → throws ----
  void it('throws MonitoringEnvRequiredError off-region when the account is unresolved', () => {
    const staticDir = createStaticDir();
    const app = new App();
    // region resolved (off-region) but account left unresolved.
    const stack = new Stack(app, 'TestStack', {
      env: { region: 'ap-northeast-1' },
    });
    assert.throws(
      () =>
        new HostingConstruct(stack, 'Hosting', {
          manifest: spaManifest(staticDir),
        }),
      (err: unknown) =>
        err instanceof HostingError &&
        err.code === 'MonitoringEnvRequiredError',
    );
  });
});
