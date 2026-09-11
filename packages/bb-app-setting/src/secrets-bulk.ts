// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Construct id of the shared, per-stack custom resource that writes every
 * `secret: true` `AppSetting`'s SecureString value at deploy time (created
 * lazily by the first secret AppSetting; a direct child of the stack).
 *
 * Exported so sibling blocks that must order a resource *after* the secret
 * values are written — e.g. `bb-auth-oidc`'s IdP-registration custom resource —
 * can locate it via `Stack.of(x).node.tryFindChild(SECRETS_BULK_CONSTRUCT_ID)`
 * without hard-coding the string. This is the single source of truth for the id:
 * the CDK layer creates the construct with it, so a rename here moves both the
 * producer and every consumer together and the cross-package coupling can't
 * drift silently.
 */
export const SECRETS_BULK_CONSTRUCT_ID = 'BlocksSecretsBulk';
