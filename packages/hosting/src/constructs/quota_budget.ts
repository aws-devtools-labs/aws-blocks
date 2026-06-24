import { HostingError } from '../hosting_error.js';

/**
 * Centralized accounting for the adjustable AWS service quotas the hosting
 * distribution draws on.
 *
 * Why this exists
 * ---------------
 * The hosting solution bumps up against a handful of CloudFront / Lambda@Edge
 * quotas as a site grows (prerendered pages, header rules, edge routes, and
 * per-pattern response-header policies all compete for the same finite
 * budgets). Historically each limit was a separate hardcoded `const` with its
 * own ad-hoc `.length >= N` check scattered across `cdn_construct.ts`. That had
 * three problems:
 *
 *   1. **Falsely hard.** Every limit was hardcoded to the AWS *default*, so a
 *      customer who was granted a quota increase still hit the synth-time
 *      throw — the code couldn't be told their real ceiling.
 *   2. **Invisible interactions.** Behaviors, derived bare paths, assetPrefix,
 *      header rules and `/builds/*` all consume the same behavior budget, but
 *      no single place knew the running total or *what* consumed it, so the
 *      error couldn't say where the budget went.
 *   3. **Unguarded.** The account-wide Response-Headers-Policy quota was never
 *      checked at all — it just blew up opaquely at deploy time.
 *
 * `QuotaBudget` is the one place that knows, for each tracked quota: the limit,
 * its provenance (AWS default vs. a caller-supplied override), and the ledger
 * of who consumed how much.
 *
 * Current usage note: the KVS single-behavior migration eliminated the
 * per-route cache-behavior and per-pattern response-headers-policy caps (route
 * tables + header rules are now KVS DATA, not CloudFront resources), so those
 * quotas no longer need running-total accounting. Today `cdn_construct` uses
 * only the override-aware {@link limit} lookup, to enforce the Lambda@Edge
 * function-count cap. The {@link consume} / {@link assertWithinLimits} ledger
 * is retained (and unit-tested) for future multi-resource accounting, but is
 * not on the live enforcement path — see `cdn_construct.ts`.
 *
 * Scope: this models ONLY the adjustable Service Quotas the code actively
 * enforces and that a real app realistically reaches. True hard limits (the CF
 * Function 10 KB cap, Lambda's 4 KB env / 50 MB package, API Gateway's 10 MB
 * payload, CloudFormation's 500 resources) are deliberately NOT modelled here —
 * a number a customer can never raise is a guard, not a knob, and exposing it
 * as configurable would only relocate the failure and mislead the operator.
 */

/** A tracked, adjustable quota. */
export type QuotaKind = 'cacheBehaviors' | 'edgeFunctions' | 'headerPolicies';

/**
 * Caller-supplied quota overrides. Each field corresponds to a named AWS
 * Service Quota the customer can request an increase on. Omitting a field uses
 * the AWS default.
 *
 * IMPORTANT: synth cannot verify the customer's *actual* granted quota without
 * a network call (which CDK synth must not make). These values are therefore
 * trust-the-operator: setting one HIGHER than the real granted quota does not
 * raise the AWS ceiling — it just moves the failure from a clear synth-time
 * error to an opaque CloudFormation rollback at deploy. Set a field only to
 * match a quota increase AWS has actually granted.
 */
export type QuotaOverrides = {
  /**
   * Max CloudFront cache behaviors per distribution, INCLUDING the default
   * behavior. AWS Service Quota "Cache behaviors per distribution"
   * (code `L-D1ED81E0`), default 25.
   * @default 25
   */
  cacheBehaviors?: number;
  /**
   * Max Lambda@Edge replicated function associations attributable to this
   * distribution. AWS Service Quota "Lambda@Edge function associations per
   * distribution" / account replication limit, default 25.
   * @default 25
   */
  edgeFunctions?: number;
  /**
   * Max CloudFront response headers policies per account. AWS Service Quota
   * "Response headers policies per AWS account", default 20 (raisable to 200).
   * Note this is an ACCOUNT-wide quota shared by
   * every distribution in the account — the budget here only bounds the
   * policies THIS distribution creates, so leave headroom for others.
   * @default 20
   */
  headerPolicies?: number;
};

/** AWS default values for each tracked quota. */
export const AWS_DEFAULT_QUOTAS: Record<QuotaKind, number> = {
  // CloudFront allows 25 cache behaviors per distribution (1 default + 24
  // additional). We model the FULL limit (25) and account for the default
  // behavior as a consumer, so the override value maps 1:1 to the AWS quota.
  cacheBehaviors: 25,
  edgeFunctions: 25,
  headerPolicies: 20,
};

/** Human-readable AWS Service Quota name for each tracked quota. */
const QUOTA_LABELS: Record<QuotaKind, string> = {
  cacheBehaviors: 'CloudFront "Cache behaviors per distribution"',
  edgeFunctions: 'Lambda@Edge function associations per distribution',
  headerPolicies: 'CloudFront "Response headers policies per AWS account"',
};

/** HostingError code thrown when a quota is exceeded, keyed by quota kind. */
const QUOTA_ERROR_CODE: Record<QuotaKind, string> = {
  cacheBehaviors: 'TooManyRoutesError',
  edgeFunctions: 'TooManyEdgeRoutesError',
  headerPolicies: 'TooManyHeaderPoliciesError',
};

/** A single ledger entry: a labelled consumer drew `amount` from a quota. */
type LedgerEntry = { label: string; amount: number };

/**
 * Tracks consumption against the three adjustable hosting quotas.
 *
 * Typical use:
 * ```ts
 * const budget = new QuotaBudget(props.quotas);
 * budget.consume('cacheBehaviors', 'route:/blog/*', 1);
 * budget.consume('cacheBehaviors', 'derived-bare:/blog', 1);
 * // ...
 * budget.assertWithinLimits();   // throws with a per-consumer breakdown
 * ```
 */
export class QuotaBudget {
  private readonly limits: Record<QuotaKind, number>;
  private readonly ledger: Record<QuotaKind, LedgerEntry[]> = {
    cacheBehaviors: [],
    edgeFunctions: [],
    headerPolicies: [],
  };

  /**
   * @param overrides caller-supplied quota overrides; omitted fields fall back
   *   to {@link AWS_DEFAULT_QUOTAS}.
   */
  constructor(overrides?: QuotaOverrides) {
    this.limits = {
      cacheBehaviors:
        overrides?.cacheBehaviors ?? AWS_DEFAULT_QUOTAS.cacheBehaviors,
      edgeFunctions:
        overrides?.edgeFunctions ?? AWS_DEFAULT_QUOTAS.edgeFunctions,
      headerPolicies:
        overrides?.headerPolicies ?? AWS_DEFAULT_QUOTAS.headerPolicies,
    };
  }

  /** The effective limit for a quota (override if supplied, else AWS default). */
  limit(kind: QuotaKind): number {
    return this.limits[kind];
  }

  /** Total consumed against a quota so far. */
  used(kind: QuotaKind): number {
    return this.ledger[kind].reduce((sum, e) => sum + e.amount, 0);
  }

  /** Remaining headroom for a quota (never negative). */
  remaining(kind: QuotaKind): number {
    return Math.max(0, this.limit(kind) - this.used(kind));
  }

  /** True if consuming `amount` more would stay within the quota. */
  canFit(kind: QuotaKind, amount = 1): boolean {
    return this.used(kind) + amount <= this.limit(kind);
  }

  /**
   * Record consumption against a quota. `label` identifies the consumer for
   * the breakdown in {@link assertWithinLimits} (e.g. `route:/blog/*`).
   */
  consume(kind: QuotaKind, label: string, amount = 1): void {
    this.ledger[kind].push({ label, amount });
  }

  /** The recorded consumers for a quota (for diagnostics/tests). */
  consumers(kind: QuotaKind): readonly LedgerEntry[] {
    return this.ledger[kind];
  }

  /**
   * Throw a {@link HostingError} for the first over-budget quota, with a
   * breakdown of the biggest consumers so the user can see where the budget
   * went. No-op when everything fits.
   */
  assertWithinLimits(): void {
    for (const kind of Object.keys(this.limits) as QuotaKind[]) {
      const used = this.used(kind);
      const limit = this.limit(kind);
      if (used > limit) {
        throw new HostingError(QUOTA_ERROR_CODE[kind], {
          message:
            `This distribution would consume ${used} of the ${QUOTA_LABELS[kind]} ` +
            `quota, but the limit is ${limit}.${this.breakdown(kind)}`,
          resolution:
            `Reduce what consumes this quota (see the breakdown above), or — if ` +
            `AWS has granted your account a higher "${QUOTA_LABELS[kind]}" quota — ` +
            `raise it via the \`quotas.${kind}\` hosting prop. Note that setting ` +
            `\`quotas.${kind}\` above your actual granted quota does not raise the ` +
            `AWS ceiling; the deploy will fail at CloudFormation instead.`,
        });
      }
    }
  }

  /** Render the top consumers of a quota as an indented breakdown string. */
  private breakdown(kind: QuotaKind): string {
    const grouped = new Map<string, number>();
    for (const { label, amount } of this.ledger[kind]) {
      // Collapse to a prefix before the first ':' so e.g. 30 `route:*`
      // entries summarise as one line instead of flooding the message.
      const group = label.includes(':') ? label.slice(0, label.indexOf(':')) : label;
      grouped.set(group, (grouped.get(group) ?? 0) + amount);
    }
    const lines = [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([group, amount]) => `\n  • ${group}: ${amount}`);
    return lines.length > 0 ? `\nConsumed by:${lines.join('')}` : '';
  }
}
