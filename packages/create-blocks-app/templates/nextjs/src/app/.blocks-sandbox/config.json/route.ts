// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function GET() {
  const configPath = join(process.cwd(), '.blocks-sandbox', 'config.json');

  try {
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    return NextResponse.json(config);
  } catch {
    return NextResponse.json(
      { error: 'Config not found. Run npm run dev/sandbox first.' },
      { status: 404 },
    );
  }
}
