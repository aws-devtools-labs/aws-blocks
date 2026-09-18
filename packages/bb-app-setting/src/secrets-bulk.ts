// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Construct id of the shared, per-backend custom resource that writes every
 * `secret: true` `AppSetting`'s SecureString value at deploy time (created
 * lazily by the first secret AppSetting; a direct child of the owning backend
 * root — `BlocksStack`/`BlocksBackend`, which for the common single-stack app
 * is the stack itself but for an embedded backend is *not* the enclosing stack).
 *
 * Exported so sibling blocks that must order a resource *after* the secret
 * values are written — e.g. `bb-auth-oidc`'s IdP-registration custom resource —
 * can locate it via `getBlocksRoot(x).node.tryFindChild(SECRETS_BULK_CONSTRUCT_ID)`
 * without hard-coding the string. Resolve the parent with `getBlocksRoot`, not
 * `Stack.of`, so the lookup finds it under an embedded backend too. This is the
 * single source of truth for the id: the CDK layer creates the construct with
 * it, so a rename here moves both the producer and every consumer together and
 * the cross-package coupling can't drift silently.
 */
export const SECRETS_BULK_CONSTRUCT_ID = 'BlocksSecretsBulk';
