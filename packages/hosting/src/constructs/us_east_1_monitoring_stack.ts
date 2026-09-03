import { Construct } from 'constructs';
import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { ITopic, Topic } from 'aws-cdk-lib/aws-sns';
import { createAlarmTopicKey } from './monitoring_construct.js';

/**
 * Props for {@link UsEast1MonitoringStack}.
 */
export type UsEast1MonitoringStackProps = StackProps & {
  /**
   * CloudFront distribution id to alarm on. Passed as a plain string so
   * this us-east-1 stack takes no cross-region CDK reference on the
   * regional hosting stack.
   */
  distributionId: string;
  /**
   * BYO SNS topic for the alarm action. When omitted an encrypted topic
   * is created in THIS (us-east-1) stack and exposed via `topic` for the
   * operator to subscribe to (surfaced by the parent as the
   * `MonitoringTopicArnUsEast1` output). Supply this only if you already
   * have a us-east-1 topic — a regional topic cannot be used because a
   * CloudWatch alarm's SNS action must target a topic in the alarm's own
   * region.
   */
  snsTopic?: ITopic;
};

/**
 * Hosting-owned **us-east-1** support stack that holds the CloudFront
 * 5xx alarm (issue #481).
 *
 * `AWS/CloudFront` metrics are published only in us-east-1, and a
 * CloudWatch alarm can only evaluate a metric in its own region
 * (confirmed by the CloudWatch docs — "Cross-Region functionality is
 * not supported for alarms" — and rejected by aws-cdk-lib at synth). An
 * off-region hosting stack therefore cannot host a working CloudFront
 * alarm; the parent creates this stack next to it (same account,
 * region pinned to us-east-1) so the alarm actually evaluates.
 *
 * Two-topic design: this stack owns its OWN us-east-1 alarm topic (no
 * cross-region SNS plumbing, no forwarder Lambda). The operator
 * subscribes to this topic's ARN — surfaced by the parent as
 * `MonitoringTopicArnUsEast1` — in addition to the regional
 * `MonitoringTopicArn`.
 */
export class UsEast1MonitoringStack extends Stack {
  /** The us-east-1 topic the CloudFront alarm publishes to. */
  readonly topic: ITopic;
  /** KMS key encrypting the auto-created topic (undefined for a BYO topic). */
  readonly encryptionKey?: IKey;
  /** The CloudFront 5xx alarm. */
  readonly alarm: Alarm;

  constructor(
    scope: Construct,
    id: string,
    props: UsEast1MonitoringStackProps,
  ) {
    super(scope, id, props);

    if (props.snsTopic) {
      this.topic = props.snsTopic;
    } else {
      this.encryptionKey = createAlarmTopicKey(this);
      this.topic = new Topic(this, 'AlarmTopic', {
        masterKey: this.encryptionKey,
      });
    }

    // Identical alarm config to the regional construct's original — just
    // re-homed to us-east-1 where the metric actually exists.
    this.alarm = new Alarm(this, 'CloudFront5xxRate', {
      metric: new Metric({
        namespace: 'AWS/CloudFront',
        metricName: '5xxErrorRate',
        dimensionsMap: {
          DistributionId: props.distributionId,
          // CloudFront metrics live in us-east-1 regardless of stack.
          Region: 'Global',
        },
        period: Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 5, // percent
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'CloudFront is returning 5xx for >=5% of requests over 5 minutes.',
    });
    this.alarm.addAlarmAction(new SnsAction(this.topic));

    // Surface the us-east-1 topic ARN as an output OF THIS stack (not the
    // regional one) so there is no cross-region reference — the operator
    // subscribes to this in addition to the regional MonitoringTopicArn.
    new CfnOutput(this, 'MonitoringTopicArnUsEast1', {
      value: this.topic.topicArn,
      description:
        'SNS topic (us-east-1) for the CloudFront 5xx alarm. Subscribe an ' +
        'endpoint here in addition to the regional MonitoringTopicArn — the ' +
        'CloudFront alarm lives in this us-east-1 stack because AWS/CloudFront ' +
        'metrics only exist in us-east-1.',
    });
  }
}
