// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication for Amazon Bedrock's OpenAI-compatible "Mantle" endpoint
 * (`https://bedrock-mantle.<region>.api.aws/v1`).
 *
 * Mantle accepts a Bedrock API key as the OpenAI `Authorization: Bearer` value. When a
 * `provider: 'openai-api'` model targets a Mantle endpoint without an explicit `apiKey`, the
 * agent mints short-term Bedrock API keys from the AWS credentials it runs with (the
 * deployed runtime role, or local AWS credentials) and refreshes them before they expire.
 *
 * @internal
 */
import { createHash, createHmac } from 'node:crypto';
import { installClientUserAgent } from '@aws-blocks/core';

/**
 * Matches a Mantle hostname and captures its AWS region (e.g. `us-east-1`, `us-gov-west-1`).
 *
 * Anchored at both ends and matched against the parsed URL hostname only: a minted key is
 * sent as the request's bearer value to whatever host the endpoint names, so it is only ever
 * attached to an endpoint whose hostname is exactly a Mantle host. Lookalike hosts
 * (`bedrock-mantle.us-east-1.api.aws.example.com`), plain `http:`, and a Mantle hostname that
 * appears only in the path or query do not match.
 */
const MANTLE_HOSTNAME = /^bedrock-mantle\.([a-z]{2}(-[a-z]+)+-[0-9]+)\.api\.aws$/;

/**
 * Returns the AWS region of a Bedrock Mantle endpoint, or `undefined` when the endpoint is not
 * an `https:` URL whose hostname is exactly `bedrock-mantle.<region>.api.aws`.
 */
export function parseMantleRegion(endpoint: string | undefined): string | undefined {
	if (!endpoint) return undefined;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:') return undefined;
	return MANTLE_HOSTNAME.exec(url.hostname)?.[1];
}

/** AWS credentials used to sign a Bedrock short-term API key. */
export interface MantleCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	/** When the credentials stop being valid. A key never outlives the credentials that signed it. */
	expiration?: Date;
}

/** Maximum (and default) lifetime of a Bedrock short-term API key, in seconds (12 hours). */
export const MANTLE_TOKEN_MAX_EXPIRES_IN_SECONDS = 43200;

/** A cached key is re-minted once it is within this many milliseconds of expiring. */
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

// Fixed inputs of a Bedrock short-term API key. The key is a SigV4 presigned
// `POST https://bedrock.amazonaws.com/?Action=CallWithBearerToken` request, signed for the
// `bedrock` service in the region the key is used in.
const TOKEN_HOST = 'bedrock.amazonaws.com';
const TOKEN_SERVICE = 'bedrock';
const TOKEN_PREFIX = 'bedrock-api-key-';
const TOKEN_VERSION = '&Version=1';
const ALGORITHM = 'AWS4-HMAC-SHA256';
/** SHA-256 of an empty body: the presigned request carries no payload. */
const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** RFC 3986 percent-encoding, as SigV4 requires for canonical query keys and values. */
function rfc3986(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
	return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** Serializes query parameters with RFC 3986-encoded keys and values, sorted by encoded key. */
function canonicalQuery(params: Record<string, string>): string {
	return Object.entries(params)
		.map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join('&');
}

/**
 * Builds a Bedrock short-term API key, the same format `@aws/bedrock-token-generator` produces.
 *
 * Format: `bedrock-api-key-` + base64(`bedrock.amazonaws.com/?<presigned query>&Version=1`),
 * where the presigned query is a SigV4 query-string signature (signed header `host`, empty
 * payload) of `POST https://bedrock.amazonaws.com/?Action=CallWithBearerToken` for service
 * `bedrock` in `region`. The service validates the embedded signature and runs the call as the
 * identity that signed it, until `X-Amz-Expires` seconds after `X-Amz-Date`.
 *
 * `expiresInSeconds` defaults to, and is capped at, 12 hours; it is further capped so the key
 * never outlives `credentials.expiration`.
 */
export function buildMantleBearerToken(options: {
	credentials: MantleCredentials;
	region: string;
	now?: Date;
	expiresInSeconds?: number;
}): string {
	const { credentials, region } = options;
	const now = options.now ?? new Date();
	const expiresIn = effectiveExpiresInSeconds(options.expiresInSeconds, credentials.expiration, now);

	// `YYYYMMDDTHHMMSSZ` and `YYYYMMDD`.
	const longDate = now
		.toISOString()
		.replace(/\.\d{3}Z$/, 'Z')
		.replace(/[-:]/g, '');
	const shortDate = longDate.slice(0, 8);
	const scope = `${shortDate}/${region}/${TOKEN_SERVICE}/aws4_request`;

	const params: Record<string, string> = {
		Action: 'CallWithBearerToken',
		'X-Amz-Algorithm': ALGORITHM,
		'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
		'X-Amz-Date': longDate,
		'X-Amz-Expires': String(expiresIn),
		'X-Amz-SignedHeaders': 'host',
	};
	// The session token is part of the signed query, not appended after signing.
	if (credentials.sessionToken) params['X-Amz-Security-Token'] = credentials.sessionToken;

	const canonicalRequest = [
		'POST',
		'/',
		canonicalQuery(params),
		`host:${TOKEN_HOST}`,
		'',
		'host',
		EMPTY_PAYLOAD_SHA256,
	].join('\n');
	const stringToSign = [ALGORITHM, longDate, scope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey = hmac(
		hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, shortDate), region), TOKEN_SERVICE),
		'aws4_request',
	);
	const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

	const presigned = `${TOKEN_HOST}/?${canonicalQuery({ ...params, 'X-Amz-Signature': signature })}${TOKEN_VERSION}`;
	return `${TOKEN_PREFIX}${Buffer.from(presigned, 'utf8').toString('base64')}`;
}

/**
 * Clamps a requested lifetime to `[1, 43200]` seconds and to the credentials' remaining lifetime.
 * A missing or non-finite request uses the maximum.
 */
function effectiveExpiresInSeconds(requested: number | undefined, expiration: Date | undefined, now: Date): number {
	let seconds =
		requested !== undefined && Number.isFinite(requested)
			? Math.floor(requested)
			: MANTLE_TOKEN_MAX_EXPIRES_IN_SECONDS;
	seconds = Math.min(seconds, MANTLE_TOKEN_MAX_EXPIRES_IN_SECONDS);
	if (expiration) {
		seconds = Math.min(seconds, Math.floor((expiration.getTime() - now.getTime()) / 1000));
	}
	return Math.max(seconds, 1);
}

/** @internal Test seams for {@link createMantleApiKeyResolver}. */
export interface MantleResolverOptions {
	/** Supplies AWS credentials. Defaults to the AWS SDK default credential chain via `BedrockClient`. */
	credentialsProvider?: () => Promise<MantleCredentials>;
	/** Current time. Defaults to `Date.now`. */
	now?: () => number;
	/** Requested key lifetime in seconds. Defaults to 12 hours. */
	expiresInSeconds?: number;
}

/**
 * Returns an async resolver (the OpenAI SDK's `ApiKeySetter` shape) yielding a Bedrock
 * short-term API key for `region`, minted from the ambient AWS credentials.
 *
 * The key is cached and re-minted once it is within 5 minutes of expiring, so a long-running
 * session keeps a valid key. Concurrent callers share one in-flight mint. Credentials and keys
 * are never logged.
 */
export function createMantleApiKeyResolver(
	region: string,
	customUserAgent?: [string, string][],
	options: MantleResolverOptions = {},
): () => Promise<string> {
	const now = options.now ?? Date.now;
	let credentialsProvider = options.credentialsProvider;
	let cached: { token: string; refreshAt: number } | undefined;
	let inFlight: Promise<string> | undefined;

	const getCredentials = async (): Promise<MantleCredentials> => {
		if (!credentialsProvider) {
			// Lazily built so importing this module (e.g. at synth) never loads the AWS SDK.
			// The client's credential provider is the SDK default chain, memoized and refreshed
			// by the SDK before the underlying credentials expire.
			const { BedrockClient } = await import('@aws-sdk/client-bedrock');
			const client = new BedrockClient({ region, customUserAgent });
			installClientUserAgent(client);
			credentialsProvider = () => client.config.credentials();
		}
		return credentialsProvider();
	};

	const mint = async (): Promise<string> => {
		const credentials = await getCredentials();
		const issuedAt = now();
		const expiresIn = effectiveExpiresInSeconds(
			options.expiresInSeconds,
			credentials.expiration,
			new Date(issuedAt),
		);
		const token = buildMantleBearerToken({
			credentials,
			region,
			now: new Date(issuedAt),
			expiresInSeconds: expiresIn,
		});
		cached = { token, refreshAt: issuedAt + expiresIn * 1000 - REFRESH_BEFORE_EXPIRY_MS };
		return token;
	};

	return async () => {
		if (cached && now() < cached.refreshAt) return cached.token;
		if (!inFlight) {
			inFlight = mint().finally(() => {
				inFlight = undefined;
			});
		}
		return inFlight;
	};
}

/** Shared resolvers, keyed by region and user agent. */
const sharedResolvers = new Map<string, () => Promise<string>>();

/** Resolvers that replace the shared resolver for a region, set via {@link _setMantleResolverForTest}. */
const testResolvers = new Map<string, () => Promise<string>>();

/**
 * Returns the shared {@link createMantleApiKeyResolver} for `region` and `customUserAgent`, so
 * every caller in the process (health checks and model clients) reuses one `BedrockClient` and
 * one cached key per region.
 */
export function getMantleApiKeyResolver(region: string, customUserAgent?: [string, string][]): () => Promise<string> {
	const override = testResolvers.get(region);
	if (override) return override;
	const key = `${region}\n${JSON.stringify(customUserAgent ?? null)}`;
	let resolver = sharedResolvers.get(key);
	if (!resolver) {
		resolver = createMantleApiKeyResolver(region, customUserAgent);
		sharedResolvers.set(key, resolver);
	}
	return resolver;
}

/**
 * Replaces the resolver {@link getMantleApiKeyResolver} returns for `region`; `undefined`
 * removes the replacement.
 *
 * @internal Test-only.
 */
export function _setMantleResolverForTest(region: string, resolver: (() => Promise<string>) | undefined): void {
	if (resolver) testResolvers.set(region, resolver);
	else testResolvers.delete(region);
}
