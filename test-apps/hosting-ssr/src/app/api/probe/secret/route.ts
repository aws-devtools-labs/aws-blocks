// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// E2E probe for the secret() / config() feature. Resolves both at runtime, each
// from its own store, and reports length + a short sha256 (never the raw secret)
// so the test can assert the resolved value matches what the CLI wrote — proving
// the end-to-end path: CLI write → store → IAM grant → getSecret/getConfig read.
//
// Imports the getters from the CDK-free `@aws-blocks/hosting` value API so
// no CDK is pulled into the SSR runtime bundle.
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getConfig, getSecret } from '@aws-blocks/hosting';

export const dynamic = 'force-dynamic';

function fingerprint(value: string) {
  return { len: value.length, sha8: createHash('sha256').update(value).digest('hex').slice(0, 8) };
}

export async function GET() {
  try {
    const [secretValue, configValue] = await Promise.all([getSecret('DEMO_SECRET'), getConfig('DEMO_CONFIG')]);
    return NextResponse.json({
      ok: true,
      runtime: 'nodejs',
      // secret() → Secrets Manager (fingerprint only — never echo a secret)
      secret: fingerprint(secretValue),
      // config() → SSM Parameter Store (non-sensitive, safe to echo)
      config: { ...fingerprint(configValue), value: configValue },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
