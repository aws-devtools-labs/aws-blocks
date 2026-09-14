import type { Construct } from 'constructs';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { type ITopic, type ITopicSubscription, Topic } from 'aws-cdk-lib/aws-sns';
import { createAlarmTopicKey } from './monitoring_construct.js';

/**
 * Props for {@link UsEast1MonitoringStack}.
 */
export type UsEast1MonitoringStackProps = StackProps & {
  /**
   * CloudFront distribution id to alarm on.
   *
   * On the default path the parent passes `distribution.distributionId`,
   * an unresolved cross-stack token; because this stack is in a different
   * region, CDK bridges it with its standard cross-region export
   * writer/reader custom resources (added to both stacks automatically).
   * A caller supplying a concrete id string avoids that reference.
   */
  distributionId: string;
  /**
   * Subscriptions to attach to this stack's us-east-1 alarm topic. The
   * parent passes the same list it applies to the regional topic, so one
   * subscription entry reaches both topics. Applied via
   * `topic.addSubscription`.
   */
  subscriptions?: ITopicSubscription[];
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
 * This stack owns its OWN us-east-1 alarm topic (no cross-region SNS
 * plumbing, no forwarder Lambda). The parent applies the same
 * `subscriptions` list to this topic as to the regional one, so callers
 * subscribe in one place and both topics are covered. The topic ARN is
 * also surfaced as the `MonitoringTopicArnUsEast1` output for operators
 * who want the raw ARN.
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

    this.encryptionKey = createAlarmTopicKey(this);
    this.topic = new Topic(this, 'AlarmTopicUsEast1', {
      masterKey: this.encryptionKey,
    });
    for (const sub of props.subscriptions ?? []) {
      this.topic.addSubscription(sub);
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

    // Surface the us-east-1 topic ARN as an output of THIS stack for
    // operators who want the raw ARN. Subscriptions passed via props are
    // already attached above, so the blessed path needs no manual step.
    // (Note: the alarm's distributionId is a cross-region reference CDK
    // bridges with export writer/reader custom resources — see the
    // `distributionId` prop doc; this output is not what avoids that.)
    new CfnOutput(this, 'MonitoringTopicArnUsEast1', {
      value: this.topic.topicArn,
      description:
        'SNS topic (us-east-1) for the CloudFront 5xx alarm. The hosting ' +
        'monitoring.subscriptions are already attached; this ARN is for ' +
        'operators who want to subscribe manually. The CloudFront alarm ' +
        'lives in this us-east-1 stack because AWS/CloudFront metrics only ' +
        'exist in us-east-1.',
    });
  }
}
