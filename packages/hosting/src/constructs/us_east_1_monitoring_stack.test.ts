/**
 * UsEast1MonitoringStack — BYO-topic behavior (issue #481).
 *
 * The support stack normally creates its own encrypted us-east-1 topic,
 * but a caller may supply an existing us-east-1 topic. When they do, no
 * new topic/key is created and the alarm action targets the supplied
 * topic.
 */
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { UsEast1MonitoringStack } from './us_east_1_monitoring_stack.js';

void describe('UsEast1MonitoringStack — BYO topic', () => {
  void it('reuses a supplied topic: no new topic or KMS key, alarm targets it', () => {
    const app = new App();
    // An imported us-east-1 topic (BYO by ARN — no cross-stack export).
    const arnStack = new Stack(app, 'ArnStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:byo-alarm-topic';
    const userTopic = Topic.fromTopicArn(arnStack, 'UserTopic', topicArn);

    const stack = new UsEast1MonitoringStack(app, 'CfMon', {
      env: { account: '123456789012', region: 'us-east-1' },
      distributionId: 'E1234567890ABC',
      snsTopic: userTopic,
    });
    const template = Template.fromStack(stack);

    // The support stack created neither a topic nor an encryption key.
    template.resourceCountIs('AWS::SNS::Topic', 0);
    template.resourceCountIs('AWS::KMS::Key', 0);

    // The alarm exists and its action is the supplied (imported) topic ARN.
    template.hasResourceProperties(
      'AWS::CloudWatch::Alarm',
      Match.objectLike({
        Namespace: 'AWS/CloudFront',
        MetricName: '5xxErrorRate',
        AlarmActions: [topicArn],
      }),
    );
  });
});
