// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The CDK CLI's own telemetry opt-out environment variable. */
export const CDK_DISABLE_ENV_VAR = 'CDK_DISABLE_CLI_TELEMETRY';

/**
 * The CDK context key carrying the CLI telemetry opt-out, which
 * `cdk cli-telemetry --disable` writes and `cdk cli-telemetry --status` reads.
 */
export const CDK_TELEMETRY_CONTEXT_KEY = 'cli-telemetry';

/** The CDK config files holding a context element, in CDK's lookup order. */
const PROJECT_CONFIG = 'cdk.json';
const USER_DEFAULTS = '.cdk.json';

/** The CDK file whose whole body is a context bag, between the two above. */
const PROJECT_CONTEXT = 'cdk.context.json';

/** A flat context bag: every key is a context key. `cdk.context.json` is one. */
type CdkContextBag = Record<string, unknown>;

/** A CDK config file, whose context keys live under its `context` element. */
interface CdkConfigFile extends CdkContextBag {
  context?: unknown;
}

/**
 * Whether a `CDK_DISABLE_CLI_TELEMETRY` value means "disabled".
 *
 * Mirrors the CDK CLI's `['true', '1'].includes(value ?? '')`
 * (`lib/cli/telemetry/collect-telemetry.js`), so the match is
 * case-sensitive and untrimmed: `TRUE`, ` 1 ` and `yes` do not opt a user out of
 * CDK telemetry and so must not opt them out of ours. Deliberately not
 * `isDisableValue` in `cdk/stack-metadata.ts`, which is laxer on purpose for the
 * template-metadata variable.
 */
export function isCdkDisableEnvValue(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/**
 * Whether a resolved `cli-telemetry` context value means "disabled".
 *
 * Mirrors the CDK CLI's `['false', false].includes(...)`: only the JSON boolean
 * `false` and the string `'false'` disable it, so `0` and `'FALSE'` do not.
 */
export function isCdkDisableContextValue(value: unknown): boolean {
  return value === false || value === 'false';
}

/**
 * Parse a CDK config file, returning undefined when it cannot be read or parsed.
 *
 * Only those two failures are normalized. JSON that parses to a non-object, such as
 * `null` or an array, is returned as it is; the key lookups below tolerate it.
 */
function readCdkConfigFile<T extends CdkContextBag = CdkConfigFile>(configPath: string): T | undefined {
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * The `context` element of a CDK config file, or undefined when it has none.
 *
 * The CDK CLI builds its context bags from that element alone, so a top-level
 * `cli-telemetry` is not an opt-out however the AWS documentation reads.
 */
function contextElement(configPath: string): CdkConfigFile | undefined {
  const context = readCdkConfigFile(configPath)?.context;
  return typeof context === 'object' && context !== null ? (context as CdkConfigFile) : undefined;
}

/**
 * Resolve CDK's `cli-telemetry` context value the way the CDK CLI resolves it.
 *
 * CDK overlays context bags and takes the value of the first one that has the
 * key at all (`Context.get`, `@aws-cdk/toolkit-lib/lib/api/context.js`), in the
 * order documented at
 * https://docs.aws.amazon.com/cdk/v2/guide/cli-telemetry.html: `--context`
 * flags, then `cdk.json`, then `cdk.context.json`, then `~/.cdk.json`. So an
 * enable in an earlier file shadows a disable in a later one rather than being
 * outranked by it.
 *
 * The `--context` bag is absent here by construction: the CDK Blocks commands build
 * the `--context` flags they pass to CDK themselves and never pass this key, and
 * the `cdk-blocks` CLI has no flag that would reach it.
 *
 * CDK reads `cdk.json` and `cdk.context.json` relative to its working directory,
 * which for the CDK Blocks commands is the project root they spawn CDK in.
 *
 * `resolveDeploymentTarget` in `scripts/deployment-target.ts` walks the same three
 * bags in the same order for the bootstrap qualifier. If CDK changes that order or
 * adds a bag, both sites move together.
 *
 * @param projectRoot - Directory holding the project's CDK config files
 *   (defaults to `process.cwd()`)
 * @returns The resolved value, or undefined when no bag sets the key
 */
export function readCdkTelemetryContext(projectRoot?: string): unknown {
  const root = projectRoot ?? process.cwd();
  const bags = [
    contextElement(join(root, PROJECT_CONFIG)),
    readCdkConfigFile<CdkContextBag>(join(root, PROJECT_CONTEXT)),
    contextElement(join(homedir(), USER_DEFAULTS)),
  ];

  for (const bag of bags) {
    const value = bag?.[CDK_TELEMETRY_CONTEXT_KEY];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Whether the user has opted out of CDK CLI telemetry.
 *
 * `CDK_DISABLE_CLI_TELEMETRY` outranks every context value; the context value is
 * resolved by {@link readCdkTelemetryContext}.
 *
 * `--no-version-reporting` is deliberately not covered: it reaches CDK only as a
 * per-invocation flag, which `cdk-blocks` has none of, and version reporting here
 * already governs template metadata instead (`cdk/stack-metadata.ts`).
 *
 * @param projectRoot - Directory holding the project's CDK config files
 *   (defaults to `process.cwd()`)
 */
export function isCdkTelemetryDisabled(projectRoot?: string): boolean {
  if (isCdkDisableEnvValue(process.env[CDK_DISABLE_ENV_VAR])) return true;
  return isCdkDisableContextValue(readCdkTelemetryContext(projectRoot));
}
