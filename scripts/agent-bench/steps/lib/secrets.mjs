// Credential hygiene for the bench, in one place: (1) the env policy for every process that runs
// agent-controlled code (the builder + judge shells in run-shell.ts and the app processes step 3
// starts via agent-exec.mjs; all run as the isolated agent user, see isolation.mjs), and (2)
// redaction of anything the workflow publishes or sends to a model.
//
// The harness processes themselves keep the full job env: the builder/judge Bedrock calls run in the
// harness (Strands BedrockModel) and the analysis calls run the `aws` CLI from the harness, so only
// the agent's processes are scrubbed. Pure + unit-tested in secrets.test.mjs.
import { dirname, isAbsolute, normalize } from 'node:path';

// ── Env policy ───────────────────────────────────────────────────────────────────────────────
// ALLOWLIST first: a shell gets only what builds, installs, browsers and tests need. Everything else
// (GITHUB_* runner paths incl. GITHUB_ENV/GITHUB_OUTPUT, RUNNER_TEMP, job inputs, BENCH_* harness
// config) is dropped.
const ALLOW_EXACT = new Set([
	// process basics + locale/terminal
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'TMPDIR',
	'HOSTNAME',
	'LANG',
	'LANGUAGE',
	'TZ',
	'TERM',
	'COLORTERM',
	'FORCE_COLOR',
	'NO_COLOR',
	'XDG_CONFIG_HOME',
	'XDG_CACHE_HOME',
	'XDG_DATA_HOME',
	'XDG_RUNTIME_DIR',
	// CI markers (tools switch to non-interactive output on these)
	'CI',
	'GITHUB_ACTIONS',
	'RUNNER_OS',
	'RUNNER_ARCH',
	// node / TLS / proxy (NODE_OPTIONS is sanitized below)
	'NODE_OPTIONS',
	'NODE_ENV',
	'NODE_EXTRA_CA_CERTS',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'ALL_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy',
	'all_proxy',
	// region only (not a credential); the local dev server runs mocked and needs no AWS creds
	'AWS_REGION',
	'AWS_DEFAULT_REGION',
	// the framework's telemetry opt-out (a flag, not a credential)
	'AWS_BLOCKS_DISABLE_TELEMETRY',
	// the scaffolded app the builder works in
	'WORKSPACE',
]);
// LC_* locale, npm config (fetch retries, cache), the shared Playwright browser cache, framework config.
const ALLOW_PREFIXES = ['LC_', 'NPM_CONFIG_', 'npm_config_', 'PLAYWRIGHT_', 'BLOCKS_'];

// DENYLIST, applied after the allowlist and to per-command overrides, so neither can reintroduce:
//   - hard credential families: AWS_* (keys, session token, profile, web-identity, container
//     credentials, config/credential file paths) except the non-credential names above; every
//     ACTIONS_* runner var (ACTIONS_ID_TOKEN_REQUEST_* mints a fresh OIDC token,
//     ACTIONS_RUNTIME_*/ACTIONS_CACHE_* reach the runner services); GitHub and npm tokens;
//   - credential-SHAPED names (TOKEN, SECRET, PASSW, KEY, CREDENTIAL, AUTH);
//   - runner plumbing: the GITHUB_* file commands (writing GITHUB_ENV/GITHUB_PATH would inject env
//     or PATH into later, credential-bearing steps), every other GITHUB_* / RUNNER_* path;
//   - startup hooks that run code from outside the app: BASH_ENV, ENV, exported bash functions,
//     PROMPT_COMMAND, SHELLOPTS/BASHOPTS, LD_*/DYLD_* loader vars, npm's node-options/script-shell/
//     onload-script/config-file redirects.
// PATH keeps only system dirs, the hosted tool cache and the dir of the node running the harness;
// NODE_OPTIONS keeps only flags that load no code.
const AWS_NON_CREDENTIAL = new Set(['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_BLOCKS_DISABLE_TELEMETRY']);
const HARD_CREDENTIAL_EXACT = new Set([
	'GITHUB_TOKEN',
	'GH_TOKEN',
	'GH_ENTERPRISE_TOKEN',
	'GITHUB_ENTERPRISE_TOKEN',
	'NPM_TOKEN',
	'NODE_AUTH_TOKEN',
]);
const SECRET_NAME_RE = /TOKEN|SECRET|PASSW|KEY|CREDENTIAL|_AUTH|^AUTH/i;
const RUNNER_PLUMBING_RE = /^(GITHUB_(?!ACTIONS$)|RUNNER_(?!(OS|ARCH)$))/i;
const STARTUP_HOOK_RE =
	/^(BASH_ENV|ENV|BASH_FUNC_.*|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|LD_.*|DYLD_.*|npm_config_(node_options|script_shell|onload_script|userconfig|globalconfig|init_module))$/i;
const SAFE_PATH_DIRS = new Set(['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/snap/bin']);
const SAFE_PATH_PREFIXES = ['/opt/hostedtoolcache/'];
// NODE_OPTIONS flags that only tune the runtime (no --require/--import/--loader/--env-file…).
const SAFE_NODE_OPTION_RE =
	/^--(max-old-space-size|max-semi-space-size|stack-size|max-http-header-size)=\d+$|^--(no-warnings|enable-source-maps|no-deprecation|trace-warnings)$/;

/** True for the hard credential families (never forwarded, by any route). */
export function isHardCredentialName(name) {
	const n = String(name).toUpperCase();
	if (n.startsWith('AWS_')) return !AWS_NON_CREDENTIAL.has(n);
	return n.startsWith('ACTIONS_') || HARD_CREDENTIAL_EXACT.has(n);
}

/** True for any credential-family or credential-shaped name (the redactor's exact-value source). */
export function isCredentialName(name) {
	return isHardCredentialName(name) || SECRET_NAME_RE.test(String(name));
}

function isDeniedName(name) {
	if (AWS_NON_CREDENTIAL.has(name)) return false;
	return isCredentialName(name) || RUNNER_PLUMBING_RE.test(name) || STARTUP_HOOK_RE.test(name);
}

function isAllowedName(name) {
	return ALLOW_EXACT.has(name) || ALLOW_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * PATH reduced to the safe dirs (order kept; /usr/local/bin:/usr/bin:/bin when none survive), with
 * the dir of the node running the harness appended if missing, so the agent's `node`/`npm` are the
 * harness's own.
 */
export function sanitizePath(value) {
	const nodeDir = dirname(process.execPath);
	const kept = String(value)
		.split(':')
		.filter((d) => isAbsolute(d) && normalize(d) === d && !d.includes('..'))
		.filter((d) => SAFE_PATH_DIRS.has(d) || d === nodeDir || SAFE_PATH_PREFIXES.some((p) => d.startsWith(p)));
	const dirs = kept.length ? [...new Set(kept)] : ['/usr/local/bin', '/usr/bin', '/bin'];
	if (!dirs.includes(nodeDir)) dirs.push(nodeDir);
	return dirs.join(':');
}

/** NODE_OPTIONS reduced to code-free runtime flags; undefined when nothing safe remains. */
export function sanitizeNodeOptions(value) {
	const kept = String(value)
		.split(/\s+/)
		.filter((t) => SAFE_NODE_OPTION_RE.test(t));
	return kept.length ? kept.join(' ') : undefined;
}

/**
 * The env for a process that runs agent-controlled code: the allowlisted subset of `base` plus the
 * caller's per-command `overrides`, minus every denied name (credentials, runner plumbing, startup
 * hooks), with PATH and NODE_OPTIONS sanitized. Overrides go through the same filter, so they can add
 * app settings (BLOCKS_URL, RUN_ID, …) but never reintroduce anything denied. Pure.
 * @param {Record<string, string | undefined>} base usually process.env
 * @param {{overrides?: Record<string, string | undefined>}} [options]
 * @returns {Record<string, string>}
 */
export function buildShellEnv(base, options = {}) {
	/** @type {Record<string, string>} */
	const out = {};
	const put = (k, v) => {
		if (typeof v !== 'string' || isDeniedName(k)) return;
		if (k === 'PATH') out[k] = sanitizePath(v);
		else if (k === 'NODE_OPTIONS') {
			const safe = sanitizeNodeOptions(v);
			if (safe) out[k] = safe;
			else delete out[k];
		} else out[k] = v;
	};
	for (const [k, v] of Object.entries(base)) if (isAllowedName(k)) put(k, v);
	for (const [k, v] of Object.entries(options.overrides ?? {})) put(k, v);
	return out;
}

// ── Redaction ────────────────────────────────────────────────────────────────────────────────
// Best-effort: exact values of the credential vars in the harness env, plus well-known token
// formats. It cannot catch a secret that was transformed (encoded, split, reversed) on the way out.
const REDACTED = '***REDACTED***';
// Values shorter than this are not credentials (flags, regions, profile names) and would over-redact.
const MIN_EXACT_VALUE_LEN = 12;

// High-confidence token formats: safe to apply to source files as well as logs.
const TOKEN_PATTERNS = [
	// AWS access key ids (long-term AKIA, temporary ASIA, and the bearer/context-specific forms).
	[/\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, '***REDACTED-AWS-KEY-ID***'],
	// STS session tokens (the base64 prefixes STS issues).
	[/\b(?:IQoJb3JpZ2lu|FwoGZXIvYXdz|FQoGZXIvYXdz)[A-Za-z0-9/+=]+/g, '***REDACTED-AWS-SESSION-TOKEN***'],
	// JWTs, e.g. a GitHub OIDC token.
	[/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***REDACTED-JWT***'],
	// GitHub tokens (ghp_/gho_/ghs_/ghu_/ghr_, fine-grained github_pat_) and npm tokens.
	[/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, '***REDACTED-GH-TOKEN***'],
	[/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '***REDACTED-GH-TOKEN***'],
	[/\bnpm_[A-Za-z0-9]{36}\b/g, '***REDACTED-NPM-TOKEN***'],
	// PEM private keys (any algorithm label).
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***REDACTED-PRIVATE-KEY***'],
];
// Credential-named assignments (`NAME=value`, `name: value`, `"Name": "value"`): catches secrets
// with no recognizable format, e.g. an AWS secret access key printed by `env` or `aws configure
// export-credentials`. Log text only: in source code it would also hit `API_KEY = process.env.X`.
const ASSIGNMENT_PATTERNS = [
	// AWS key material in env, ini and JSON spellings (aws_secret_access_key, SecretAccessKey, …).
	[
		/\b((?:[A-Za-z0-9]+_)*(?:secret_?access_?key|session_?token|security_?token|access_?key_?id)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
		`$1${REDACTED}`,
	],
	// Any UPPER_SNAKE env-style name that looks like a credential (GITHUB_TOKEN=, NPM_TOKEN=, X_SECRET=).
	[
		/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|ACCESS_KEY|PRIVATE_KEY|API_KEY)[A-Z0-9_]*["']?\s*[:=]\s*["']?)[^\s"',;]+/g,
		`$1${REDACTED}`,
	],
];

/**
 * Exact values of the credential vars in `env` (deduped, longest first so a value containing another
 * is replaced whole). Pure.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function credentialValues(env) {
	const values = new Set();
	for (const [k, v] of Object.entries(env)) {
		if (typeof v === 'string' && v.length >= MIN_EXACT_VALUE_LEN && isCredentialName(k)) values.add(v);
	}
	return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Build a redactor over `values` (exact strings to scrub) plus the token formats. `assignments`
 * (default true) also scrubs credential-named `NAME=value` pairs — turn it off for source files.
 * @param {string[]} values
 * @param {{assignments?: boolean}} [options]
 * @returns {(text: unknown) => string} non-string input → ''
 */
export function createRedactor(values, options = {}) {
	const patterns = options.assignments === false ? TOKEN_PATTERNS : [...TOKEN_PATTERNS, ...ASSIGNMENT_PATTERNS];
	return (text) => {
		if (typeof text !== 'string') return '';
		let out = text;
		for (const v of values) if (out.includes(v)) out = out.split(v).join(REDACTED);
		for (const [re, replacement] of patterns) out = out.replace(re, replacement);
		return out;
	};
}

// Default redactor over THIS process's credential values, built on first use (the job's creds are in
// the env from process start).
let defaultRedactor;
/**
 * Scrub credential material from free text before it is written to an uploaded file or put into a
 * model prompt. Non-string input → ''.
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
	defaultRedactor ??= createRedactor(credentialValues(process.env));
	return defaultRedactor(text);
}

// JSON property names whose STRING values are credentials whatever their format (an AWS secret
// access key or a non-prefixed session token has none). Numbers are kept, so usage/scoring fields
// like `tokens_in` or `inputTokens` survive.
const CREDENTIAL_KEY_RE = /secret|passw|credential|private_?key|api_?key|access_?key|token|authorization|cookie/i;

/**
 * Deep-redact a JSON-like value, so serialized JSON stays valid: every string value and key goes
 * through `redact`, and a string under a credential-named property is replaced outright. Own
 * `__proto__` properties are preserved as data.
 * @template T
 * @param {T} value
 * @param {(text: string) => string} [redact]
 * @param {string} [key] the property name `value` sits under (internal)
 * @returns {T}
 */
export function redactDeep(value, redact = redactSecrets, key = undefined) {
	if (typeof value === 'string') {
		if (key !== undefined && value !== '' && CREDENTIAL_KEY_RE.test(key)) return /** @type {T} */ (REDACTED);
		return /** @type {T} */ (redact(value));
	}
	if (Array.isArray(value)) return /** @type {T} */ (value.map((v) => redactDeep(v, redact, key)));
	if (value && typeof value === 'object') {
		const entries = Object.entries(value).map(([k, v]) => [redact(k), redactDeep(v, redact, k)]);
		return /** @type {T} */ (Object.fromEntries(entries));
	}
	return value;
}

/**
 * `JSON.stringify(value, null, 2)` with every string redacted. Round-trips through JSON first so
 * class instances serialize via their own toJSON() exactly as a plain stringify would.
 * @param {unknown} value
 * @returns {string}
 */
export function stringifyRedacted(value) {
	const plain = JSON.parse(JSON.stringify(value ?? null));
	return JSON.stringify(redactDeep(plain), null, 2);
}
