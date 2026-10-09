// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The four user-pool properties Cognito will not change after the pool exists
 * — even though CloudFormation documents every one of them as "Update
 * requires: No interruption" — and the diff both guard layers share (decision
 * Q5, task D4):
 *
 * | Property | AWS evidence |
 * |---|---|
 * | `UsernameAttributes` / `AliasAttributes` (`users.signInWith`) | "After you create a user pool, you can't change this setting." — <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#user-pool-settings-aliases> |
 * | `UsernameConfiguration.CaseSensitive` | "This configuration is immutable after you set it." — <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpool.html>; unset means `true` — <https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_UsernameConfigurationType.html> |
 * | Required standard attributes (`Schema[].Required`) | "After you create a user pool, you can't switch an attribute between required and not required." — <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html> |
 * | Existing custom attributes | "You can't remove or change a custom attribute after you add it … You also can't change its data type, mutability, or length constraints." — same page. Adding one is fine. |
 *
 * CDK synths such a change and `cdk diff` shows a harmless update; the deploy
 * then fails on the pool and the whole stack rolls back. Layer 1
 * (`immutability-baseline.ts`) diffs the synthesized values against a
 * committed baseline file; layer 2 (`immutability-guard-lambda.ts`) diffs them
 * at deploy time, before the pool update runs.
 *
 * Pure and dependency-free (no `aws-cdk-lib`, no SDK): the deploy-time Lambda
 * bundles this file.
 *
 * @internal
 */

/** Bumped when the snapshot shape changes; a guard that sees another version falls back to the live pool. */
export const SNAPSHOT_VERSION = 1;

/** One custom attribute as the template (or the live pool) declares it. `null` = not specified. */
export interface CustomAttributeSnapshot {
	/** `AttributeDataType` (`String`, `Number`, `DateTime`, `Boolean`). */
	type: string | null;
	mutable: boolean | null;
	developerOnly: boolean | null;
	/** `StringAttributeConstraints` / `NumberAttributeConstraints`, values as strings. `null` = none set. */
	constraints: Record<string, string> | null;
}

/** The values of the four service-immutable properties of one user pool. */
export interface PoolImmutables {
	version: typeof SNAPSHOT_VERSION;
	/** `UsernameAttributes`, sorted (`[]` when unset). */
	usernameAttributes: string[];
	/** `AliasAttributes`, sorted (`[]` when unset). */
	aliasAttributes: string[];
	/** `UsernameConfiguration.CaseSensitive`; `null` when the template leaves it unset (Cognito then uses `true`). */
	caseSensitive: boolean | null;
	/** Standard attributes declared `Required: true`, sorted. `sub` (always required) is never listed. */
	requiredAttributes: string[];
	/** Custom attributes keyed by name, without the `custom:` / `dev:custom:` prefix. */
	customAttributes: Record<string, CustomAttributeSnapshot>;
}

/** Which of the four properties a {@link Violation} is about (plus pool removal, for the baseline layer). */
export type ImmutableProperty =
	| 'signInAttributes'
	| 'caseSensitive'
	| 'requiredAttributes'
	| 'customAttribute'
	| 'poolRemoved';

/** One change Cognito will reject (or, for `poolRemoved`, a change that deletes every user). */
export interface Violation {
	property: ImmutableProperty;
	/** Human-readable: what changed, old → new. */
	change: string;
	/** Why it fails, quoting AWS. */
	why: string;
}

/**
 * The OIDC standard attributes Cognito defines
 * (<https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#cognito-user-pools-standard-attributes>).
 * A template `Schema` entry with one of these names configures the standard
 * attribute; any other name declares a custom attribute.
 */
const STANDARD_ATTRIBUTES: ReadonlySet<string> = new Set([
	'address',
	'birthdate',
	'email',
	'family_name',
	'gender',
	'given_name',
	'locale',
	'middle_name',
	'name',
	'nickname',
	'phone_number',
	'picture',
	'preferred_username',
	'profile',
	'sub',
	'updated_at',
	'website',
	'zoneinfo',
]);

const WHY = {
	signInAttributes:
		'Cognito fixes sign-in attributes when the pool is created: "After you create a user pool, you can\'t change this setting."',
	caseSensitive:
		'Cognito fixes username case sensitivity when the pool is created: "This configuration is immutable after you set it." (unset means case-sensitive)',
	requiredAttributes:
		'Cognito fixes required attributes when the pool is created: "After you create a user pool, you can\'t switch an attribute between required and not required."',
	customAttributeChanged:
		'Cognito custom attributes are permanent: "You can\'t remove or change a custom attribute after you add it … You also can\'t change its data type, mutability, or length constraints." Adding a new one is fine.',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Snapshots
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').sort() : [];
}

function boolOrNull(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value;
	// CloudFormation hands custom-resource properties to the Lambda as strings.
	if (value === 'true') return true;
	if (value === 'false') return false;
	return null;
}

function constraintsOf(value: unknown): Record<string, string> | null {
	if (!isRecord(value)) return null;
	const out: Record<string, string> = {};
	for (const key of Object.keys(value).sort()) {
		const v = value[key];
		if (v !== undefined && v !== null) out[key] = String(v);
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** Read a key under either its CloudFormation (`PascalCase`) or CDK L1 (`camelCase`) spelling. */
function pick(obj: Record<string, unknown>, pascal: string): unknown {
	if (pascal in obj) return obj[pascal];
	return obj[pascal.charAt(0).toLowerCase() + pascal.slice(1)];
}

/**
 * The four properties as a user-pool template declares them. Accepts the CDK
 * L1 `CfnUserPool` props (camelCase, after `Stack.resolve`) or raw
 * CloudFormation `Properties` (PascalCase).
 */
export function snapshotFromTemplate(props: {
	usernameAttributes?: unknown;
	aliasAttributes?: unknown;
	usernameConfiguration?: unknown;
	schema?: unknown;
}): PoolImmutables {
	const usernameConfiguration = isRecord(props.usernameConfiguration) ? props.usernameConfiguration : {};
	const required = new Set<string>();
	const custom: Record<string, CustomAttributeSnapshot> = {};
	for (const entry of Array.isArray(props.schema) ? props.schema : []) {
		if (!isRecord(entry)) continue;
		const name = pick(entry, 'Name');
		if (typeof name !== 'string') continue;
		if (STANDARD_ATTRIBUTES.has(name)) {
			if (boolOrNull(pick(entry, 'Required')) === true && name !== 'sub') required.add(name);
			continue;
		}
		custom[name] = {
			type:
				typeof pick(entry, 'AttributeDataType') === 'string' ? String(pick(entry, 'AttributeDataType')) : null,
			mutable: boolOrNull(pick(entry, 'Mutable')),
			developerOnly: boolOrNull(pick(entry, 'DeveloperOnlyAttribute')),
			constraints:
				constraintsOf(pick(entry, 'StringAttributeConstraints')) ??
				constraintsOf(pick(entry, 'NumberAttributeConstraints')),
		};
	}
	return {
		version: SNAPSHOT_VERSION,
		usernameAttributes: stringList(props.usernameAttributes),
		aliasAttributes: stringList(props.aliasAttributes),
		caseSensitive: boolOrNull(pick(usernameConfiguration, 'CaseSensitive')),
		requiredAttributes: [...required].sort(),
		customAttributes: sortedRecord(custom),
	};
}

/** The parts of a `DescribeUserPool` response the guard reads (`UserPoolType`). */
export interface LiveUserPool {
	UsernameAttributes?: string[];
	AliasAttributes?: string[];
	UsernameConfiguration?: { CaseSensitive?: boolean };
	SchemaAttributes?: {
		Name?: string;
		AttributeDataType?: string;
		Mutable?: boolean;
		Required?: boolean;
		DeveloperOnlyAttribute?: boolean;
		StringAttributeConstraints?: Record<string, string | undefined>;
		NumberAttributeConstraints?: Record<string, string | undefined>;
	}[];
}

/**
 * The four properties of a deployed pool, from `DescribeUserPool`. Custom
 * attributes come back as `custom:<name>` (developer-only: `dev:custom:<name>`);
 * every standard attribute is listed, and only `sub` is required by default.
 */
export function snapshotFromLive(pool: LiveUserPool): PoolImmutables {
	const required = new Set<string>();
	const custom: Record<string, CustomAttributeSnapshot> = {};
	for (const attr of pool.SchemaAttributes ?? []) {
		const name = attr.Name;
		if (!name) continue;
		const customName = /^(?:dev:)?custom:(.+)$/.exec(name)?.[1];
		if (customName === undefined) {
			if (attr.Required === true && name !== 'sub') required.add(name);
			continue;
		}
		custom[customName] = {
			type: attr.AttributeDataType ?? null,
			mutable: attr.Mutable ?? null,
			developerOnly: attr.DeveloperOnlyAttribute ?? null,
			constraints:
				constraintsOf(attr.StringAttributeConstraints) ?? constraintsOf(attr.NumberAttributeConstraints),
		};
	}
	return {
		version: SNAPSHOT_VERSION,
		usernameAttributes: stringList(pool.UsernameAttributes),
		aliasAttributes: stringList(pool.AliasAttributes),
		caseSensitive:
			typeof pool.UsernameConfiguration?.CaseSensitive === 'boolean'
				? pool.UsernameConfiguration.CaseSensitive
				: null,
		requiredAttributes: [...required].sort(),
		customAttributes: sortedRecord(custom),
	};
}

/**
 * Parse a snapshot that crossed a JSON or CloudFormation boundary (a baseline
 * file, a custom-resource property — either the object or its JSON string).
 * `undefined` when it is not a snapshot of
 * this {@link SNAPSHOT_VERSION} — callers then treat the old state as unknown.
 */
export function parseSnapshot(input: unknown): PoolImmutables | undefined {
	let value = input;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!isRecord(value) || Number(value.version) !== SNAPSHOT_VERSION) return undefined;
	if (!Array.isArray(value.usernameAttributes) || !Array.isArray(value.aliasAttributes)) return undefined;
	if (!Array.isArray(value.requiredAttributes) || !isRecord(value.customAttributes)) return undefined;
	const custom: Record<string, CustomAttributeSnapshot> = {};
	for (const [name, def] of Object.entries(value.customAttributes)) {
		if (!isRecord(def)) return undefined;
		custom[name] = {
			type: typeof def.type === 'string' ? def.type : null,
			mutable: boolOrNull(def.mutable),
			developerOnly: boolOrNull(def.developerOnly),
			constraints: constraintsOf(def.constraints),
		};
	}
	return {
		version: SNAPSHOT_VERSION,
		usernameAttributes: stringList(value.usernameAttributes),
		aliasAttributes: stringList(value.aliasAttributes),
		caseSensitive: boolOrNull(value.caseSensitive),
		requiredAttributes: stringList(value.requiredAttributes),
		customAttributes: sortedRecord(custom),
	};
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff
// ─────────────────────────────────────────────────────────────────────────────

export interface DiffOptions {
	/**
	 * `before` was read from the live pool (`snapshotFromLive`), not from a
	 * template. The live pool reports every field of a custom attribute, with
	 * Cognito's defaults filled in, so a field is compared only where `after`
	 * (the template) actually sets it — otherwise a template that never
	 * mentioned a default would look like a change.
	 */
	beforeIsLive?: boolean;
}

const list = (values: readonly string[]) => `[${values.join(', ')}]`;
const sameList = (a: readonly string[], b: readonly string[]) => a.join('\u0000') === b.join('\u0000');

function describeCustom(def: CustomAttributeSnapshot): string {
	const parts = [
		def.type ?? 'type unset',
		def.mutable === null ? 'mutability unset' : def.mutable ? 'mutable' : 'immutable',
	];
	if (def.developerOnly) parts.push('developer-only');
	if (def.constraints) {
		parts.push(
			Object.entries(def.constraints)
				.map(([k, v]) => `${k} ${v}`)
				.join(', '),
		);
	}
	return parts.join(', ');
}

function customChanged(before: CustomAttributeSnapshot, after: CustomAttributeSnapshot, live: boolean): boolean {
	const differs = <T>(b: T | null, a: T | null): boolean => (live && a === null ? false : b !== a);
	if (differs(before.type, after.type)) return true;
	if (differs(before.mutable, after.mutable)) return true;
	// An unset `DeveloperOnlyAttribute` is `false` (CloudFormation's default).
	if ((before.developerOnly ?? false) !== (after.developerOnly ?? false) && !(live && after.developerOnly === null)) {
		return true;
	}
	if (live) {
		if (!after.constraints) return false;
		return Object.entries(after.constraints).some(([k, v]) => before.constraints?.[k] !== v);
	}
	return JSON.stringify(before.constraints) !== JSON.stringify(after.constraints);
}

/**
 * Every change from `before` to `after` that Cognito rejects on an existing
 * pool. Permitted changes produce nothing: everything outside the four
 * properties is ignored, and a custom attribute that only `after` declares is
 * an addition, which Cognito accepts.
 *
 * `UsernameConfiguration` left unset compares equal to `CaseSensitive: true`
 * (Cognito's default), so stating the default explicitly is not a change.
 */
export function diffImmutables(before: PoolImmutables, after: PoolImmutables, options?: DiffOptions): Violation[] {
	const out: Violation[] = [];
	if (
		!sameList(before.usernameAttributes, after.usernameAttributes) ||
		!sameList(before.aliasAttributes, after.aliasAttributes)
	) {
		const parts: string[] = [];
		if (!sameList(before.usernameAttributes, after.usernameAttributes)) {
			parts.push(`UsernameAttributes ${list(before.usernameAttributes)} → ${list(after.usernameAttributes)}`);
		}
		if (!sameList(before.aliasAttributes, after.aliasAttributes)) {
			parts.push(`AliasAttributes ${list(before.aliasAttributes)} → ${list(after.aliasAttributes)}`);
		}
		out.push({
			property: 'signInAttributes',
			change: `sign-in attributes (\`users.signInWith\`): ${parts.join('; ')}`,
			why: WHY.signInAttributes,
		});
	}
	const caseBefore = before.caseSensitive ?? true;
	const caseAfter = after.caseSensitive ?? true;
	if (caseBefore !== caseAfter) {
		out.push({
			property: 'caseSensitive',
			change: `UsernameConfiguration.CaseSensitive: ${caseBefore} → ${caseAfter}`,
			why: WHY.caseSensitive,
		});
	}
	if (!sameList(before.requiredAttributes, after.requiredAttributes)) {
		out.push({
			property: 'requiredAttributes',
			change: `required attributes: ${list(before.requiredAttributes)} → ${list(after.requiredAttributes)}`,
			why: WHY.requiredAttributes,
		});
	}
	const live = options?.beforeIsLive === true;
	for (const [name, def] of Object.entries(before.customAttributes)) {
		const next = after.customAttributes[name];
		if (!next) {
			out.push({
				property: 'customAttribute',
				change: `custom attribute 'custom:${name}' removed (was: ${describeCustom(def)})`,
				why: WHY.customAttributeChanged,
			});
		} else if (customChanged(def, next, live)) {
			out.push({
				property: 'customAttribute',
				change: `custom attribute 'custom:${name}' changed: ${describeCustom(def)} → ${describeCustom(next)}`,
				why: WHY.customAttributeChanged,
			});
		}
	}
	return out;
}

/** The remedy every violation shares, pointing at the `DESIGN.md` runbook. */
export const REMEDY =
	'Revert the change. A deployed pool cannot take it: changing it means a new user pool and a user migration — ' +
	'see "Changing an immutable pool property" in the @aws-blocks/bb-auth DESIGN.md.';
