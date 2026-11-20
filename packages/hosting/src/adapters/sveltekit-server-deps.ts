// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SvelteKit server dependencies: the server function ships `build/` without
 * the app's `node_modules`, so the build bundles the server's dependencies and
 * synth checks that every module the server needs is inside `build/`.
 *
 * Bundling ({@link withViteBundlePreload}): the build runs with a Node.js
 * `--import` preload that a `vite build` process picks up. It points Vite's
 * `--config` at a bridge config in a fresh temporary directory; the bridge
 * imports the app's own config (the default `vite.config.*`, or the one the
 * build command names with `--config`) and appends a build-only plugin setting
 * `ssr.noExternal: true`. Nothing in the project is written, renamed or
 * restored, so two overlapping builds can't lose the app's config, a `cdk
 * watch` sees no change, and a type check in the build script never sees the
 * bridge. Any other process of the build (npm, `svelte-check`, the prerender)
 * loads the preload and leaves it at that.
 *
 * Checking ({@link unresolvedServerImports}): the server files of `build/` are
 * parsed (not pattern-matched, so text in a string or a comment is no import),
 * and every module they load is resolved the way Node.js does from the
 * importing file, staying inside `build/`: a package's `exports` (with the
 * `import` or `require` condition), else its `main`, and the target file has to
 * exist. A resolved file inside `build/` is checked in turn, so a shipped
 * package that imports a missing one is caught too. A dynamic `import()` or a
 * `require()` that the code handles failing (inside a `try` with a `catch`, or
 * with a `.catch()`/rejection handler) is an optional load and never fails the
 * check.
 */

import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, type Options as ParseOptions } from 'acorn';
import fg from 'fast-glob';

/** Name of the build-only Vite plugin that bundles the server's dependencies. */
export const SVELTEKIT_BUNDLE_PLUGIN_NAME = 'aws-blocks:sveltekit-bundle-server-dependencies';

// ---- bundling ----

/**
 * The `--import` preload. In a `vite build` process it writes the bridge
 * config next to itself and adds `--config <bridge>` (replacing the app's own
 * `--config`, which the bridge imports instead). A CommonJS config
 * (`.cjs`/`.cts`) is left alone: an ESM bridge can't load it, and the
 * post-build check names what stays unbundled. A failure only prints a
 * warning: the build then runs unchanged.
 * @internal exported for unit tests.
 */
export const buildVitePreloadSource = (): string => `// Written by @aws-cdk-blocks/hosting for one SvelteKit build; removed when it ends.
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_FILES = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.mts', 'vite.config.cjs', 'vite.config.cts'];

const bridgeSource = (importPath) => \`\${importPath ? \`import userConfig from \${JSON.stringify(importPath)};\\n\` : 'const userConfig = {};\\n'}
// The server function ships build/ without node_modules, so its dependencies are bundled.
const bundleServerDependencies = {
  name: '${SVELTEKIT_BUNDLE_PLUGIN_NAME}',
  apply: 'build',
  config: () => ({ ssr: { noExternal: true } }),
};

export default async (env) => {
  const config = (typeof userConfig === 'function' ? await userConfig(env) : await userConfig) ?? {};
  return { ...config, plugins: [...(config.plugins ?? []), bundleServerDependencies] };
};
\`;

try {
  const argv = process.argv;
  const bin = argv[1] ? realpathSync(argv[1]).split(sep).join('/') : '';
  if (bin.endsWith('/vite/bin/vite.js') && argv[2] === 'build') {
    let configArg;
    const rest = [];
    for (let i = 3; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--config' || arg === '-c') configArg = argv[++i];
      else if (arg.startsWith('--config=')) configArg = arg.slice('--config='.length);
      else rest.push(arg);
    }
    const root = argv[3] && !argv[3].startsWith('-') ? resolve(argv[3]) : process.cwd();
    const userConfig = configArg ? resolve(configArg) : CONFIG_FILES.map((f) => join(root, f)).find((p) => existsSync(p));
    if (!userConfig || !/\\.c[jt]s$/.test(userConfig)) {
      const here = dirname(fileURLToPath(import.meta.url));
      let importPath;
      if (userConfig) {
        importPath = relative(here, userConfig).split(sep).join('/');
        if (!isAbsolute(importPath) && !importPath.startsWith('.')) importPath = './' + importPath;
      }
      const bridge = join(here, \`vite.config.\${process.pid}.mjs\`);
      writeFileSync(bridge, bridgeSource(importPath));
      argv.splice(3, argv.length - 3, ...rest, '--config', bridge);
    }
  }
} catch (err) {
  process.stderr.write(\`@aws-cdk-blocks/hosting: could not bundle the SvelteKit server's dependencies (\${err}); building unchanged.\\n\`);
}
`;

/**
 * Run `fn` (the app's build) with an environment whose `NODE_OPTIONS` loads
 * the bundling preload, written to a fresh temporary directory that is removed
 * afterwards, also when `fn` throws. See the module header.
 * @param baseEnv - the build environment to extend
 * @param fn - runs the build with the extended environment
 */
export const withViteBundlePreload = <T>(baseEnv: NodeJS.ProcessEnv, fn: (env: NodeJS.ProcessEnv) => T): T => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-blocks-sveltekit-'));
  try {
    const preload = path.join(dir, 'preload.mjs');
    fs.writeFileSync(preload, buildVitePreloadSource(), 'utf-8');
    const importFlag = `--import=${pathToFileURL(preload).href}`;
    const nodeOptions = [baseEnv.NODE_OPTIONS, importFlag].filter((v) => v && v.length > 0).join(' ');
    return fn({ ...baseEnv, NODE_OPTIONS: nodeOptions });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// ---- checking ----

/** A module that a file loads. */
type ModuleRef = {
  specifier: string;
  kind: 'import' | 'require';
  /** The code handles the load failing (a dynamic load in a `try`/`catch`, or with a rejection handler). */
  optional: boolean;
};

type AstNode = { type: string; [key: string]: unknown };

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

/** A string literal, or a template literal without expressions. */
const staticString = (node: unknown): string | undefined => {
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as { value: { cooked: string | null } }[];
    const expressions = node.expressions as unknown[];
    if (expressions.length === 0 && quasis.length === 1) return quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * Whether the code handles a dynamic load (`node`, with its `ancestors`,
 * outermost first) failing: it sits in the `try` block of a statement with a
 * `catch` in the same function, or its promise gets a `.catch()` or a
 * `.then()` rejection handler (through any `.then()`/`.finally()` chain).
 */
const isHandledLoad = (node: AstNode, ancestors: AstNode[]): boolean => {
  let current: AstNode = node;
  for (let i = ancestors.length - 1; i >= 1; i--) {
    const member = ancestors[i];
    const call = ancestors[i - 1];
    if (member?.type !== 'MemberExpression' || member.object !== current) break;
    if (call?.type !== 'CallExpression' || call.callee !== member) break;
    const property = member.property as AstNode;
    const name = property.type === 'Identifier' ? (property.name as string) : undefined;
    if (name === 'catch') return true;
    if (name === 'then' && (call.arguments as unknown[]).length >= 2) return true;
    if (name !== 'then' && name !== 'finally') break;
    current = call;
    i--;
  }
  let child: AstNode = node;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i];
    if (!parent) break;
    if (FUNCTION_TYPES.has(parent.type)) return false;
    if (parent.type === 'TryStatement' && parent.handler && parent.block === child) return true;
    child = parent;
  }
  return false;
};

/** Parse as an ES module, falling back to a CommonJS script; `undefined` when neither parses. */
const parseModule = (source: string): AstNode | undefined => {
  const base: ParseOptions = { ecmaVersion: 'latest', allowHashBang: true };
  for (const options of [
    { ...base, sourceType: 'module' },
    { ...base, sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true },
  ] satisfies ParseOptions[]) {
    try {
      return parse(source, options) as unknown as AstNode;
    } catch {
      // Try the next source type.
    }
  }
  return undefined;
};

/**
 * The modules a JavaScript source loads by a literal specifier: static
 * `import`/`export … from`, `import()`, and `require()`. `undefined` when the
 * source doesn't parse.
 * @internal exported for unit tests.
 */
export const moduleRefs = (source: string): ModuleRef[] | undefined => {
  const program = parseModule(source);
  if (!program) return undefined;
  const refs: ModuleRef[] = [];
  const visit = (node: AstNode, ancestors: AstNode[]): void => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration': {
        const specifier = staticString(node.source);
        if (specifier !== undefined) refs.push({ specifier, kind: 'import', optional: false });
        break;
      }
      case 'ImportExpression': {
        const specifier = staticString(node.source);
        if (specifier !== undefined) refs.push({ specifier, kind: 'import', optional: isHandledLoad(node, ancestors) });
        break;
      }
      case 'CallExpression': {
        const callee = node.callee as AstNode;
        const args = node.arguments as unknown[];
        const specifier = args.length === 1 ? staticString(args[0]) : undefined;
        if (callee.type === 'Identifier' && callee.name === 'require' && specifier !== undefined) {
          refs.push({ specifier, kind: 'require', optional: isHandledLoad(node, ancestors) });
        }
        break;
      }
    }
    const nextAncestors = [...ancestors, node];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, nextAncestors);
      } else if (isNode(value)) {
        visit(value, nextAncestors);
      }
    }
  };
  visit(program, []);
  return refs;
};

/** Node's built-in modules, without the `node:` prefix. */
const BUILTIN_MODULES = new Set(builtinModules);

/** The package a bare import specifier names (`@scope/pkg/sub` → `@scope/pkg`). */
const packageOfSpecifier = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
};

const isRelative = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';

/** A specifier the check leaves alone: built-ins, `#` package imports, URLs, absolute paths. */
const isIgnoredSpecifier = (specifier: string): boolean =>
  specifier.length === 0 ||
  specifier.startsWith('#') ||
  specifier.startsWith('/') ||
  specifier.startsWith('node:') ||
  /\s/.test(specifier) ||
  /^[a-z][a-z0-9+.-]*:/i.test(specifier) ||
  BUILTIN_MODULES.has(specifier) ||
  BUILTIN_MODULES.has(packageOfSpecifier(specifier));

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** CommonJS file lookup: the path, then with an extension, then a directory's `index`. */
const resolveCommonJsFile = (p: string): string | undefined =>
  [p, `${p}.js`, `${p}.json`, `${p}.cjs`, `${p}.node`, path.join(p, 'index.js'), path.join(p, 'index.json')].find(isFile);

const CONDITIONS: Record<ModuleRef['kind'], ReadonlySet<string>> = {
  import: new Set(['node', 'import', 'default']),
  require: new Set(['node', 'require', 'default']),
};

/** Resolve a package `exports` target (a string, a condition object, or a fallback array). */
const resolveExportTarget = (target: unknown, conditions: ReadonlySet<string>, star: string | undefined): string | undefined => {
  if (typeof target === 'string') {
    if (!target.startsWith('./')) return undefined;
    return star === undefined ? target : target.split('*').join(star);
  }
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveExportTarget(item, conditions, star);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (typeof target === 'object' && target !== null) {
    for (const [condition, value] of Object.entries(target)) {
      if (!conditions.has(condition)) continue;
      const resolved = resolveExportTarget(value, conditions, star);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
};

/** Resolve `subpath` (`.` or `./x`) through a package's `exports`, including `*` patterns. */
const resolveExports = (exports: unknown, subpath: string, conditions: ReadonlySet<string>): string | undefined => {
  const isSubpathMap =
    typeof exports === 'object' && exports !== null && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith('.'));
  const map: Record<string, unknown> = isSubpathMap ? (exports as Record<string, unknown>) : { '.': exports };
  if (Object.hasOwn(map, subpath)) return resolveExportTarget(map[subpath], conditions, undefined);
  const patterns = Object.keys(map)
    .filter((key) => key.includes('*'))
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
  for (const key of patterns) {
    const [prefix = '', suffix = ''] = key.split('*');
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
      return resolveExportTarget(map[key], conditions, subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined;
};

/** Resolve `subpath` inside the package at `pkgDir` to an existing file. */
const resolveInPackage = (pkgDir: string, subpath: string, kind: ModuleRef['kind']): string | undefined => {
  let manifest: { exports?: unknown; main?: unknown } = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')) as typeof manifest;
  } catch {
    // No or unreadable package.json: Node.js falls back to the file layout.
  }
  if (manifest.exports !== undefined && manifest.exports !== null) {
    const target = resolveExports(manifest.exports, subpath, CONDITIONS[kind]);
    if (target === undefined) return undefined;
    const file = path.join(pkgDir, target);
    return isFile(file) ? file : undefined;
  }
  if (subpath === '.') {
    const main = typeof manifest.main === 'string' && manifest.main.length > 0 ? path.join(pkgDir, manifest.main) : undefined;
    return (main ? resolveCommonJsFile(main) : undefined) ?? resolveCommonJsFile(path.join(pkgDir, 'index'));
  }
  const file = path.join(pkgDir, subpath);
  return kind === 'require' ? resolveCommonJsFile(file) : isFile(file) ? file : undefined;
};

/**
 * Resolve a module that `fromFile` loads to an existing file, the way Node.js
 * does but never above `buildDir`: the function ships `build/` alone.
 */
const resolveRef = (buildDir: string, fromFile: string, ref: ModuleRef): string | undefined => {
  if (isRelative(ref.specifier)) {
    const file = path.resolve(path.dirname(fromFile), ref.specifier);
    return ref.kind === 'require' ? resolveCommonJsFile(file) : isFile(file) ? file : undefined;
  }
  const pkg = packageOfSpecifier(ref.specifier);
  const subpath = `.${ref.specifier.slice(pkg.length)}`;
  for (let dir = path.dirname(fromFile); ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, 'node_modules', pkg);
    if (fs.existsSync(pkgDir)) return resolveInPackage(pkgDir, subpath, ref.kind);
    if (dir === buildDir || path.dirname(dir) === dir || !dir.startsWith(buildDir)) return undefined;
  }
};

/**
 * The modules that the server in `build/` needs but that `build/` can't
 * provide, each with the file (relative to `build/`) that loads it first. The
 * server files are every script outside `client/`, `prerendered/` and
 * `node_modules/`; files they reach inside `build/` (a shipped package
 * included) are checked in turn. A relative import that doesn't resolve is
 * left to the build; an optional load (see the module header) never counts.
 * @internal exported for unit tests.
 */
export const unresolvedServerImports = (buildDir: string): Map<string, string> => {
  const root = path.resolve(buildDir);
  const queue = fg.sync('**/*.{js,mjs,cjs}', {
    cwd: root,
    absolute: true,
    ignore: ['client/**', 'prerendered/**', '**/node_modules/**'],
  });
  const seen = new Set<string>();
  const unresolved = new Map<string, string>();
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    const normalized = path.resolve(file);
    if (seen.has(normalized) || !/\.[cm]?js$/.test(normalized)) continue;
    seen.add(normalized);
    const refs = moduleRefs(fs.readFileSync(normalized, 'utf-8'));
    if (!refs) {
      process.stderr.write(`⚠️  Could not parse build/${path.relative(root, normalized)} to check its imports.\n`);
      continue;
    }
    for (const ref of refs) {
      if (isIgnoredSpecifier(ref.specifier)) continue;
      const target = resolveRef(root, normalized, ref);
      if (target) {
        queue.push(target);
        continue;
      }
      if (isRelative(ref.specifier) || ref.optional || unresolved.has(ref.specifier)) continue;
      unresolved.set(ref.specifier, path.relative(root, normalized).replace(/\\/g, '/'));
    }
  }
  return unresolved;
};
