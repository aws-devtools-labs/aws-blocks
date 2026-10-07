// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Must never throw: problems are collected into the returned array.
 * `generateSpec` calls this without a try/catch and turns a non-empty result
 * into `NativeCatalogError`.
 */

import {
	BUILTIN_TRANSFERABLE_TAGS,
	canonicalJson,
	isPlainObject,
	KNOWN_TRANSFERABLE_ABIS,
	MAX_GENERIC_ARITY,
	NATIVE_BINDINGS_EXTENSION,
	NATIVE_CATALOG_SCHEMA_VERSION,
	NATIVE_PACKAGES_EXTENSION,
	NATIVE_PLATFORMS,
	type NativeDeclarationSource,
	type NativePlatform,
} from './native-catalogs.js';
import type { SpecValidationError } from './validate-spec.js';

export interface ValidatableMethod {
	name?: unknown;
	result?: { schema?: unknown } | null;
}

const TRANSFERABLE_FIELD = 'x-blocks-transferable';
const TYPE_ARGS_FIELD = 'x-blocks-type-args';

/** The only kind schema 1 defines; only the ABI allowlist gates on it. */
const TRANSFERABLE_BINDING_KIND = 'transferable';

function isNativePlatform(name: string): name is NativePlatform {
	return (NATIVE_PLATFORMS as readonly string[]).includes(name);
}

const PLATFORM_PACKAGE_FIELDS: Record<NativePlatform, readonly string[]> = {
	dart: ['name', 'library'],
	swift: ['identity', 'product', 'module'],
	android: ['group', 'artifact', 'kotlinPackage'],
};

function isNonBlankString(v: unknown): v is string {
	return typeof v === 'string' && v.trim().length > 0;
}

export function validateNativeCatalogs(
	sources: readonly NativeDeclarationSource[],
	methods: readonly ValidatableMethod[] = [],
): SpecValidationError[] {
	const errors: SpecValidationError[] = [];
	try {
		const safeSources = Array.isArray(sources) ? sources : [];
		const safeMethods = Array.isArray(methods) ? methods : [];
		const registered = collectPackages(safeSources, errors);
		collectBindings(safeSources, registered, safeMethods, errors);
	} catch (cause) {
		// A declaration can carry a throwing accessor or nest deeply enough to
		// exhaust the stack, so `cause` is read as little as possible: `String(cause)`
		// reaches `Error.prototype.toString` and appends the author's message, which
		// descriptors forbid in a diagnostic, and `Object.prototype.toString` reads
		// `Symbol.toStringTag` and can itself throw.
		let label = 'unknown error';
		try {
			label =
				cause instanceof Error && typeof cause.name === 'string' ? cause.name : `unrecognized ${typeof cause}`;
		} catch {
			// The `name` read or `instanceof` threw too — keep the literal above.
		}
		errors.push({
			path: NATIVE_PACKAGES_EXTENSION,
			message: `Native declarations could not be read (${label})`,
		});
	}
	return errors;
}

interface RegisteredPackage {
	canonical: string;
	sourcePackage: string;
}

/**
 * An identity whose platform entry is malformed is still registered, so one bad
 * field does not also produce "unknown package" errors from bindings that named
 * it correctly.
 */
function collectPackages(
	sources: readonly NativeDeclarationSource[],
	errors: SpecValidationError[],
): Map<string, RegisteredPackage> {
	const registered = new Map<string, RegisteredPackage>();
	let index = 0;

	for (const source of sources) {
		const declaredBy = `declared by ${describeSource(source)}`;
		if (!isPlainObject(source)) {
			errors.push({
				path: NATIVE_PACKAGES_EXTENSION,
				message: `Declaration source must be an object (${declaredBy})`,
			});
			continue;
		}
		const declarations = asDeclarationArray(
			source.packages,
			`${NATIVE_PACKAGES_EXTENSION}.packages`,
			declaredBy,
			errors,
		);
		for (const declaration of declarations) {
			const position = index++;
			const identity = isPlainObject(declaration) ? declaration.identity : undefined;
			// `packages` is keyed by identity in the emitted document, so a
			// positional index would name a location that never exists there.
			const path = isNonBlankString(identity)
				? `${NATIVE_PACKAGES_EXTENSION}.packages["${identity}"]`
				: `${NATIVE_PACKAGES_EXTENSION}.packages`;

			if (!isPlainObject(declaration)) {
				errors.push({ path, message: `Package registration must be an object (${declaredBy})` });
				continue;
			}
			if (!isNonBlankString(identity)) {
				errors.push({
					path,
					message: `Package "identity" must be a non-blank string, declaration ${position + 1} (${declaredBy})`,
				});
				continue;
			}

			// `canonicalJson` below compares `platforms` only, so an unrecognized
			// sibling would be neither compared nor emitted. Rejecting it keeps
			// "byte-identical" a statement about the whole registration.
			for (const key of Object.keys(declaration)) {
				if (key !== 'identity' && key !== 'platforms') {
					errors.push({
						path: `${path}.${key}`,
						message: `Unexpected field "${key}" — a registration holds only "identity" and "platforms" (${declaredBy})`,
					});
				}
			}

			validatePlatforms(declaration.platforms, path, declaredBy, errors);

			const canonical = canonicalJson(declaration.platforms ?? {});
			const existing = registered.get(identity);
			if (existing) {
				if (existing.canonical !== canonical) {
					errors.push({
						path,
						message:
							`Package identity "${identity}" is registered with different contents by ` +
							`${existing.sourcePackage} and ${describeSource(source)}. ` +
							'A duplicate identity must be byte-identical.',
					});
				}
				continue;
			}
			registered.set(identity, { canonical, sourcePackage: describeSource(source) });
		}
	}

	return registered;
}

function describeSource(source: unknown): string {
	const name = isPlainObject(source) ? source.sourcePackage : undefined;
	return isNonBlankString(name) ? name.trim() : '<unknown block>';
}

function asDeclarationArray(
	value: unknown,
	path: string,
	declaredBy: string,
	errors: SpecValidationError[],
): readonly unknown[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		errors.push({ path, message: `Expected an array (${declaredBy})` });
		return [];
	}
	return value;
}

function validatePlatforms(platforms: unknown, path: string, declaredBy: string, errors: SpecValidationError[]): void {
	if (platforms === undefined || platforms === null) {
		errors.push({ path: `${path}.platforms`, message: `Missing "platforms" object (${declaredBy})` });
		return;
	}
	if (!isPlainObject(platforms)) {
		errors.push({ path: `${path}.platforms`, message: `"platforms" must be an object (${declaredBy})` });
		return;
	}

	for (const [name, entry] of Object.entries(platforms)) {
		const platformPath = `${path}.platforms.${name}`;
		if (!isNativePlatform(name)) {
			errors.push({
				path: platformPath,
				message: `Unknown platform "${name}" (expected one of ${NATIVE_PLATFORMS.join(', ')}) (${declaredBy})`,
			});
			continue;
		}
		validatePlatformEntry(name, entry, platformPath, declaredBy, errors);
	}
}

function validatePlatformEntry(
	platform: NativePlatform,
	entry: unknown,
	path: string,
	declaredBy: string,
	errors: SpecValidationError[],
): void {
	if (!isPlainObject(entry)) {
		errors.push({ path, message: `Platform entry must be an object (${declaredBy})` });
		return;
	}

	for (const key of Object.keys(entry)) {
		if (key !== 'package') {
			errors.push({
				path: `${path}.${key}`,
				message:
					`Unexpected field "${key}" — schema ${NATIVE_CATALOG_SCHEMA_VERSION} platform entries ` +
					`hold only "package" (${declaredBy})`,
			});
		}
	}

	const pkgPath = `${path}.package`;
	if (!isPlainObject(entry.package)) {
		errors.push({ path: pkgPath, message: `Missing "package" object (${declaredBy})` });
		return;
	}

	const fields = PLATFORM_PACKAGE_FIELDS[platform];
	for (const field of fields) {
		if (!isNonBlankString(entry.package[field])) {
			errors.push({
				path: `${pkgPath}.${field}`,
				message: `${platform} "package" requires "${field}" as a non-blank string (${declaredBy})`,
			});
		}
	}
	for (const key of Object.keys(entry.package)) {
		if (fields.includes(key)) continue;
		const message =
			key === 'version'
				? `A "package" object carries no version — the customer's dependency declaration supplies it (${declaredBy})`
				: `Unexpected field "${key}" for ${platform} (expected ${fields.join(', ')}) (${declaredBy})`;
		errors.push({ path: `${pkgPath}.${key}`, message });
	}
}

function collectBindings(
	sources: readonly NativeDeclarationSource[],
	registered: Map<string, RegisteredPackage>,
	methods: readonly ValidatableMethod[],
	errors: SpecValidationError[],
): void {
	const seenTags = new Map<string, { id: string; sourcePackage: string }>();
	let index = 0;

	for (const source of sources) {
		const sourceName = describeSource(source);
		const declaredBy = `declared by ${sourceName}`;
		// Silent, unlike every other guard here: `collectPackages` already reported it.
		if (!isPlainObject(source)) continue;
		const declarations = asDeclarationArray(
			source.bindings,
			`${NATIVE_BINDINGS_EXTENSION}.bindings`,
			declaredBy,
			errors,
		);
		for (const declaration of declarations) {
			const position = index++;
			const id = isPlainObject(declaration) ? declaration.id : undefined;
			const path = isNonBlankString(id)
				? `${NATIVE_BINDINGS_EXTENSION}.bindings["${id}"]`
				: `${NATIVE_BINDINGS_EXTENSION}.bindings[${position}]`;

			if (!isPlainObject(declaration)) {
				errors.push({ path, message: `Binding must be an object (${declaredBy})` });
				continue;
			}
			if (!isNonBlankString(id)) {
				errors.push({ path: `${path}.id`, message: `Binding "id" must be a non-blank string (${declaredBy})` });
				continue;
			}

			if (!isNonBlankString(declaration.kind)) {
				errors.push({
					path: `${path}.kind`,
					message: `Binding "kind" must be a non-blank string (${declaredBy})`,
				});
				continue;
			}

			validateBindingPackage(declaration.package, id, path, declaredBy, registered, errors);
			// `kind` is an open enumeration, and `orderBindingFields` emits tag,
			// export, abi and genericArity for every kind, so every check below
			// runs for every kind. Only the ABI allowlist is transferable-specific.
			const tag = validateBindingTag(declaration.tag, id, path, declaredBy, sourceName, seenTags, errors);
			const arity = validateBindingShape(declaration, path, declaredBy, errors);
			if (arity !== undefined && tag !== undefined) {
				validateArityAgainstMethods(tag, arity, methods, errors);
			}

			if (declaration.kind !== TRANSFERABLE_BINDING_KIND) continue;

			validateTransferableAbi(declaration, path, declaredBy, errors);
		}
	}
}

function validateBindingShape(
	binding: Record<string, unknown>,
	path: string,
	declaredBy: string,
	errors: SpecValidationError[],
): number | undefined {
	for (const field of ['export', 'abi'] as const) {
		if (!isNonBlankString(binding[field])) {
			errors.push({
				path: `${path}.${field}`,
				message: `Binding "${field}" must be a non-blank string (${declaredBy})`,
			});
		}
	}
	return validateArity(binding.genericArity, path, declaredBy, errors);
}

function validateTransferableAbi(
	binding: Record<string, unknown>,
	path: string,
	declaredBy: string,
	errors: SpecValidationError[],
): void {
	if (isNonBlankString(binding.abi) && !KNOWN_TRANSFERABLE_ABIS.has(binding.abi)) {
		errors.push({
			path: `${path}.abi`,
			message:
				`Unknown factory ABI "${binding.abi}" (expected one of ` +
				`${[...KNOWN_TRANSFERABLE_ABIS].join(', ')}) (${declaredBy})`,
		});
	}
}

/**
 * A built-in tag is rejected and deliberately not recorded in `seenTags`, so a
 * second binding on it reports the built-in violation alone rather than that
 * plus a duplicate.
 */
function validateBindingTag(
	value: unknown,
	id: string,
	path: string,
	declaredBy: string,
	sourceName: string,
	seenTags: Map<string, { id: string; sourcePackage: string }>,
	errors: SpecValidationError[],
): string | undefined {
	if (!isNonBlankString(value)) {
		errors.push({ path: `${path}.tag`, message: `Binding "tag" must be a non-blank string (${declaredBy})` });
		return undefined;
	}
	if (BUILTIN_TRANSFERABLE_TAGS.has(value)) {
		errors.push({
			path: `${path}.tag`,
			message: `Tag "${value}" is a built-in transferable and cannot be bound by a block (${declaredBy})`,
		});
		return undefined;
	}
	const previous = seenTags.get(value);
	if (previous) {
		errors.push({
			path: `${path}.tag`,
			message:
				`Tag "${value}" is already bound by "${previous.id}" (declared by ${previous.sourcePackage}). ` +
				'A tag must be bound exactly once.',
		});
		return undefined;
	}
	seenTags.set(value, { id, sourcePackage: sourceName });
	return value;
}

function validateBindingPackage(
	value: unknown,
	id: string,
	path: string,
	declaredBy: string,
	registered: Map<string, RegisteredPackage>,
	errors: SpecValidationError[],
): void {
	if (!isNonBlankString(value)) {
		errors.push({
			path: `${path}.package`,
			message: `Binding "package" must be a non-blank string (${declaredBy})`,
		});
		return;
	}
	if (!registered.has(value)) {
		errors.push({
			path: `${path}.package`,
			message:
				`Binding "${id}" names package "${value}", which is not registered in ` +
				`${NATIVE_PACKAGES_EXTENSION} (${declaredBy})`,
		});
	}
}

function validateArity(
	value: unknown,
	path: string,
	declaredBy: string,
	errors: SpecValidationError[],
): number | undefined {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		errors.push({
			path: `${path}.genericArity`,
			message: `Binding "genericArity" must be an integer (${declaredBy})`,
		});
		return undefined;
	}
	if (value < 0 || value > MAX_GENERIC_ARITY) {
		errors.push({
			path: `${path}.genericArity`,
			message:
				`Binding "genericArity" must be between 0 and ${MAX_GENERIC_ARITY} in schema ` +
				`${NATIVE_CATALOG_SCHEMA_VERSION}, got ${value} (${declaredBy})`,
		});
		return undefined;
	}
	return value;
}

/**
 * An unbound tag on a method result is deliberately not an error here; the
 * native generators degrade it to `UnknownTransferable`.
 */
/** Tag-driven and kind-agnostic: a result is matched on `tag` alone. */
function validateArityAgainstMethods(
	tag: string,
	arity: number,
	methods: readonly ValidatableMethod[],
	errors: SpecValidationError[],
): void {
	for (const method of methods) {
		const schema = method?.result?.schema;
		if (!isPlainObject(schema) || schema[TRANSFERABLE_FIELD] !== tag) continue;

		const name = typeof method.name === 'string' ? method.name : '<unnamed>';
		const path = `methods["${name}"].result.schema.${TYPE_ARGS_FIELD}`;
		const typeArgs = schema[TYPE_ARGS_FIELD];

		if (typeArgs !== undefined && !Array.isArray(typeArgs)) {
			errors.push({ path, message: `${TYPE_ARGS_FIELD} must be an array of JSON Schema objects` });
			continue;
		}

		// `generate-spec.ts` guards the assignment on `typeArgs.length > 0`, so an
		// absent field is arity zero rather than a missing value.
		const count = Array.isArray(typeArgs) ? typeArgs.length : 0;
		if (count !== arity) {
			errors.push({
				path,
				message:
					`Tag "${tag}" is bound with genericArity ${arity}, so this result needs exactly ${arity} ` +
					`${TYPE_ARGS_FIELD} ${arity === 1 ? 'entry' : 'entries'}, found ${count}`,
			});
		}
	}
}
