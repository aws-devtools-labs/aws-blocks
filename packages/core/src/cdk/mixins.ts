// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Mixin } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { IMixin } from 'constructs';

/**
 * Property names used across CloudFormation resources to express deletion
 * protection. L2 constructs and most L1s use `deletionProtection` (e.g. RDS
 * clusters and instances, ELBv2 load balancers), while others spell it
 * `deletionProtectionEnabled` (e.g. the DynamoDB `CfnTable` behind an L2
 * `Table`, Aurora DSQL clusters).
 */
const DELETION_PROTECTION_PROPERTIES = ['deletionProtection', 'deletionProtectionEnabled'] as const;

/**
 * Disables deletion protection on any construct that exposes a deletion
 * protection property (e.g. RDS clusters, RDS instances, DynamoDB tables).
 * Uses duck-typing so it automatically covers current and future resource
 * types, matching both the `deletionProtection` and
 * `deletionProtectionEnabled` spellings.
 *
 * Note that a DynamoDB L2 `Table` only accepts `deletionProtection` as a prop
 * and does not re-expose it, so tables are matched through their underlying
 * L1 `CfnTable.deletionProtectionEnabled`.
 *
 * Intended for sandbox teardown — use in the CDK layer alongside
 * `RemovalPolicies.of(stack).destroy()` to ensure `sandbox:destroy` can
 * delete the entire stack without manual cleanup. DynamoDB refuses
 * `DeleteTable` while deletion protection is enabled, regardless of the
 * CloudFormation `DeletionPolicy`.
 *
 * @example
 * ```ts
 * import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
 * import { SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
 *
 * if (sandboxMode) {
 *   RemovalPolicies.of(stack).destroy();
 *   Mixins.of(stack).apply(new SandboxDisableDeletionProtection());
 * }
 * ```
 */
export class SandboxDisableDeletionProtection extends Mixin implements IMixin {
  supports(construct: any): boolean {
    return DELETION_PROTECTION_PROPERTIES.some((property) => property in construct);
  }
  applyTo(node: IConstruct): void {
    // Only flip explicitly-enabled protection. When undefined (the default),
    // deletion protection is already off — setting it to false would emit the
    // property in the CloudFormation template, which breaks Aurora DB instances
    // (RDS rejects DeletionProtection on cluster members).
    for (const property of DELETION_PROTECTION_PROPERTIES) {
      if ((node as any)[property] === true) {
        (node as any)[property] = false;
      }
    }
  }
}
