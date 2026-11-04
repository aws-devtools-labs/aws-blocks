import { Construct } from 'constructs';
import { Annotations, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  Alarm,
  CfnAlarm,
  ComparisonOperator,
  MathExpression,
  Metric,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import { type IKey, Key } from 'aws-cdk-lib/aws-kms';
import type { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import {
  CfnSubscription,
  type ITopic,
  type ITopicSubscription,
  Topic,
} from 'aws-cdk-lib/aws-sns';

/**
 * Default CloudWatch alarm wiring (P3.1 + P3.2).
 *
 * The previous version of the construct created no alarms. Operators
 * found out about Lambda errors / 5xx spikes / poison-pill DLQ
 * messages from end-user reports — by which point the cause was old
 * enough that recent logs had been retention-rotated away. This
 * construct wires a small, opinionated default set:
 *
 *   - CloudFront 5xx error rate > 5% over 5 min
 *   - SSR Lambda error rate >= 1% of invocations over 5 min
 *     (CloudWatch math expression `errors / invocations * 100`, so the
 *     alarm scales with traffic instead of using an absolute count;
 *     tunable via `ssrErrorRatePercent`)
 *   - SSR Lambda throttles > 0 over 5 min
 *   - SQS DLQ depth >= 1 (any poison message)
 *
 * Monitoring defaults to on at the `HostingConstruct` surface
 * (`monitoring.enabled` is `@default true`). When enabled, the construct
 * always creates its own SNS topic and surfaces its ARN so the operator
 * can subscribe; there is no bring-your-own-topic path. Cost: pennies/month
 * at idle, scales with alarm-state changes (not requests), plus ~$1/month
 * for the alarm topic's KMS key.
 *
 * The auto-created topic is always encrypted with a dedicated
 * customer-managed KMS key. An AWS-managed key (`alias/aws/sns`)
 * cannot be used: its policy is not editable and does not grant
 * CloudWatch, so every alarm action fails with `KMSAccessDenied` and
 * notifications are dropped silently. See `createAlarmTopicKey`.
 */
export type MonitoringConstructProps = {
  enabled: boolean;
  /**
   * Subscriptions to attach to the auto-created alarm topic. The parent
   * passes the same list to the us-east-1 support stack so a single
   * entry reaches both topics. Applied via `topic.addSubscription`.
   */
  subscriptions?: ITopicSubscription[];
  /** CloudFront distribution to alarm on 5xx errors. */
  distribution?: Distribution;
  /** Primary SSR Lambda — error rate + throttle alarms. */
  ssrFunction?: LambdaFunction;
  /** Image-opt Lambda — error alarm. */
  imageFunction?: LambdaFunction;
  /** Revalidation worker DLQ — depth alarm. */
  revalidationDlq?: Queue;
  /**
   * SSR Lambda error-rate alarm threshold, as a **percentage** of
   * invocations over the evaluation window (`errors / invocations *
   * 100`). Rate-based so the alarm scales with traffic — an absolute
   * count is noise on a busy site and a missed outage on a quiet one.
   * @default 1 (alarm when >=1% of invocations error)
   */
  ssrErrorRatePercent?: number;
  /**
   * When `true` (default) the CloudFront 5xx alarm is created in THIS
   * (regional) construct. `AWS/CloudFront` metrics only publish in
   * us-east-1 and a CloudWatch alarm can only evaluate a metric in its
   * own region, so for an off-region hosting stack the parent sets this
   * to `false` and instead places the alarm in a dedicated us-east-1
   * support stack (issue #481). When `false` and a `distribution` is
   * supplied, the CF alarm is skipped here and `cloudFrontAlarmDeferred`
   * is set to `true`. The regional alarms (SSR/image/DLQ) are unaffected.
   * @default true
   */
  createCloudFrontAlarmLocally?: boolean;
};

/**
 * Create the customer-managed key that encrypts the alarm topic.
 *
 * CloudWatch calls KMS **directly** (not via SNS) when it publishes an
 * alarm notification to an encrypted topic, so the key policy needs an
 * explicit grant for the `cloudwatch.amazonaws.com` service principal.
 * Without it the alarm action fails with `KMSAccessDenied` and the
 * notification is dropped — the alarm still flips to ALARM in the
 * console, so the failure is invisible until someone notices the page
 * that never arrived. Account-root/IAM delegation (the only statement
 * on the default `Key` policy, and the only one some policy injectors
 * add) does NOT cover service principals.
 *
 * `resources: ['*']` is scoped to *this* key — a resource policy can
 * only speak for the resource it is attached to, and this key is
 * single-purpose (the alarm topic is its only user). The
 * `aws:SourceAccount` guard blocks the cross-account confused-deputy
 * case; it is `IfExists` because that key is only populated on direct
 * service-principal calls, and a hard `StringEquals` would
 * reintroduce the exact silent-deny this grant exists to prevent.
 */
export const createAlarmTopicKey = (scope: Construct): Key => {
  const key = new Key(scope, 'AlarmTopicKey', {
    description:
      'Encrypts CloudWatch alarm notifications published to the hosting alarm topic.',
    enableKeyRotation: true,
    // The key protects in-flight notifications only — nothing durable
    // is lost with the stack, so don't leave a billable orphan behind.
    removalPolicy: RemovalPolicy.DESTROY,
  });

  key.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsToPublishToEncryptedTopic',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
      conditions: {
        StringEqualsIfExists: {
          'aws:SourceAccount': Stack.of(scope).account,
        },
      },
    }),
  );

  return key;
};

/** Stable id of the no-subscriber warning; also the `acknowledgeWarning` id. */
export const MONITORING_NO_SUBSCRIBER_WARNING_ID =
  '@aws-blocks/hosting:MonitoringAlarmTopicHasNoSubscribers';

/**
 * Register a synth-time validation that warns when `topic` carries alarm
 * notifications it can deliver to no one. An alarm topic with no subscriber
 * can flip to ALARM but drop the notification silently — the gap the "no
 * silent gap" monitoring principle guards against. The topic ARN is also a
 * CloudFormation output for out-of-band subscription, but that is easy to
 * miss, so warn loudly.
 *
 * Judged on a single topic's OWN alarms and subscribers, so it is correct for
 * both the regional construct and the us-east-1 support stack — off-region the
 * 5xx alarm lives in its own stack with its own topic, and each must be
 * checked independently or that topic's undeliverable alarm goes unnoticed.
 *
 * Deferred to a validation (not an eager check) because delivery can be wired
 * AFTER construction: a caller may `topic.addSubscription(...)` directly, and
 * `LambdaSubscription` / `SqsSubscription` place their `CfnSubscription` in the
 * TARGET's stack (`subscriberScope`), so the whole app is searched, not just
 * this topic's stack. The topic is also treated as deliverable when every
 * alarm already routes to some OTHER action (the caller took delivery into
 * their own hands via `monitoring.alarms`), and skipped entirely when no alarm
 * is wired (nothing can enter ALARM, so the warning would be spurious).
 */
export const warnIfUndeliverable = (
  scope: Construct,
  topic: ITopic,
  alarms: Alarm[],
): void => {
  scope.node.addValidation({
    validate: (): string[] => {
      if (alarms.length === 0) {
        return [];
      }
      const topicStack = Stack.of(scope);

      // A subscriber anywhere in the app counts, as long as it shares this
      // topic's environment: `LambdaSubscription` / `SqsSubscription` put their
      // `CfnSubscription` in the TARGET's stack, so a same-stack-only search
      // would miss a cross-stack target in the same account/region. A
      // DIFFERENT-environment stack (e.g. the off-region us-east-1 support
      // stack) owns its OWN topic and is validated on its own, so skip those
      // here — resolving a cross-environment token in this stack's scope would
      // force an unwanted cross-stack reference (`CannotUseCrossEnvironment`).
      const hasSubscriber = scope.node.root.node.findAll().some((c) => {
        if (!(c instanceof CfnSubscription)) {
          return false;
        }
        const subStack = Stack.of(c);
        if (
          subStack.account !== topicStack.account ||
          subStack.region !== topicStack.region
        ) {
          return false;
        }
        // Resolve both arns in the SUBSCRIPTION's own stack so same-stack
        // subscriptions compare as `{ Ref }` and same-environment cross-stack
        // ones compare as the same import, without a cross-env resolve.
        return (
          JSON.stringify(subStack.resolve(c.topicArn)) ===
          JSON.stringify(subStack.resolve(topic.topicArn))
        );
      });
      if (hasSubscriber) {
        return [];
      }

      const topicArn = JSON.stringify(topicStack.resolve(topic.topicArn));

      // Treat as deliverable when every alarm already has at least one action
      // OTHER than this topic — the caller routed delivery themselves via
      // `monitoring.alarms`, so a "subscribe this topic" warning is wrong.
      // (The construct wires its own topic action onto each alarm it creates,
      // so the test is "has a non-topic action too", not "has no topic action".)
      const everyAlarmRoutesElsewhere = alarms.every((alarm) => {
        const cfnAlarm = alarm.node.defaultChild;
        if (!(cfnAlarm instanceof CfnAlarm)) {
          return false;
        }
        const actions: unknown[] =
          topicStack.resolve(cfnAlarm.alarmActions) ?? [];
        return actions.some(
          (a) => JSON.stringify(topicStack.resolve(a)) !== topicArn,
        );
      });
      if (everyAlarmRoutesElsewhere) {
        return [];
      }

      Annotations.of(scope).addWarningV2(
        MONITORING_NO_SUBSCRIBER_WARNING_ID,
        'Hosting monitoring is enabled but an alarm topic has no subscriber, ' +
          'so an alarm can enter ALARM but deliver to no one. Subscribe an ' +
          'endpoint via `monitoring.subscriptions` (EmailSubscription / ' +
          'UrlSubscription), subscribe the topic out-of-band using the ' +
          'MonitoringTopicArn stack output, or route the alarm actions ' +
          'elsewhere via `monitoring.alarms`. Set `monitoring: { enabled: ' +
          'false }` to turn monitoring off deliberately, or call ' +
          `\`Annotations.of(scope).acknowledgeWarning('${MONITORING_NO_SUBSCRIBER_WARNING_ID}')\` ` +
          'to accept the gap knowingly.',
      );
      return [];
    },
  });
};

/**
 * CloudWatch alarm wiring construct. See module-level doc-comment for
 * the rationale and the alarm set.
 */
export class MonitoringConstruct extends Construct {
  /** SNS topic alarm actions are sent to. Undefined when monitoring is disabled. */
  readonly topic?: ITopic;
  /**
   * KMS key encrypting the auto-created alarm topic. Undefined when
   * monitoring is disabled. Exposed so callers can grant additional
   * publishers on the key.
   */
  readonly encryptionKey?: IKey;
  /** All CloudWatch alarms created by this construct. */
  readonly alarms: Alarm[] = [];
  /**
   * True when a `distribution` was supplied but the CloudFront 5xx
   * alarm was NOT created here because `createCloudFrontAlarmLocally`
   * was `false` (off-region). The parent must place the alarm in a
   * us-east-1 support stack. See issue #481.
   */
  readonly cloudFrontAlarmDeferred: boolean = false;

  /**
   * Wire the default alarm set to the user-supplied or auto-created
   * SNS topic. No-op when `props.enabled` is false.
   */
  constructor(scope: Construct, id: string, props: MonitoringConstructProps) {
    super(scope, id);

    if (!props.enabled) {
      return;
    }

    this.encryptionKey = createAlarmTopicKey(this);
    this.topic = new Topic(this, 'AlarmTopic', {
      masterKey: this.encryptionKey,
    });
    const topic = this.topic;
    for (const sub of props.subscriptions ?? []) {
      topic.addSubscription(sub);
    }
    // Warn at synth if this topic's alarms have nowhere to deliver. The shared
    // helper reads `this.alarms` (populated below) lazily at validation time,
    // and the us-east-1 support stack runs the same check on its own topic.
    warnIfUndeliverable(this, topic, this.alarms);
    const action = new SnsAction(this.topic);

    if (props.distribution && (props.createCloudFrontAlarmLocally ?? true)) {
      const cf5xx = new Alarm(this, 'CloudFront5xxRate', {
        metric: new Metric({
          namespace: 'AWS/CloudFront',
          metricName: '5xxErrorRate',
          dimensionsMap: {
            DistributionId: props.distribution.distributionId,
            // CloudFront metrics live in us-east-1 regardless of stack.
            Region: 'Global',
          },
          period: Duration.minutes(5),
          statistic: 'Average',
        }),
        threshold: 5, // percent
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'CloudFront is returning 5xx for >=5% of requests over 5 minutes.',
      });
      cf5xx.addAlarmAction(action);
      this.alarms.push(cf5xx);
    } else if (props.distribution) {
      // Off-region: the CloudFront metric only exists in us-east-1 and an
      // alarm can't watch a metric cross-region, so defer the alarm to a
      // us-east-1 support stack owned by the parent. See issue #481.
      this.cloudFrontAlarmDeferred = true;
    }

    if (props.ssrFunction) {
      // Rate-based error alarm: errors / invocations * 100 >= threshold%.
      // A math expression keeps the alarm meaningful across traffic
      // levels — `5 absolute errors` is background noise at 10K RPM and a
      // full outage at 2 RPM. `fillMetric: 0` on invocations avoids a
      // divide-by-missing when there's no traffic in the window (the
      // expression then yields 0, below threshold, so a quiet period
      // doesn't false-alarm).
      const errorRatePercent = props.ssrErrorRatePercent ?? 1;
      const errorRate = new MathExpression({
        expression: '(errors / invocations) * 100',
        usingMetrics: {
          errors: props.ssrFunction.metricErrors({
            period: Duration.minutes(5),
            statistic: 'Sum',
          }),
          invocations: props.ssrFunction.metricInvocations({
            period: Duration.minutes(5),
            statistic: 'Sum',
          }),
        },
        period: Duration.minutes(5),
        label: 'SSR Lambda error rate (%)',
      });
      const errors = new Alarm(this, 'SsrLambdaErrors', {
        metric: errorRate,
        threshold: errorRatePercent,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription: `SSR Lambda error rate >= ${errorRatePercent}% of invocations over 5 minutes.`,
      });
      errors.addAlarmAction(action);
      this.alarms.push(errors);

      const throttles = new Alarm(this, 'SsrLambdaThrottles', {
        metric: props.ssrFunction.metricThrottles({
          period: Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'SSR Lambda is being throttled — concurrency cap reached.',
      });
      throttles.addAlarmAction(action);
      this.alarms.push(throttles);
    }

    if (props.imageFunction) {
      const imgErrors = new Alarm(this, 'ImageLambdaErrors', {
        metric: props.imageFunction.metricErrors({
          period: Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'Image-opt Lambda has produced >=5 errors in the last 5 minutes ' +
          '(possible SSRF attempts being blocked, or remote-origin failures).',
      });
      imgErrors.addAlarmAction(action);
      this.alarms.push(imgErrors);
    }

    if (props.revalidationDlq) {
      // Any message in the DLQ means a revalidation failed all
      // retries. Without the alarm, ISR pages silently stop
      // refreshing — the symptom is "pages are stale" reported by
      // users, with no operator-visible signal.
      const dlqDepth = new Alarm(this, 'RevalidationDlqDepth', {
        metric: props.revalidationDlq.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5),
          statistic: 'Maximum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'Revalidation DLQ has at least one poison message — ISR pages may stop refreshing.',
      });
      dlqDepth.addAlarmAction(action);
      this.alarms.push(dlqDepth);
    }
  }
}
