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
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { HostingConstruct } from './hosting_construct.js';
import type { DeployManifest } from '../manifest/types.js';

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
    // No support stack was synthesized. The id carries a node-addr suffix
    // (`-CfMonitoring-<addr>`), so scan by prefix; an exact-name lookup
    // would pass even if one were wrongly synthesized.
    assert.ok(
      !app.node.children.some(
        (c) => c instanceof Stack && c.node.id.startsWith('TestStack-CfMonitoring'),
      ),
      'no us-east-1 support stack should be synthesized in-region',
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

    // A sibling us-east-1 support stack exists and holds the alarm. Its
    // id carries a node-addr suffix so two Hosting constructs in one
    // stage don't collide, so match by prefix.
    const support = app.node.children.find(
      (c) =>
        c instanceof Stack &&
        c.node.id.startsWith('TestStack-CfMonitoring'),
    ) as Stack | undefined;
    assert.ok(support, 'expected a TestStack-CfMonitoring-* support stack');
    assert.strictEqual(support.region, 'us-east-1');

    const supportTemplate = Template.fromStack(support);
    supportTemplate.resourcePropertiesCountIs(
      'AWS::CloudWatch::Alarm',
      Match.objectLike({
        Namespace: 'AWS/CloudFront',
        MetricName: '5xxErrorRate',
        Threshold: 5,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        EvaluationPeriods: 1,
        Period: 300,
        Statistic: 'Average',
        TreatMissingData: 'notBreaching',
        Dimensions: Match.arrayWith([
          Match.objectLike({ Name: 'Region', Value: 'Global' }),
        ]),
      }),
      1,
    );
    // Its own SNS topic. No forwarder subscription — consolidation is via
    // two topics, not runtime message forwarding.
    supportTemplate.resourceCountIs('AWS::SNS::Topic', 1);
    // The us-east-1 topic ARN is surfaced by logical id.
    supportTemplate.hasOutput('MonitoringTopicArnUsEast1', Match.anyValue());
  });

  // ---- (v) Off-region: endpoint subscriptions reach BOTH topics ----
  // A single email/URL subscription entry applied to both the regional
  // and us-east-1 topics must land on each, with no synth collision.
  void it('applies email + URL subscriptions to both topics off-region', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      monitoring: {
        subscriptions: [
          new subs.EmailSubscription('oncall@example.com'),
          new subs.UrlSubscription('https://alerts.example.com/hook'),
        ],
      },
    });

    // Regional topic carries both subscriptions.
    const regional = Template.fromStack(stack);
    regional.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'oncall@example.com',
    });
    regional.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'https',
      Endpoint: 'https://alerts.example.com/hook',
    });

    // us-east-1 support stack's topic carries them too.
    const support = app.node.children.find(
      (c) =>
        c instanceof Stack &&
        c.node.id.startsWith('TestStack-CfMonitoring'),
    ) as Stack | undefined;
    assert.ok(support, 'expected a TestStack-CfMonitoring-* support stack');
    const supportTemplate = Template.fromStack(support);
    supportTemplate.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'oncall@example.com',
    });
    supportTemplate.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'https',
      Endpoint: 'https://alerts.example.com/hook',
    });
  });

  // ---- (ii) Off-region + unresolved account → warn-and-skip ----
  // We can't build the us-east-1 support stack without a concrete account
  // (cross-region synth needs it), but hard-throwing would take down the
  // working regional alarms too. So skip ONLY the CloudFront alarm and warn
  // loudly. A visible warning is not the silent-alarm bug #481 is about.
  // (See docs/DECISIONS.md D-016.)
  void it('warns and skips the CloudFront alarm off-region when the account is unresolved (no throw)', () => {
    const staticDir = createStaticDir();
    const app = new App();
    // region resolved (off-region) but account left unresolved.
    const stack = new Stack(app, 'TestStack', {
      env: { region: 'ap-northeast-1' },
    });

    // Must NOT throw.
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    // No us-east-1 support stack was synthesized.
    assert.ok(
      !app.node.children.some(
        (c) => c instanceof Stack && c.node.id.startsWith('TestStack-CfMonitoring'),
      ),
      'no support stack should be synthesized when the account is unresolved',
    );

    // The regional alarms (e.g. SSR/DLQ) are unaffected: monitoring is
    // still on, just missing the one CloudFront alarm.
    const template = Template.fromStack(stack);
    template.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', CF_ALARM, 0);

    // And the skip is loud.
    Annotations.fromStack(stack).hasWarning(
      '*',
      Match.stringLikeRegexp('Skipping the off-region CloudFront 5xx alarm'),
    );
  });
});
