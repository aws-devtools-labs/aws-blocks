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
 * A tsconfig is JSONC (comments, trailing commas), so the edit is a text
 * insertion at an offset found by a small scanner — never a parse/re-serialize,
 * which would drop the user's comments. Anything the scanner doesn't understand
 * is reported back as a manual step instead of guessed at.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ENTRY = 'aws-blocks';

export type ExcludeResult =
  | { file: string; status: 'updated' }
  | { file: string; status: 'unchanged'; reason: string }
  | { file: string; status: 'manual'; reason: string };

interface Span { start: number; end: number }
interface RootObject {
  open: number;
  close: number;
  /** Root-level keys → value span, plus the value itself when it's a plain JSON value. */
  keys: Map<string, Span & { value: unknown }>;
}

/** Thrown for input the scanner doesn't handle; the caller turns it into a manual step. */
class ScanError extends Error {}

function skipTrivia(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (text.startsWith('//', i)) { const nl = text.indexOf('\n', i); i = nl === -1 ? text.length : nl + 1; continue; }
    if (text.startsWith('/*', i)) {
      const endComment = text.indexOf('*/', i + 2);
      if (endComment === -1) throw new ScanError('unterminated comment');
      i = endComment + 2;
      continue;
    }
    break;
  }
  return i;
}

function scanString(text: string, i: number): { value: string; end: number } {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  if (j >= text.length) throw new ScanError('unterminated string');
  return { value: JSON.parse(text.slice(i, j + 1)), end: j + 1 };
}

/** Scan one value starting at `i`; returns its end and, for JSON-compatible values, the parsed value. */
function scanValue(text: string, i: number): { end: number; value: unknown } {
  const c = text[i];
  if (c === '"') return scanString(text, i);
  if (c === '{' || c === '[') {
    const isObject = c === '{';
    const close = isObject ? '}' : ']';
    const out: Record<string, unknown> | unknown[] = isObject ? {} : [];
    let j = skipTrivia(text, i + 1);
    while (text[j] !== close) {
      let key: string | undefined;
      if (isObject) {
        if (text[j] !== '"') throw new ScanError(`expected a key at offset ${j}`);
        const k = scanString(text, j);
        key = k.value;
        j = skipTrivia(text, k.end);
        if (text[j] !== ':') throw new ScanError(`expected ':' at offset ${j}`);
        j = skipTrivia(text, j + 1);
      }
      const v = scanValue(text, j);
      if (isObject) (out as Record<string, unknown>)[key!] = v.value;
      else (out as unknown[]).push(v.value);
      j = skipTrivia(text, v.end);
      if (text[j] === ',') j = skipTrivia(text, j + 1);
      else if (text[j] !== close) throw new ScanError(`expected ',' or '${close}' at offset ${j}`);
    }
    return { end: j + 1, value: out };
  }
  const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
  if (!m) throw new ScanError(`unexpected token at offset ${i}`);
  return { end: i + m[0].length, value: JSON.parse(m[0]) };
}

function scanRoot(text: string): RootObject {
  const open = skipTrivia(text, 0);
  if (text[open] !== '{') throw new ScanError('tsconfig is not an object');
  const keys = new Map<string, Span & { value: unknown }>();
  let j = skipTrivia(text, open + 1);
  while (text[j] !== '}') {
    if (text[j] !== '"') throw new ScanError(`expected a key at offset ${j}`);
    const k = scanString(text, j);
    j = skipTrivia(text, k.end);
    if (text[j] !== ':') throw new ScanError(`expected ':' at offset ${j}`);
    j = skipTrivia(text, j + 1);
    const v = scanValue(text, j);
    keys.set(k.value, { start: j, end: v.end, value: v.value });
    j = skipTrivia(text, v.end);
    if (text[j] === ',') j = skipTrivia(text, j + 1);
    else if (text[j] !== '}') throw new ScanError(`expected ',' or '}' at offset ${j}`);
  }
  return { open, close: j, keys };
}

/** End offset of the last element of the array starting at `open`, or `undefined` if it's empty. */
function lastElementEnd(text: string, open: number): number | undefined {
  let j = skipTrivia(text, open + 1);
  let last: number | undefined;
  while (text[j] !== ']') {
    last = scanValue(text, j).end;
    j = skipTrivia(text, last);
    if (text[j] === ',') j = skipTrivia(text, j + 1);
  }
  return last;
}

/** Whether an `include` list (or its absence) pulls in files under `aws-blocks/`. */
function coversBackend(root: RootObject): boolean {
  const include = root.keys.get('include')?.value;
  if (include === undefined) {
    // No include: `files` alone limits the program; otherwise everything is included.
    return !root.keys.has('files');
  }
  if (!Array.isArray(include)) return false;
  return include.some((p) => {
    if (typeof p !== 'string') return false;
    const pattern = p.replace(/^\.\//, '');
    return pattern === '' || pattern === '.' || pattern.startsWith('*') || pattern === ENTRY || pattern.startsWith(`${ENTRY}/`);
  });
}

/** Indentation of the first root-level key, used for inserted text. */
function keyIndent(text: string, root: RootObject): string {
  const first = [...root.keys.values()].sort((a, b) => a.start - b.start)[0];
  if (!first) return '  ';
  const lineStart = text.lastIndexOf('\n', first.start) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] || '  ';
}

/**
 * Add `"aws-blocks"` to `exclude` in one tsconfig, if its `include` covers the
 * backend. Returns what happened; never throws for malformed input.
 */
export function excludeBackendInTsconfig(file: string): ExcludeResult {
  const text = readFileSync(file, 'utf-8');
  let root: RootObject;
  try {
    root = scanRoot(text);
  } catch (error) {
    return { file, status: 'manual', reason: (error as Error).message };
  }
  if (!coversBackend(root)) return { file, status: 'unchanged', reason: 'its include does not cover aws-blocks/' };

  const exclude = root.keys.get('exclude');
  let updated: string;
  if (exclude) {
    if (!Array.isArray(exclude.value)) return { file, status: 'manual', reason: '"exclude" is not an array' };
    if (exclude.value.includes(ENTRY)) return { file, status: 'unchanged', reason: 'aws-blocks is already excluded' };
    // Insert right after the last entry (comments may follow it), or into an empty array.
    const lastEnd = lastElementEnd(text, exclude.start);
    if (lastEnd === undefined) {
      updated = `${text.slice(0, exclude.start + 1)}"${ENTRY}"${text.slice(exclude.start + 1)}`;
    } else {
      updated = `${text.slice(0, lastEnd)}, "${ENTRY}"${text.slice(lastEnd)}`;
    }
  } else {
    // Setting `exclude` replaces TypeScript's default, which is node_modules,
    // bower_components, jspm_packages and outDir — keep the ones that matter.
    const outDir = (root.keys.get('compilerOptions')?.value as { outDir?: unknown } | undefined)?.outDir;
    const entries = ['node_modules', ...(typeof outDir === 'string' ? [outDir.replace(/^\.\//, '')] : []), ENTRY];
    const property = `"exclude": [${entries.map((e) => JSON.stringify(e)).join(', ')}]`;
    const last = [...root.keys.values()].sort((a, b) => b.end - a.end)[0];
    if (!last) {
      updated = `${text.slice(0, root.open + 1)}\n  ${property}\n${text.slice(root.open + 1)}`;
    } else {
      // Insert after the last property's value — and after its comma, if it has one.
      const afterValue = skipTrivia(text, last.end);
      const hasComma = text[afterValue] === ',';
      const insertAt = hasComma ? afterValue + 1 : last.end;
      const indent = keyIndent(text, root);
      updated = `${text.slice(0, insertAt)}${hasComma ? '' : ','}\n${indent}${property}${hasComma ? ',' : ''}${text.slice(insertAt)}`;
    }
  }
  writeFileSync(file, updated);
  return { file, status: 'updated' };
}

/**
 * Apply {@link excludeBackendInTsconfig} to the project's `tsconfig.json` and,
 * for a solution-style config (Vite's `references`), to each referenced config.
 */
export function excludeBackendFromFrontendTsconfigs(targetDir: string): ExcludeResult[] {
  const rootFile = join(targetDir, 'tsconfig.json');
  if (!existsSync(rootFile)) return [];
  const results = [excludeBackendInTsconfig(rootFile)];
  let refs: unknown;
  try {
    refs = scanRoot(readFileSync(rootFile, 'utf-8')).keys.get('references')?.value;
  } catch {
    return results;
  }
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
