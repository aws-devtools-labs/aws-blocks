// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SettingVersion } from '../contract/v1.js';
import { awsClientConfig } from './aws-config.js';
import { decodeSettingValue } from './settings-inventory.js';

/**
 * Reading setting values out of one stage: SSM for a deployed stage, the mock's
 * own `settings.json` for local.
 *
 * ## Nothing here ever decrypts on a list path
 *
 * {@link fetchParameterValues} passes `WithDecryption: false` and is the only
 * function the list uses. A SecureString therefore comes back as ciphertext,
 * which is never shown: the live `Type` is checked and the value dropped. That
 * is deliberate belt and braces over the declaration's own `secret` flag, since
 * the flag is read from source and the parameter's type is a fact about the
 * stage. A parameter declared non-secret that is a SecureString in the account
 * is masked on the strength of the latter.
 *
 * Decryption happens in exactly one place, {@link fetchDecryptedParameter}, for
 * exactly one named parameter, and only from the route that requires the user
 * to ask for it.
 */

/** `GetParameters` takes at most ten names per call. */
const GET_PARAMETERS_BATCH = 10;

/** Where the mock keeps every setting, keyed by `fullId`. */
const LOCAL_SETTINGS_FILE = join('.bb-data', 'settings.json');

/** One parameter as the stage reports it, before any display decision. */
export interface StoredParameter {
	/** Raw stored string, still encoded. Absent for a SecureString on a list read. */
	raw?: string;
	/** Live parameter type, which outranks the declaration's `secret` flag. */
	type?: string;
	version?: number;
	lastModified?: string;
}

/** The fields of an SSM parameter this module reads, so a test needs no SDK. */
export interface SdkParameter {
	Type?: string;
	Value?: string;
	Version?: number;
	LastModifiedDate?: Date;
}

/**
 * One SDK parameter mapped for internal use, dropping a value that must not
 * travel.
 *
 * Extracted and exported for one reason: this is the line that decides whether
 * a SecureString's bytes leave the SSM client, and it sat inside a function
 * that makes a network call and so is not unit-tested. Both readers go through
 * it, which also means the rule is stated once rather than copied into each.
 *
 * `decrypted: false` is the list path. A SecureString read that way carries a
 * KMS ciphertext: useless to show, and indistinguishable from a value to a
 * reader, so it is dropped here rather than at the display layer. There is
 * deliberately no path by which it reaches a response at all.
 */
export function toStoredParameter(
	parameter: SdkParameter,
	options: { decrypted: boolean },
): StoredParameter {
	const stored: StoredParameter = {};
	if (parameter.Type !== undefined) stored.type = parameter.Type;
	if (parameter.Value !== undefined && (options.decrypted || parameter.Type !== 'SecureString')) {
		stored.raw = parameter.Value;
	}
	if (parameter.Version !== undefined) stored.version = Number(parameter.Version);
	if (parameter.LastModifiedDate) stored.lastModified = parameter.LastModifiedDate.toISOString();
	return stored;
}

/** A read that could not be attempted or came back refused. */
export class SettingsReadError extends Error {
	constructor(
		message: string,
		readonly code: 'NO_CREDENTIALS' | 'NOT_DEPLOYED' | 'ACCESS_DENIED' | 'UNKNOWN',
	) {
		super(message);
		this.name = 'SettingsReadError';
	}
}

/** Maps an SDK failure onto the codes the response can explain. */
export function classifyReadError(error: unknown): SettingsReadError {
	const name = (error as { name?: string } | undefined)?.name ?? '';
	const message = (error as Error | undefined)?.message ?? String(error);
	if (/AccessDenied|UnauthorizedOperation|AccessDeniedException/.test(name)) {
		return new SettingsReadError(
			`Your credentials cannot read SSM parameters: ${message}`,
			'ACCESS_DENIED',
		);
	}
	if (/CredentialsProviderError|ExpiredToken|InvalidClientTokenId/.test(name)) {
		return new SettingsReadError(`No usable AWS credentials: ${message}`, 'NO_CREDENTIALS');
	}
	// CloudFormation reports an absent stack as a ValidationError, which is the
	// ordinary state of a stage nobody has deployed yet rather than a fault. It
	// is classified here because this feature's two reads (the template, then
	// the parameters) share one error channel.
	if (name === 'ValidationError' || /does not exist/i.test(message)) {
		return new SettingsReadError(message, 'NOT_DEPLOYED');
	}
	return new SettingsReadError(message, 'UNKNOWN');
}

/**
 * Current values for named parameters, WITHOUT decryption.
 *
 * Names absent from the result are absent from the account, which is what
 * `InvalidParameters` reports. That is not an error: a declared setting that
 * was never deployed is an ordinary state the UI exists to show.
 */
export async function fetchParameterValues(
	names: readonly string[],
	region?: string,
): Promise<Map<string, StoredParameter>> {
	const found = new Map<string, StoredParameter>();
	if (names.length === 0) return found;
	const { SSMClient, GetParametersCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient(awsClientConfig(region));
	try {
		for (let index = 0; index < names.length; index += GET_PARAMETERS_BATCH) {
			const batch = names.slice(index, index + GET_PARAMETERS_BATCH);
			const response = await client.send(
				new GetParametersCommand({ Names: [...batch], WithDecryption: false }),
			);
			for (const parameter of response.Parameters ?? []) {
				if (!parameter.Name) continue;
				found.set(parameter.Name, toStoredParameter(parameter, { decrypted: false }));
			}
		}
	} catch (error) {
		throw classifyReadError(error);
	}
	return found;
}

/**
 * One parameter, decrypted, for a reveal the user asked for by name.
 *
 * Single-parameter by construction: a bulk decrypted read is the shape that
 * turns one careless click into every secret the app has.
 */
export async function fetchDecryptedParameter(
	name: string,
	region?: string,
): Promise<StoredParameter | undefined> {
	const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient(awsClientConfig(region));
	try {
		const response = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
		const parameter = response.Parameter;
		if (!parameter) return undefined;
		return toStoredParameter(parameter, { decrypted: true });
	} catch (error) {
		if ((error as { name?: string }).name === 'ParameterNotFound') return undefined;
		throw classifyReadError(error);
	}
}

/**
 * Versions of one parameter, newest first.
 *
 * Read WITHOUT decryption, so a secret's past values stay ciphertext and are
 * dropped: history exists here to make a rollback target choosable (a version
 * number and a timestamp), not to hand over every secret the parameter ever
 * held in one call.
 */
export async function fetchParameterHistory(
	name: string,
	secret: boolean,
	region?: string,
): Promise<SettingVersion[]> {
	const { SSMClient, GetParameterHistoryCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient(awsClientConfig(region));
	const versions: SettingVersion[] = [];
	try {
		const response = await client.send(
			new GetParameterHistoryCommand({ Name: name, WithDecryption: false }),
		);
		for (const entry of response.Parameters ?? []) {
			if (entry.Version === undefined) continue;
			const version: SettingVersion = { version: Number(entry.Version) };
			if (entry.LastModifiedDate) version.lastModified = entry.LastModifiedDate.toISOString();
			if (entry.LastModifiedUser) version.modifiedBy = entry.LastModifiedUser;
			if (!secret && entry.Type !== 'SecureString' && entry.Value !== undefined) {
				version.display = String(decodeSettingValue(entry.Value).value);
			}
			versions.push(version);
		}
	} catch (error) {
		if ((error as { name?: string }).name === 'ParameterNotFound') return [];
		throw classifyReadError(error);
	}
	return versions.sort((left, right) => right.version - left.version);
}

/**
 * The SSM type a setting's value must be stored as.
 *
 * Extracted and exported for the same reason as {@link toStoredParameter}: it
 * decides whether a secret stays KMS-encrypted, and it sat inside a function
 * that makes a network call and so is not unit-tested. Writing a secret as a
 * `String` silently downgrades it from a SecureString to a plaintext parameter,
 * which is the kind of change nobody notices until the value turns up in a log.
 */
export function parameterTypeFor(secret: boolean): 'SecureString' | 'String' {
	return secret ? 'SecureString' : 'String';
}

/**
 * Store one value, mirroring what `AppSetting.put()` writes.
 *
 * `Type` follows the setting's own nature rather than the value's, through
 * {@link parameterTypeFor}. `Overwrite: true` matches `put()`, and SSM offers no
 * conditional put, which is why the version check lives one layer up and is
 * documented as non-atomic.
 */
export async function putParameter(
	name: string,
	value: string,
	options: { secret: boolean },
	region?: string,
): Promise<number | undefined> {
	const { SSMClient, PutParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient(awsClientConfig(region));
	try {
		const response = await client.send(
			new PutParameterCommand({
				Name: name,
				Value: value,
				Type: parameterTypeFor(options.secret),
				Overwrite: true,
			}),
		);
		return response.Version === undefined ? undefined : Number(response.Version);
	} catch (error) {
		throw classifyReadError(error);
	}
}

/**
 * Every value the mock holds, keyed by `fullId`.
 *
 * Absent or unparseable reads as empty, matching the mock's own behaviour: it
 * creates the file on first construction, so "not there yet" is the state of a
 * project that has not run locally rather than a failure.
 */
export function readLocalSettings(projectRoot: string): Map<string, unknown> {
	const values = new Map<string, unknown>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(projectRoot, LOCAL_SETTINGS_FILE), 'utf8'));
	} catch {
		return values;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return values;
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		values.set(key, value);
	}
	return values;
}

/**
 * Store one value in the mock's own file, leaving every other key alone.
 *
 * Read-modify-write on purpose: the file is a single JSON object holding every
 * setting the app declares, so writing only the edited key would delete the
 * rest. The mock writes it with two-space indentation and so does this, because
 * the file sits in the user's git tree and a formatting change would show up as
 * a diff on every setting they did not touch.
 *
 * The value is stored DECODED, which is what the mock does: the file is the
 * JSON, so there is no second layer of encoding inside it.
 */
export function writeLocalSetting(projectRoot: string, fullId: string, value: unknown): void {
	const current = readLocalSettings(projectRoot);
	current.set(fullId, value);
	const path = join(projectRoot, LOCAL_SETTINGS_FILE);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(Object.fromEntries(current), null, 2)}\n`);
}
