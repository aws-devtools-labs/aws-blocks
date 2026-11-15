// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The suites' shared cookie jar on `global.fetch`: `installCookieJar()` from
 * `@aws-blocks/blocks/utils`, the one an app's e2e suite uses. Call it once
 * before any API imports; it returns a cleanup function that restores the
 * original fetch, and throws if a jar is already installed.
 *
 * It is the framework's own (not a local copy) so that `createTestClient()`
 * users, which step past that jar, never send or receive its cookies.
 */
export { installCookieJar } from '@aws-blocks/blocks/utils';
