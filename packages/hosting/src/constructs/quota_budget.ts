/**
 * Override-aware lookup for the adjustable AWS service quotas the hosting
 * distribution draws on.
 *
 * Why this exists
 * ---------------
 * The hosting solution bumps up against a handful of CloudFront / Lambda@Edge
 * quotas as a site grows. Each limit used to be a hardcoded `const` pinned to
 * the AWS *default*, so a customer granted a quota increase still hit the
 * synth-time throw — the code couldn't be told their real ceiling. `QuotaBudget`
 * is the one place that resolves, for each tracked quota, the effective limit
 * (caller-supplied override if present, else the AWS default).
 *
 * Scope: this models ONLY the adjustable Service Quotas the code actively
 * enforces and that a real app realistically reaches. True hard limits (the CF
 * Function 10 KB cap, Lambda's 4 KB env / 50 MB package, API Gateway's 10 MB
 * payload, CloudFormation's 500 resources) are deliberately NOT modelled here —
 * a number a customer can never raise is a guard, not a knob, and exposing it
 * as configurable would only relocate the failure and mislead the operator.
 *
 * History: the KVS single-behavior migration eliminated the per-route
 * cache-behavior and per-pattern response-headers-policy caps (route tables +
 * header rules are now KVS DATA, not CloudFront resources), so those quotas no
 * longer need running-total accounting. An earlier version carried a
 * consume/used/remaining/assertWithinLimits ledger for that; it was never on
 * the live enforcement path after the migration and has been removed. Today the
 * only consumer is the override-aware {@link QuotaBudget.limit} lookup (the
 * Lambda@Edge function-count and cache-behavior caps in `cdn_construct.ts`,
 * which compare against a known up-front count). Reintroduce a ledger only if a
 * future quota again needs incremental, multi-consumer accounting.
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

/**
 * Resolves the effective limit for each tracked, adjustable hosting quota:
 * the caller-supplied override if present, else the AWS default.
 *
 * Usage:
 * ```ts
 * const budget = new QuotaBudget(props.quotas);
 * if (edgeRouteCount > budget.limit('edgeFunctions')) throw ...;
 * ```
 */
export class QuotaBudget {
  private readonly limits: Record<QuotaKind, number>;

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
}
