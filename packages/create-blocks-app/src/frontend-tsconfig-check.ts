// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Report frontend tsconfigs that would typecheck the `aws-blocks/` backend.
 *
 * A frontend gets the backend's types from its generated declarations
 * (`exports["."].types` → `aws-blocks/.types/`). That holds only while the
 * frontend's own `include` doesn't *also* cover the backend: `include` and
 * `exclude` choose which files are program **roots**, and a rooted file is
 * checked under the config that rooted it, whatever the import resolved to. So
 * Next.js's default (`**\/*.ts`) and `tsc --init` (no `include`, so everything)
 * put the backend back under frontend settings and `process` fails again.
 *
 * This only reports. It used to edit the user's tsconfig in place through a
 * JSONC editor, which is a lot of risk to carry for one line in a file we don't
 * own — and it had to decline on `extends` anyway, because a local `exclude`
 * replaces the base's and we cannot see the base. Reporting is safe, the
 * remaining work is one line, and the failure it prevents is loud: skip the fix
 * and the next typecheck names the backend files directly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';

const ENTRY = 'aws-blocks';

export type TsconfigFinding =
  /** Its `include` covers `aws-blocks/`, so the backend will be typechecked. */
  | { file: string; kind: 'covers-backend' }
  /** It `extends` a base we can't see, so whether the backend is covered is unknown. */
  | { file: string; kind: 'unknown-extends' }
  /** It isn't valid JSONC, so we can't tell. */
  | { file: string; kind: 'unreadable' };

interface Tsconfig {
  extends?: unknown;
  include?: unknown;
  files?: unknown;
  exclude?: unknown;
  references?: unknown;
}

function parseTsconfig(text: string): Tsconfig | undefined {
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
  return config as Tsconfig;
}

/** Whether a pattern from `include` reaches files under `aws-blocks/`. */
function patternCoversBackend(p: unknown): boolean {
  if (typeof p !== 'string') return false;
  const pattern = p.replace(/^\.\//, '');
  return pattern === '' || pattern === '.' || pattern.startsWith('*') || pattern === ENTRY || pattern.startsWith(`${ENTRY}/`);
}

/** Check one tsconfig. Returns a finding, or `undefined` when it is already fine. */
export function checkFrontendTsconfig(file: string): TsconfigFinding | undefined {
  const config = parseTsconfig(readFileSync(file, 'utf-8'));
  if (!config) return { file, kind: 'unreadable' };

  // An explicit exclude of the backend settles it, whatever include says.
  if (Array.isArray(config.exclude) && config.exclude.some((e) => e === ENTRY || e === `${ENTRY}/`)) return undefined;

  if (Array.isArray(config.include)) {
    return config.include.some(patternCoversBackend) ? { file, kind: 'covers-backend' } : undefined;
  }
  // No local include: `files` alone limits the program, and a base config may
  // supply one — otherwise everything, including the backend, is a root.
  if (config.include === undefined && config.files === undefined) {
    return config.extends === undefined ? { file, kind: 'covers-backend' } : { file, kind: 'unknown-extends' };
  }
  return undefined;
}

/**
 * Check the project's `tsconfig.json` and, for a solution-style config (Vite's
 * `references`), each referenced config. Returns only the ones worth reporting.
 */
export function checkFrontendTsconfigs(targetDir: string): TsconfigFinding[] {
  const rootFile = join(targetDir, 'tsconfig.json');
  if (!existsSync(rootFile)) return [];

  const findings: TsconfigFinding[] = [];
  const push = (file: string) => {
    const finding = checkFrontendTsconfig(file);
    if (finding) findings.push(finding);
  };

  push(rootFile);

  const refs = parseTsconfig(readFileSync(rootFile, 'utf-8'))?.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      const path = (ref as { path?: unknown })?.path;
      if (typeof path !== 'string') continue;
      const resolved = resolve(dirname(rootFile), path);
      const file = resolved.endsWith('.json') ? resolved : join(resolved, 'tsconfig.json');
      if (existsSync(file)) push(file);
    }
  }
  return findings;
}
