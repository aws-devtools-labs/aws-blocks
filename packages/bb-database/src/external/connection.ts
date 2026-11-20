// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PG_DEFAULT_DATABASE, PG_PORT } from '../constants.js';
import { configError } from '../errors.js';

/** A connection string split into the fields the driver takes, so nothing in the URL can change how TLS is done. */
export interface ConnectionFields {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

// pg merges a connection string over the programmatic config, and each of these replaces or turns off the
// `ssl` object the engine passes. A URL that carries one is refused, not cleaned: the author meant something by it.
const TLS_PARAMETERS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation', 'uselibpqcompat'];

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;

/**
 * Splits `value`, the stored connection string, into discrete fields. `source` names where the value came from
 * (a setting, a prompt) and is the only thing an error mentions: the value holds a password, and the URL
 * parser's own error carries its whole input.
 */
export function parseConnectionString(value: unknown, source: string): ConnectionFields {
	if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
		throw configError(`${source} has no value. Store a connection string with \`npm run db connect\`.`);
	}
	if (typeof value !== 'string' || !POSTGRES_URL.test(value.trim())) {
		throw configError(
			// A secret that was never stored reads as a random placeholder, so "not set" and "malformed" look the same here.
			`${source} is not set, or is not a PostgreSQL connection string (a postgres:// or postgresql:// URL). ` +
				'Store one with `npm run db connect`.',
		);
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw configError(
			`${source} is not a valid URL. Encode special characters in the ` +
				'user name and the password (for example # as %23).',
		);
	}
	const tls = TLS_PARAMETERS.filter((name) => url.searchParams.has(name));
	if (tls.length > 0) {
		throw configError(
			`${source} has the TLS parameter${tls.length > 1 ? 's' : ''} ` +
				`${tls.map((name) => `'${name}'`).join(', ')}. Remove ${tls.length > 1 ? 'them' : 'it'}: the server ` +
				'certificate is always verified, against the `ca` of DatabaseCluster.fromExisting() or the system trust store.',
		);
	}
	const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
	if (!host) throw configError(`${source} has no host.`);
	return {
		host,
		port: url.port ? Number(url.port) : PG_PORT,
		user: decodeURIComponent(url.username),
		password: decodeURIComponent(url.password),
		database: decodeURIComponent(url.pathname.replace(/^\//, '')) || PG_DEFAULT_DATABASE,
	};
}

// What an error calls the place a connection string is read from. The value itself is never in a message.
/** The local value of connection `name`. */
export const localConnectionLabel = (name: string): string =>
	`The local value of connection '${name}' (.cdk-blocks/local/data/settings.json)`;
/** The SSM parameter of a stage. */
export const ssmConnectionLabel = (parameterName: string): string => `The SSM parameter ${parameterName}`;
/** An `AppSetting`, a `Secret` or another source that the application passed as `connectionString`. */
export const sourceConnectionLabel = (blockFullId: string): string =>
	`The connection string source of Database '${blockFullId}'`;

const PEM_CERTIFICATE = '-----BEGIN CERTIFICATE-----';

/** `ca` must be PEM text of a certificate; a path or a private key is a mistake worth naming before the first connect. */
export function assertCaPem(ca: unknown, owner: string): void {
	if (ca === undefined) return;
	if (typeof ca !== 'string' || !ca.includes(PEM_CERTIFICATE)) {
		throw configError(
			`${owner}: 'ca' must be the PEM text of a certificate (it contains "${PEM_CERTIFICATE}"), not a file path.`,
		);
	}
}
