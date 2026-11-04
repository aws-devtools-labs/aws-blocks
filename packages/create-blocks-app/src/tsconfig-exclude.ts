// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keep a frontend tsconfig from typechecking the `aws-blocks/` backend source.
 *
 * The frontend reads the backend's generated declaration files through the
 * `aws-blocks` package's `exports["."].types`. That only helps if the frontend's
 * own `include` doesn't also pull in the backend source: Next.js's default
 * (`**\/*.ts`) and `tsc --init` (no `include`, so everything) do, and then the
 * backend is checked with frontend settings again. This adds `"aws-blocks"` to
 * `exclude` in the configs that would cover it.
 *
 * A tsconfig is JSONC (comments, trailing commas), so the edit goes through
 * `jsonc-parser` — the library VS Code uses to edit `settings.json` — which
 * returns a minimal text edit and leaves comments and formatting alone. Never a
 * parse/re-serialize, which would drop the user's comments.
 *
 * Anything we can't reason about is reported back as a manual step rather than
 * guessed at. That includes `extends`: resolving a base config is out of scope,
 * and without it we can neither tell whether the base's `include` covers the
 * backend nor safely add an `exclude` here — a local `exclude` replaces the
 * base's outright.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';

const ENTRY = 'aws-blocks';
const FORMAT = { formattingOptions: { tabSize: 2, insertSpaces: true } };

export type ExcludeResult =
  | { file: string; status: 'updated' }
  | { file: string; status: 'unchanged'; reason: string }
  | { file: string; status: 'manual'; reason: string };

interface Tsconfig {
  extends?: unknown;
  include?: unknown;
  files?: unknown;
  exclude?: unknown;
  references?: unknown;
  compilerOptions?: { outDir?: unknown };
}

/** Parse a tsconfig as JSONC, or `undefined` when it has syntax errors. */
function parseTsconfig(text: string): Tsconfig | undefined {
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
  return config as Tsconfig;
}

/** Whether an `include` list (or its absence) pulls in files under `aws-blocks/`. */
function coversBackend(config: Tsconfig): boolean {
  const { include } = config;
  if (include === undefined) {
    // No include: `files` alone limits the program; otherwise everything is included.
    return config.files === undefined;
  }
  if (!Array.isArray(include)) return false;
  return include.some((p) => {
    if (typeof p !== 'string') return false;
    const pattern = p.replace(/^\.\//, '');
    return pattern === '' || pattern === '.' || pattern.startsWith('*') || pattern === ENTRY || pattern.startsWith(`${ENTRY}/`);
  });
}

/**
 * Add `"aws-blocks"` to `exclude` in one tsconfig, if its `include` covers the
 * backend. Returns what happened; never throws for malformed input.
 */
export function excludeBackendInTsconfig(file: string): ExcludeResult {
  const text = readFileSync(file, 'utf-8');
  const config = parseTsconfig(text);
  if (!config) return { file, status: 'manual', reason: 'it is not valid JSONC' };
  if (config.extends !== undefined) {
    return { file, status: 'manual', reason: 'it extends another config, whose include and exclude we cannot see' };
  }
  if (!coversBackend(config)) return { file, status: 'unchanged', reason: 'its include does not cover aws-blocks/' };

  let edited: string;
  if (config.exclude === undefined) {
    // Setting `exclude` replaces TypeScript's default, which is node_modules,
    // bower_components, jspm_packages and outDir — keep the ones that matter.
    const { outDir } = config.compilerOptions ?? {};
    const entries = ['node_modules', ...(typeof outDir === 'string' ? [outDir.replace(/^\.\//, '')] : []), ENTRY];
    edited = applyEdits(text, modify(text, ['exclude'], entries, FORMAT));
  } else {
    if (!Array.isArray(config.exclude)) return { file, status: 'manual', reason: '"exclude" is not an array' };
    if (config.exclude.includes(ENTRY)) return { file, status: 'unchanged', reason: 'aws-blocks is already excluded' };
    edited = applyEdits(text, modify(text, ['exclude', -1], ENTRY, FORMAT));
  }

  writeFileSync(file, edited);
  return { file, status: 'updated' };
}

/**
 * Apply {@link excludeBackendInTsconfig} to the project's `tsconfig.json` and,
 * for a solution-style config (Vite's `references`), to each referenced config.
 */
export function excludeBackendFromFrontendTsconfigs(targetDir: string): ExcludeResult[] {
  const rootFile = join(targetDir, 'tsconfig.json');
  if (!existsSync(rootFile)) return [];

  const refs = parseTsconfig(readFileSync(rootFile, 'utf-8'))?.references;
  const results = [excludeBackendInTsconfig(rootFile)];
  if (!Array.isArray(refs)) return results;

  for (const ref of refs) {
    const path = (ref as { path?: unknown })?.path;
    if (typeof path !== 'string') continue;
    const resolved = resolve(dirname(rootFile), path);
    const file = resolved.endsWith('.json') ? resolved : join(resolved, 'tsconfig.json');
    if (existsSync(file)) results.push(excludeBackendInTsconfig(file));
  }
  return results;
}
