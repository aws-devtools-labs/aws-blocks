// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const PLATFORM_PACKAGES: Record<string, string> = {
  'darwin-arm64': '@aws/dsql-lint-darwin-arm64',
  'darwin-x64': '@aws/dsql-lint-darwin-x64',
  'linux-arm64': '@aws/dsql-lint-linux-arm64',
  'linux-x64': '@aws/dsql-lint-linux-x64',
  'win32-x64': '@aws/dsql-lint-win32-x64',
};

interface DsqlLintOutput {
  schema_version: number;
  files: Array<{
    diagnostics: Array<{
      rule: string;
      message: string;
      suggestion: string;
      statement_preview: string;
    }>;
    error: string | null;
  }>;
}

function findDsqlLint(): string {
  const override = process.env.DSQL_LINT_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`DSQL_LINT_PATH points to '${override}' which does not exist`);
    return override;
  }

  const packageName = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!packageName) throw new Error(`dsql-lint does not support ${process.platform}-${process.arch}`);

  try {
    const packageDir = dirname(require.resolve(`${packageName}/package.json`));
    const binaryName = process.platform === 'win32' ? 'dsql-lint.exe' : 'dsql-lint';
    return join(packageDir, 'bin', binaryName);
  } catch {
    throw new Error(`dsql-lint platform package '${packageName}' is not installed`);
  }
}

export function runDsqlLint(sql: string): DsqlLintOutput {
  const result = spawnSync(findDsqlLint(), ['--format', 'json', '-'], {
    encoding: 'utf-8',
    input: sql,
  });

  if (result.error) throw new Error(`Failed to execute dsql-lint: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`dsql-lint exited with status ${result.status}: ${result.stderr}`);
  }

  let output: DsqlLintOutput;
  try {
    output = JSON.parse(result.stdout) as DsqlLintOutput;
  } catch {
    throw new Error(`dsql-lint returned invalid JSON: ${result.stdout.slice(0, 200)}`);
  }

  if (output.schema_version !== 1 || !output.files[0]) {
    throw new Error(`Unsupported dsql-lint output schema: ${output.schema_version}`);
  }
  return output;
}
