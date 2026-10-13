// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @see docs/native-clients/codegen-design.md
 */

import type { SpecValidationError } from './validate-spec.js';

export const NATIVE_PACKAGES_EXTENSION = 'x-blocks-native-packages';

export const NATIVE_BINDINGS_EXTENSION = 'x-blocks-native-bindings';

export const NATIVE_CATALOG_SCHEMA_VERSION = 1;

/**
 * Tags a declared binding may not claim: each keeps its hard-coded path in the
 * native generators, which hold their own copies pinned by their own suites.
 */
export const BUILTIN_TRANSFERABLE_TAGS: ReadonlySet<string> = new Set([
	'realtime/channel',
	'file-bucket/download',
	'file-bucket/upload',
	'oidc/client',
]);

/** `blocks-transferable-v1`: export `x` calls `X.fromBlocksDescriptor`. */
export const KNOWN_TRANSFERABLE_ABIS: ReadonlySet<string> = new Set(['blocks-transferable-v1']);

export const MAX_GENERIC_ARITY = 1;

export const NATIVE_PLATFORMS = ['dart', 'swift', 'android'] as const;

export type NativePlatform = (typeof NATIVE_PLATFORMS)[number];

export interface DartNativePackage {
	/** pub package name — the key under `dependencies` in `pubspec.yaml`. */
	name: string;
	/** Public entry library in `lib/`, imported as `package:<name>/<lib>`. */
	library: string;
}

export interface SwiftNativePackage {
	/** SwiftPM package identity — the key it deduplicates a dependency by. */
	identity: string;
	/** Library product the app target depends on. */
	product: string;
	/** Module name the generated source imports. */
	module: string;
}

export interface AndroidNativePackage {
	group: string;
	artifact: string;
	/** Imported as `<kotlinPackage>.<Type>`. */
	kotlinPackage: string;
}

export interface NativePlatformEntry<P> {
	package: P;
}

/** An absent platform means the package is not offered there. */
export interface NativePackagePlatforms {
	dart?: NativePlatformEntry<DartNativePackage>;
	swift?: NativePlatformEntry<SwiftNativePackage>;
	android?: NativePlatformEntry<AndroidNativePackage>;
}

export interface NativePackageRegistration {
	/** Becomes the key under `x-blocks-native-packages.packages`. */
	identity: string;
	platforms: NativePackagePlatforms;
}

export interface NativeBindingRegistration {
	id: string;
	kind: string;
	/** Exact transferable tag, matched byte-for-byte and case-sensitively. */
	tag: string;
	package: string;
	export: string;
	abi: string;
	genericArity: number;
}

/**
 * Declarations collected from one block. `sourcePackage` is never emitted; it
 * names the declaring block in every validation error.
 */
export interface NativeDeclarationSource {
	sourcePackage: string;
	packages?: NativePackageRegistration[];
	bindings?: NativeBindingRegistration[];
}

export interface NativePackagesCatalog {
	schemaVersion: number;
	packages: Record<string, { platforms: NativePackagePlatforms }>;
}

export interface NativeBindingsCatalog {
	schemaVersion: number;
	bindings: NativeBindingRegistration[];
}

interface NativeCatalogs {
	[NATIVE_PACKAGES_EXTENSION]?: NativePackagesCatalog;
	[NATIVE_BINDINGS_EXTENSION]?: NativeBindingsCatalog;
}

/**
 * Thrown by `generateSpec` before the spec is written, so a rejected
 * declaration set never reaches disk.
 */
export class NativeCatalogError extends Error {
	readonly errors: readonly SpecValidationError[];

	constructor(errors: readonly SpecValidationError[]) {
		const lines = errors.map((e) => `  ${e.path}: ${e.message}`);
		super(`Native binding metadata is invalid (${errors.length} error(s)):\n${lines.join('\n')}`);
		this.name = 'NativeCatalogError';
		this.errors = errors;
	}
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Keys sorted at every depth, so key order never changes the comparison.
 * Not total: a throwing accessor or past-stack-limit nesting still throws, so
 * callers must run under `validateNativeCatalogs`' catch.
 */
export function canonicalJson(value: unknown, seen: Set<object> = new Set()): string {
	if (typeof value === 'bigint') return JSON.stringify(String(value));
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (seen.has(value)) return '"[circular]"';
	seen.add(value);
	const body = Array.isArray(value)
		? `[${value.map((v) => canonicalJson(v, seen)).join(',')}]`
		: `{${Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, seen)}`)
				.join(',')}}`;
	seen.delete(value);
	return body;
}

/**
 * `null` when nothing is declared, so such a spec stays byte-identical.
 * Assumes `validateNativeCatalogs` passed: a repeated identity is first-wins.
 */
export function buildNativeCatalogs(sources: readonly NativeDeclarationSource[]): NativeCatalogs | null {
	// A Map, not an object literal: an identity of `__proto__` would route to
	// `Object.prototype` instead of becoming a key.
	const packages = new Map<string, { platforms: NativePackagePlatforms }>();
	const bindings: NativeBindingRegistration[] = [];

	for (const source of sources) {
		for (const registration of source.packages ?? []) {
			if (!packages.has(registration.identity)) {
				packages.set(registration.identity, { platforms: orderPlatforms(registration.platforms) });
			}
		}
		for (const binding of source.bindings ?? []) {
			bindings.push(orderBindingFields(binding));
		}
	}

	if (packages.size === 0 && bindings.length === 0) return null;

	bindings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	// Separate: an empty `bindings: []` would read as a real, empty catalog.
	const catalogs: NativeCatalogs = {};
	if (packages.size > 0) {
		catalogs[NATIVE_PACKAGES_EXTENSION] = {
			schemaVersion: NATIVE_CATALOG_SCHEMA_VERSION,
			packages: Object.fromEntries([...packages.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
		};
	}
	if (bindings.length > 0) {
		catalogs[NATIVE_BINDINGS_EXTENSION] = { schemaVersion: NATIVE_CATALOG_SCHEMA_VERSION, bindings };
	}
	return catalogs;
}

function orderPlatforms(platforms: NativePackagePlatforms): NativePackagePlatforms {
	const { dart, swift, android } = platforms;
	const ordered: NativePackagePlatforms = {};
	if (dart) {
		ordered.dart = { package: { name: dart.package.name, library: dart.package.library } };
	}
	if (swift) {
		ordered.swift = {
			package: {
				identity: swift.package.identity,
				product: swift.package.product,
				module: swift.package.module,
			},
		};
	}
	if (android) {
		ordered.android = {
			package: {
				group: android.package.group,
				artifact: android.package.artifact,
				kotlinPackage: android.package.kotlinPackage,
			},
		};
	}
	return ordered;
}

function orderBindingFields(binding: NativeBindingRegistration): NativeBindingRegistration {
	return {
		id: binding.id,
		kind: binding.kind,
		tag: binding.tag,
		package: binding.package,
		export: binding.export,
		abi: binding.abi,
		genericArity: binding.genericArity,
	};
}
