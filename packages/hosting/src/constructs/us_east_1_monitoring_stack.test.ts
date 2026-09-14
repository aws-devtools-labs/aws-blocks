/**
 * UsEast1MonitoringStack — off-region CloudFront alarm support stack (issue #481).
 *
 * The stack always creates its own encrypted us-east-1 topic, wires the
 * CloudFront 5xx alarm to it, and applies any subscriptions passed by the
 * parent (the same list applied to the regional topic).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { UsEast1MonitoringStack } from './us_east_1_monitoring_stack.js';

void describe('UsEast1MonitoringStack', () => {
  const build = (subscriptions?: subs.EmailSubscription[]) => {
    const app = new App();
    const stack = new UsEast1MonitoringStack(app, 'CfMon', {
      env: { account: '123456789012', region: 'us-east-1' },
      distributionId: 'E1234567890ABC',
      subscriptions,
    });
    return Template.fromStack(stack);
  };

  void it('creates its own encrypted topic and KMS key', () => {
    const template = build();
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.hasResourceProperties('AWS::SNS::Topic', {
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  void it('creates the CloudFront 5xx alarm with full parity to the regional one', () => {
    const template = build();
    template.hasResourceProperties(
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
    );
  });

  void it('applies provided subscriptions to its topic', () => {
    const template = build([new subs.EmailSubscription('oncall@example.com')]);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'oncall@example.com',
    });
  });

  void it('surfaces the topic ARN as MonitoringTopicArnUsEast1', () => {
    const template = build();
    template.hasOutput('MonitoringTopicArnUsEast1', Match.anyValue());
  });

  void it('exposes topic and alarm on the construct', () => {
    const app = new App();
    const stack = new UsEast1MonitoringStack(app, 'CfMon', {
      env: { account: '123456789012', region: 'us-east-1' },
      distributionId: 'E1234567890ABC',
    });
    assert.ok(stack.topic, 'topic should be exposed');
    assert.ok(stack.alarm, 'alarm should be exposed');
  });
});
