// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
	BlockSettingDeclaration,
	DataMode,
	DeployOwnedValue,
	DiscoveredBlock,
	SettingEncoding,
	SettingEntry,
	SettingValueKind,
} from '../contract/v1.js';
import type { RawTemplate } from './resources.js';

/**
 * What a settings editor may say about one AppSetting in one stage, and the
 * encoding it must use to write one.
 *
 * Pure: every input is passed in, so the whole contract is unit-testable with
 * no credentials, no project on disk and no deployed stack.
 *
 * ## The encoding is not a detail, it is the correctness of every write
 *
 * `AppSetting.put()` stores `JSON.stringify(value)` and `get()` reads it back
 * with `JSON.parse`, falling back to the raw string when that throws (the
 * runtime calls those "old-format values"). So a write that stores the user's
 * text verbatim is readable but NOT equivalent: the string `5` comes back as
 * the NUMBER 5, `true` as a boolean, and `{"a":1}` as an object. A text box
 * wired straight to `PutParameter` therefore changes the TYPE of the value the
 * app sees, silently, on exactly the values most likely to be typed into a
 * config field. {@link encodeSettingValue} exists to make that impossible: the
 * caller states whether the input is text or JSON, and the encoder mirrors
 * `put()` either way.
 *
 * ## Two address spaces, one identity
 *
 * `fullId` identifies a setting everywhere, but the address differs by mode:
 * the mock keys `.bb-data/settings.json` by `fullId`, while a deployed stage
 * addresses an SSM parameter by path. A join that used one key for both would
 * report every cloud setting as undeclared.
 */

/** SSM standard-tier value limit, which is what both stages are sized against. */
export const SETTING_VALUE_MAX_BYTES = 4096;

/**
 * One AppSetting as a settings editor sees it in one stage.
 *
 * The wire shape minus the value, rather than a second declaration of the same
 * fields: the join produces the facts, and reading the value is a separate step
 * that may fail on its own.
 */
export type SettingRow = Omit<SettingEntry, 'value' | 'valueHidden' | 'error'>;

/** Declared settings joined against one stage. */
export interface SettingsInventory {
	settings: SettingRow[];
	/**
	 * Addresses live in the stage that no ADDRESSABLE declaration claims.
	 *
	 * So when any row has no `address` (an explicit name built from a variable),
	 * one of these may well belong to it. A consumer listing orphans as
	 * undeclared must say so, because the alternative reads as "delete these".
	 */
	orphans: string[];
}

/** A rejected write, with the reason the user has to act on. */
export interface SettingEncodeRejected {
	ok: false;
	reason: 'invalid-json' | 'too-large' | 'empty-secret';
	message: string;
}

/** An accepted write, carrying the exact string to store. */
export interface SettingEncodeAccepted {
	ok: true;
	/** Mirrors `AppSetting.put()`: this is what goes in the parameter. */
	encoded: string;
	/** The decoded value, for a confirmation the user can check before writing. */
	value: unknown;
}

export type SettingEncodeResult = SettingEncodeAccepted | SettingEncodeRejected;

/** The AppSettings a block inventory declares, in declaration order. */
export function declaredSettings(blocks: readonly DiscoveredBlock[]): DiscoveredBlock[] {
	// Keyed off the `setting` field rather than `type === 'AppSetting'`: the
	// field is set by whatever recognised the declaration, so there is no second
	// place that has to agree about which block types carry a value.
	return blocks.filter((block) => block.setting !== undefined);
}

/**
 * Read a stored parameter value the way `AppSetting.get()` does.
 *
 * Returns the encoding alongside the value because the two cases are not
 * interchangeable to a caller that is about to write: a `raw` value is in the
 * pre-JSON format, so re-saving it through {@link encodeSettingValue} CHANGES
 * the stored bytes (to the format the runtime writes today). That is a
 * migration, and the UI should be able to say so rather than present it as a
 * no-op edit.
 */
export function decodeSettingValue(raw: string): { value: unknown; encoding: SettingEncoding } {
	try {
		return { value: JSON.parse(raw) as unknown, encoding: 'json' };
	} catch {
		return { value: raw, encoding: 'raw' };
	}
}

/**
 * Validate and encode one edit, mirroring `AppSetting.put()`.
 *
 * What this does NOT do is run the app's Standard Schema. The schema lives in
 * app source and is reachable only from the app's own process, so a dashboard
 * write bypasses it exactly as a direct DynamoDB write bypasses the app's
 * validation. `hasSchema` on the row is what lets the UI say that out loud; it
 * must never be presented as validation performed here.
 */
export function encodeSettingValue(
	input: string,
	kind: SettingValueKind,
	options: { secret: boolean },
): SettingEncodeResult {
	let value: unknown = input;
	if (kind === 'json') {
		try {
			value = JSON.parse(input) as unknown;
		} catch (error) {
			return {
				ok: false,
				reason: 'invalid-json',
				message: `Not valid JSON: ${(error as Error).message}. Switch the value to text to store it literally.`,
			};
		}
	}

	// `get()` throws ParameterNotFound on an empty secret, so storing one breaks
	// the app at its next read. Checked before the size limit because an empty
	// value can never fail that one, and the specific message is the useful one.
	if (options.secret && input.length === 0) {
		return {
			ok: false,
			reason: 'empty-secret',
			message: 'A secret cannot be empty: the app fails at its next read with ParameterNotFound.',
		};
	}

	const encoded = JSON.stringify(value);
	const bytes = Buffer.byteLength(encoded, 'utf8');
	if (bytes > SETTING_VALUE_MAX_BYTES) {
		return {
			ok: false,
			reason: 'too-large',
			message: `Encoded value is ${bytes} bytes, over the ${SETTING_VALUE_MAX_BYTES} byte SSM standard-tier limit.`,
		};
	}

	return { ok: true, encoded, value };
}

/**
 * SSM parameter paths a deployed template creates, and whether that list is
 * complete.
 *
 * Two shapes, because the framework creates the two kinds differently: a plain
 * value is an `AWS::SSM::Parameter`, while every SecureString in a stack is
 * created by ONE custom resource that carries their names in a `ParameterNames`
 * list (CloudFormation cannot create a SecureString natively). Reading only the
 * first type would report every secret as undeployed.
 *
 * The custom resource is found by that property rather than by its logical id
 * or construct path. An id prefix would be a naming heuristic of exactly the
 * kind the resource inventory avoids, and it breaks on a nested stack or a
 * renamed construct, while `ParameterNames` is the framework's own property
 * name. The cost is that a user's unrelated custom resource carrying the same
 * property would contribute names, which shows up as an orphan rather than
 * silently changing a declared setting's state.
 *
 * `complete` is false when a name is present but not a literal string, which is
 * what a CloudFormation intrinsic looks like from here.
 */
export function templateParameterNames(template: RawTemplate): { names: string[]; complete: boolean } {
	const names: string[] = [];
	let complete = true;
	for (const resource of Object.values(template.Resources ?? {})) {
		if (resource.Type === 'AWS::SSM::Parameter') {
			const name = resource.Properties?.Name;
			if (typeof name === 'string') names.push(name);
			else complete = false;
			continue;
		}
		const declared = resource.Properties?.ParameterNames;
		if (declared === undefined) continue;
		if (!Array.isArray(declared)) {
			// The bulk resource is there, so this stack HAS secrets, and we
			// cannot name them. Not treated as an empty list: that would read as
			// "no secrets here" and turn every declared secret into `absent`.
			complete = false;
			continue;
		}
		for (const entry of declared) {
			if (typeof entry === 'string') names.push(entry);
			else complete = false;
		}
	}
	return { names, complete };
}

/**
 * Handler environment variables the deployed template sets.
 *
 * Read from the template rather than from `GetFunctionConfiguration`, which
 * needs a Lambda client this package does not have and an IAM action it does
 * not need: the resource inventory already fetches this document, so the answer
 * is in hand. It is also the more honest answer for a read-only view, because
 * it is what the last DEPLOY set rather than whatever may since have been
 * poked into the live function.
 *
 * A value that resolves only at deploy time (a bucket name, a table ARN) is
 * reported as `deployTime` with no value, rather than printing the raw
 * `{"Ref":...}` as though it were the setting.
 */
export function templateHandlerEnvironment(template: RawTemplate): DeployOwnedValue[] {
	const found: DeployOwnedValue[] = [];
	const seen = new Set<string>();
	for (const resource of Object.values(template.Resources ?? {})) {
		if (resource.Type !== 'AWS::Lambda::Function') continue;
		const environment = resource.Properties?.Environment;
		if (typeof environment !== 'object' || environment === null) continue;
		const variables = (environment as { Variables?: unknown }).Variables;
		if (typeof variables !== 'object' || variables === null) continue;
		for (const [key, value] of Object.entries(variables as Record<string, unknown>)) {
			// A stack has several functions and they share most of their
			// environment, so the first definition of a key wins and the rest
			// are dropped. Listing one key N times would read as N settings.
			if (seen.has(key)) continue;
			seen.add(key);
			found.push(typeof value === 'string' ? { key, value, deployTime: false } : { key, deployTime: true });
		}
	}
	return found.sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * The deployed parameter path for one declared setting, read from the template.
 *
 * A source scan CANNOT derive this. `fullId` walks the scope's parent chain, and
 * in a deployed stack the Scope's parent is the stack itself, so the framework
 * synthesizes `/${stackName}-${fullId}`: rota's `min-educators` is
 * `/rota-3a4f18-dev-bf9209-rota-min-educators`, not `/rota-min-educators`.
 * In the mock the Scope has no parent, so there `fullId` IS the bare id, which
 * is why local addressing works off it and cloud addressing must not.
 *
 * Both candidate forms are built EXACTLY from the stack name rather than matched
 * by suffix. A suffix rule is tempting and wrong: `/${stack}-rota-min-educators`
 * also ends with `-educators`, so a sibling declaration named `educators` would
 * claim another setting's parameter. The stack name is known, so there is no
 * need to guess.
 *
 * An explicitly named parameter is passed through literally, because the CDK
 * layer uses `options.name` verbatim with no prefix.
 *
 * Returns undefined when the template creates no matching parameter, which
 * means this stack does not have the setting: the fix is a deploy, not a write
 * to a guessed path.
 */
export function cloudAddressFor(
	declaration: BlockSettingDeclaration,
	fullId: string,
	templateNames: readonly string[],
	stackName: string,
): string | undefined {
	if (declaration.nameSource === 'unresolved') return undefined;
	if (declaration.nameSource === 'explicit') return declaration.parameterName;
	// Bare first: a stack whose scope has no parent id produces the unprefixed
	// form, and an exact hit there is unambiguous.
	for (const candidate of [`/${fullId}`, `/${stackName}-${fullId}`]) {
		if (templateNames.includes(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Join declared settings against the addresses one stage actually holds.
 *
 * `mode` picks the address space: `local` keys by `fullId` (how the mock keys
 * `.bb-data/settings.json`), `cloud` by the SSM path `addresses` carries. Cloud
 * callers MUST supply that map (see {@link cloudAddressFor}): the deployed path
 * is stack-prefixed and so cannot be derived from source.
 *
 * `live` must be what the stage HOLDS rather than what its template declares,
 * because those differ: a parameter can be deleted out of band. The cloud
 * caller therefore queries every resolved address by name and passes the
 * result, which is what makes `absent` a settled answer rather than a guess.
 * A declaration with no resolvable address is never `absent`, since nothing
 * was asked about it.
 */
export function joinSettings(args: {
	blocks: readonly DiscoveredBlock[];
	mode: DataMode;
	/** Addresses present in the stage, in that mode's address space. */
	live: readonly string[];
	/** fullId to SSM path. Cloud mode only; a missing entry is unaddressable. */
	addresses?: ReadonlyMap<string, string>;
}): SettingsInventory {
	const { blocks, mode, live } = args;
	const liveSet = new Set(live);
	const claimed = new Set<string>();
	const settings: SettingRow[] = [];

	for (const block of declaredSettings(blocks)) {
		// Non-null: `declaredSettings` filters on exactly this field.
		const declaration = block.setting as NonNullable<DiscoveredBlock['setting']>;
		const address = mode === 'local' ? block.fullId : args.addresses?.get(block.fullId);
		const row: SettingRow = {
			fullId: block.fullId,
			id: block.id,
			file: block.file,
			line: block.line,
			presence: 'unknown',
			secret: declaration.secret,
			hasSchema: declaration.hasSchema,
			external: declaration.external,
			nameSource: declaration.nameSource,
		};
		if (address !== undefined) {
			row.address = address;
			row.presence = liveSet.has(address) ? 'present' : 'absent';
			if (liveSet.has(address)) claimed.add(address);
		}
		settings.push(row);
	}

	return { settings, orphans: live.filter((address) => !claimed.has(address)) };
}
