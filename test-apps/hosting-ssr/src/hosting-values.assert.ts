// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Compile-time proof — NOT executed. `next build` type-checks this file, so if the
// generated `.blocks/hosting-values.d.ts` stops narrowing getSecret/getConfig to the
// app's declared keys, the two `@ts-expect-error` directives below become "unused"
// (TS2578) and the build FAILS. This is the CI guard for the zero-code type-safety
// feature: the keys come from `secret('DEMO_SECRET')` / `config('DEMO_CONFIG')` in
// aws-blocks/index.cdk.ts, and the getters are imported here from the same CDK-free
// subpath the SSR route uses (`@aws-blocks/hosting/secret`).
import { getConfig, getSecret } from '@aws-blocks/hosting/secret';

export async function _assertHostingValueTypesNarrow(): Promise<void> {
  await getSecret('DEMO_SECRET'); // declared with secret() → valid
  await getConfig('DEMO_CONFIG'); // declared with config() → valid

  // @ts-expect-error a typo is a compile error, not a runtime surprise.
  await getSecret('DEMO_SCRET');

  // @ts-expect-error a config key is rejected by getSecret (kind/store separation).
  await getSecret('DEMO_CONFIG');
}
