// Unit tests for lib/secrets.mjs: the env policy for every agent-controlled process and the
// redaction applied to everything published or sent to a model. Run under bare `node --test`. Every
// credential-shaped fake is assembled at runtime so no literal here looks like a real key to a
// secret scanner.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { describe, it } from 'node:test';
import {
	buildShellEnv,
	createRedactor,
	credentialValues,
	isCredentialField,
	isCredentialName,
	redactDeep,
	redactSecrets,
	stringifyRedacted,
} from './secrets.mjs';

// The credential env a bench job actually carries (fake values): configure-aws-credentials' STS
// session, the OIDC token-request pair (id-token: write), runner service tokens, GitHub/npm tokens.
const FAKE_CREDENTIAL_ENV = {
	AWS_ACCESS_KEY_ID: `ASIA${'Q'.repeat(16)}`,
	AWS_SECRET_ACCESS_KEY: `fakeSecret/${'s'.repeat(29)}`,
	AWS_SESSION_TOKEN: `IQoJb3JpZ2luX2Vj${'t'.repeat(60)}`,
	AWS_SECURITY_TOKEN: `legacy-security-${'t'.repeat(20)}`,
	AWS_PROFILE: 'bench-profile',
	AWS_ROLE_ARN: 'arn:aws:iam::000000000000:role/fake-bench-role',
	AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/fake-web-identity-token',
	AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://127.0.0.1:9/fake-creds',
	AWS_CONTAINER_AUTHORIZATION_TOKEN: `fake-container-auth-${'c'.repeat(20)}`,
	AWS_SHARED_CREDENTIALS_FILE: '/tmp/fake-aws-credentials',
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: `fake-oidc-request-${'r'.repeat(30)}`,
	ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fake-oidc.invalid/token?x=fakeoidcurlvalue',
	ACTIONS_RUNTIME_TOKEN: `fake-runtime-${'u'.repeat(30)}`,
	ACTIONS_RUNTIME_URL: 'https://fake-runtime.invalid/',
	ACTIONS_CACHE_URL: 'https://fake-cache.invalid/',
	GITHUB_TOKEN: `ghs_${'g'.repeat(36)}`,
	GH_TOKEN: `ghp_${'h'.repeat(36)}`,
	NPM_TOKEN: `npm_${'n'.repeat(36)}`,
	NODE_AUTH_TOKEN: `fake-node-auth-${'a'.repeat(20)}`,
	SOME_SERVICE_PASSWORD: `fake-password-${'p'.repeat(20)}`,
	MY_SIGNING_KEY: `fake-signing-key-${'k'.repeat(20)}`,
	DEPLOY_SECRET: `fake-deploy-secret-${'d'.repeat(20)}`,
	npm_config__authtoken: `fake-npmrc-token-${'z'.repeat(20)}`,
};

// What builds, installs, browsers and tests need (all must survive the scrub). PATH already holds
// only safe dirs (system + the node running this test), so it survives unchanged.
const REQUIRED_ENV = {
	PATH: [...new Set(['/usr/local/bin', '/usr/bin', '/bin', dirname(process.execPath)])].join(':'),
	HOME: '/home/runner',
	USER: 'runner',
	LANG: 'C.UTF-8',
	LC_ALL: 'C.UTF-8',
	TERM: 'xterm',
	TMPDIR: '/tmp',
	CI: 'true',
	GITHUB_ACTIONS: 'true',
	RUNNER_OS: 'Linux',
	HTTPS_PROXY: 'http://proxy.invalid:3128',
	no_proxy: 'localhost',
	NODE_OPTIONS: '--max-old-space-size=4096',
	NPM_CONFIG_FETCH_RETRIES: '5',
	npm_config_cache: '/home/runner/.npm',
	PLAYWRIGHT_BROWSERS_PATH: '/work/.pw-browsers',
	BLOCKS_MOCK: 'true',
	AWS_REGION: 'us-east-1',
	AWS_DEFAULT_REGION: 'us-east-1',
	WORKSPACE: '/work/bench-app',
};

// Present in the job env but not needed by the shell (dropped by the allowlist, not credentials).
const HARNESS_ONLY_ENV = {
	GITHUB_ENV: '/home/runner/work/_temp/_runner_file_commands/set_env_x',
	GITHUB_OUTPUT: '/home/runner/work/_temp/_runner_file_commands/set_output_x',
	GITHUB_REPOSITORY: 'owner/repo',
	RUNNER_TEMP: '/home/runner/work/_temp',
	BENCH_MODEL: 'some-model',
	BENCH_CMD_LOG: '/tmp/commands.jsonl',
	BASH_ENV: '/tmp/evil.sh',
};

const JOB_ENV = { ...FAKE_CREDENTIAL_ENV, ...REQUIRED_ENV, ...HARNESS_ONLY_ENV };

describe('buildShellEnv (agent/judge shell env policy)', () => {
	it('drops every credential family and keeps what builds/tests need', () => {
		const env = buildShellEnv(JOB_ENV);
		for (const name of Object.keys(FAKE_CREDENTIAL_ENV)) assert.equal(name in env, false, `${name} must be stripped`);
		for (const [name, value] of Object.entries(REQUIRED_ENV)) assert.equal(env[name], value, `${name} must survive`);
		for (const name of Object.keys(HARNESS_ONLY_ENV)) assert.equal(name in env, false, `${name} is not allowlisted`);
	});

	it('per-command overrides add app settings but can never reintroduce anything denied', () => {
		const env = buildShellEnv(REQUIRED_ENV, {
			overrides: {
				RUN_ID: 'r1',
				BLOCKS_URL: 'http://localhost:3000',
				// hard credential families + credential-shaped names
				AWS_SESSION_TOKEN: 'x'.repeat(20),
				aws_secret_access_key: 'x'.repeat(20),
				ACTIONS_ID_TOKEN_REQUEST_URL: 'u',
				API_TOKEN: 'y',
				GITHUB_TOKEN: 'z',
				// runner file commands + temp (later-step env/PATH injection)
				GITHUB_ENV: '/r/set_env_x',
				GITHUB_OUTPUT: '/r/set_output_x',
				GITHUB_PATH: '/r/add_path_x',
				GITHUB_STATE: '/r/save_state_x',
				GITHUB_STEP_SUMMARY: '/r/step_summary_x',
				RUNNER_TEMP: '/r',
				// startup hooks that run code from outside the app
				BASH_ENV: '/tmp/evil.sh',
				ENV: '/tmp/evil.sh',
				'BASH_FUNC_cd%%': '() { evil; }',
				PROMPT_COMMAND: 'evil',
				LD_PRELOAD: '/tmp/evil.so',
				npm_config_node_options: '--require /tmp/evil.cjs',
				npm_config_script_shell: '/tmp/evil.sh',
			},
		});
		assert.equal(env.RUN_ID, 'r1');
		assert.equal(env.BLOCKS_URL, 'http://localhost:3000');
		const leaked = Object.keys(env).filter((k) => !(k in REQUIRED_ENV) && !['RUN_ID', 'BLOCKS_URL'].includes(k));
		assert.deepEqual(leaked, []);
	});

	it('PATH keeps only system dirs and the harness node dir — from base or override', () => {
		const nodeDir = dirname(process.execPath);
		const evil = ['/tmp/evil-bin', '/home/runner/work/x/node_modules/.bin', 'relative/bin', '/usr/bin/../../tmp', '/opt/hostedtoolcache/Python/3/bin'];
		const path = ['/usr/local/bin', ...evil, nodeDir, '/usr/bin', '/bin'].join(':');
		const expected = ['/usr/local/bin', nodeDir, '/usr/bin', '/bin'];
		assert.deepEqual(buildShellEnv({ PATH: path }).PATH.split(':'), [...new Set(expected)]);
		// Nothing safe left → system dirs + the harness node dir (never the evil entry).
		const fallback = buildShellEnv({}, { overrides: { PATH: '/tmp/evil-bin' } }).PATH.split(':');
		assert.deepEqual(fallback, [...new Set(['/usr/local/bin', '/usr/bin', '/bin', nodeDir])]);
	});

	it('NODE_OPTIONS keeps runtime-tuning flags and drops anything that loads code', () => {
		assert.equal(buildShellEnv({ NODE_OPTIONS: '--max-old-space-size=4096 --no-warnings' }).NODE_OPTIONS, '--max-old-space-size=4096 --no-warnings');
		for (const hook of ['--require /tmp/x.cjs', '-r /tmp/x.cjs', '--import=/tmp/x.mjs', '--loader /tmp/x.mjs', '--env-file=/tmp/e']) {
			assert.equal('NODE_OPTIONS' in buildShellEnv({ NODE_OPTIONS: hook }), false, hook);
			assert.equal('NODE_OPTIONS' in buildShellEnv({}, { overrides: { NODE_OPTIONS: hook } }), false, hook);
		}
		assert.equal(buildShellEnv({ NODE_OPTIONS: '--max-old-space-size=1 --require /tmp/x.cjs' }).NODE_OPTIONS, '--max-old-space-size=1');
	});

	it('keeps the framework telemetry opt-out (a non-credential AWS_* flag)', () => {
		const env = buildShellEnv({ ...JOB_ENV, AWS_BLOCKS_DISABLE_TELEMETRY: '1' });
		assert.equal(env.AWS_BLOCKS_DISABLE_TELEMETRY, '1');
		assert.equal(isCredentialName('AWS_BLOCKS_DISABLE_TELEMETRY'), false);
	});

	it('never forwards undefined values', () => {
		assert.deepEqual(buildShellEnv({ PATH: undefined, HOME: '/h' }), { HOME: '/h' });
	});

	it('classifies the credential families by name', () => {
		for (const n of Object.keys(FAKE_CREDENTIAL_ENV)) assert.equal(isCredentialName(n), true, n);
		for (const n of ['PATH', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'PLAYWRIGHT_BROWSERS_PATH']) {
			assert.equal(isCredentialName(n), false, n);
		}
	});
});

describe('redaction', () => {
	const redact = createRedactor(credentialValues(JOB_ENV));

	it('scrubs the exact value of every stripped credential var, in any context', () => {
		for (const [name, value] of Object.entries(FAKE_CREDENTIAL_ENV)) {
			if (value.length < 12) continue; // below the exact-match floor by design (not a secret)
			const out = redact(`prefix ${value} suffix`);
			assert.equal(out.includes(value), false, `${name} value leaked: ${out}`);
		}
	});

	it('does not treat short or non-credential values as secrets', () => {
		const values = credentialValues({ AWS_REGION: 'us-east-1-long-region', AWS_PROFILE: 'default', CI: 'true' });
		assert.deepEqual(values, []);
	});

	// Format-based patterns: no exact value known (e.g. a key from another source).
	const redactPatterns = createRedactor([]);
	const formats = {
		'AWS access key id (AKIA)': `AKIA${'A1'.repeat(8)}`,
		'AWS temporary key id (ASIA)': `ASIA${'B2'.repeat(8)}`,
		'STS session token': `IQoJb3JpZ2luX2VjE${'Xy9+'.repeat(40)}`,
		'JWT / GitHub OIDC token': `eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwczovL3Rva2VuIn0.${'sig_-'.repeat(10)}`,
		'GitHub token (ghp_)': `ghp_${'a1'.repeat(18)}`,
		'GitHub token (ghs_)': `ghs_${'b2'.repeat(18)}`,
		'GitHub fine-grained PAT': `github_pat_${'c3'.repeat(20)}`,
		'npm token': `npm_${'d4'.repeat(18)}`,
	};
	for (const [label, token] of Object.entries(formats)) {
		it(`scrubs a bare ${label}`, () => {
			const out = redactPatterns(`seen ${token} here`);
			assert.equal(out.includes(token), false, out);
			assert.match(out, /REDACTED/);
		});
	}

	it('scrubs credential-named assignments in env, ini and JSON spellings (secret access keys have no format)', () => {
		const secret = `wJalrXUtnFEMI/${'K7MDENG'.repeat(3)}x`;
		const samples = [
			`AWS_SECRET_ACCESS_KEY=${secret}`,
			`aws_secret_access_key = ${secret}`,
			`"SecretAccessKey": "${secret}",`,
			`"sessionToken":"${secret}"`,
			`GITHUB_TOKEN=${secret}`,
			`MY_API_KEY: ${secret}`,
		];
		for (const s of samples) {
			const out = redactPatterns(s);
			assert.equal(out.includes(secret), false, `leaked in: ${out}`);
		}
		assert.equal(redactPatterns(`AWS_SECRET_ACCESS_KEY=${secret}`), 'AWS_SECRET_ACCESS_KEY=***REDACTED***');
	});

	it('leaves ordinary build/log text untouched (git SHAs, paths, integrity hashes, JS errors)', () => {
		const clean = [
			'build failed: cannot find module ./foo at line 42',
			`commit ${'0123456789abcdef'.repeat(2)}01234567`,
			'/home/runner/work/aws-blocks/aws-blocks/bench-app/src/components/ChatPanel.tsx',
			`"integrity": "sha512-${'Ab0+'.repeat(22)}=="`,
			"SyntaxError: Unexpected token '<'",
		].join('\n');
		assert.equal(redactPatterns(clean), clean);
	});

	it('source mode (assignments off) keeps code like `API_KEY = process.env.X` but still scrubs tokens', () => {
		const redactSource = createRedactor([FAKE_CREDENTIAL_ENV.AWS_SECRET_ACCESS_KEY], { assignments: false });
		const code = 'const API_KEY = process.env.X;';
		assert.equal(redactSource(code), code);
		const leaked = `const k = '${FAKE_CREDENTIAL_ENV.AWS_SECRET_ACCESS_KEY}'; // ${FAKE_CREDENTIAL_ENV.GITHUB_TOKEN}`;
		const out = redactSource(leaked);
		assert.equal(out.includes(FAKE_CREDENTIAL_ENV.AWS_SECRET_ACCESS_KEY), false);
		assert.equal(out.includes(FAKE_CREDENTIAL_ENV.GITHUB_TOKEN), false);
	});

	it('is non-string-safe (returns empty string)', () => {
		assert.equal(redactSecrets(null), '');
		assert.equal(redactSecrets(undefined), '');
		assert.equal(redactSecrets(42), '');
	});

	it('redactDeep scrubs keys and values and keeps the JSON valid', () => {
		const token = FAKE_CREDENTIAL_ENV.GITHUB_TOKEN;
		const value = { a: [`x ${token}`, 1, null, { [token]: true }], b: 'AWS_SESSION_TOKEN="abc,def"' };
		const json = JSON.stringify(redactDeep(value, redactPatterns));
		assert.equal(json.includes(token), false);
		const parsed = JSON.parse(json);
		assert.equal(parsed.a[1], 1);
		assert.equal(parsed.a[2], null);
		assert.equal(parsed.b.includes('abc'), false);
	});

	it('stringifyRedacted serializes class instances via toJSON exactly as JSON.stringify would', () => {
		class Metrics {
			secret = FAKE_CREDENTIAL_ENV.GITHUB_TOKEN;
			toJSON() {
				return { cycles: 3, note: `token ${this.secret}` };
			}
		}
		const out = JSON.parse(stringifyRedacted({ m: new Metrics() }));
		assert.equal(out.m.cycles, 3);
		assert.match(out.m.note, /^token \*\*\*REDACTED-GH-TOKEN\*\*\*$/);
	});

	it('redactDeep replaces credential-named string fields whatever their format, keeping numeric usage fields', () => {
		const unknownSecret = `unknown${'s'.repeat(33)}`; // no format, no exact value known
		const otherSts = `OtherSTSa/+=${'t'.repeat(40)}`; // not one of the STS prefixes
		const value = {
			Credentials: { AccessKeyId: 'not-a-key-id', SecretAccessKey: unknownSecret, SessionToken: otherSts },
			API_TOKEN: 'short123',
			headers: { authorization: 'Bearer abc', Cookie: 'sid=1' },
			list: { privateKey: ['k1', 'k2'] },
			tokens_in: 1200,
			usage: { inputTokens: 10, cacheReadInputTokens: 3 },
			stop_reason: 'max_tokens',
			emptyToken: '',
		};
		const out = redactDeep(value, redactPatterns);
		const json = JSON.stringify(out);
		for (const s of [unknownSecret, otherSts, 'short123', 'Bearer abc', 'sid=1', 'k1']) assert.equal(json.includes(s), false, s);
		assert.equal(out.tokens_in, 1200);
		assert.deepEqual(out.usage, { inputTokens: 10, cacheReadInputTokens: 3 });
		assert.equal(out.stop_reason, 'max_tokens');
		assert.equal(out.emptyToken, '');
	});

	it('credential field names are exact names, not substrings found in package names or scripts', () => {
		for (const k of ['SecretAccessKey', 'secret_access_key', 'aws_secret_access_key', 'SessionToken', 'AccessKeyId', 'password', 'apiKey', 'api_key', 'x-api-key', 'authorization', 'client_secret', 'access_token', 'refreshToken', 'privateKey', 'Cookie', 'API_TOKEN', 'GITHUB_TOKEN', 'DEPLOY_SECRET']) {
			assert.equal(isCredentialField(k), true, k);
		}
		for (const k of [
			'secret',
			'token',
			'tokens_in',
			'judge_tokens_out',
			'inputTokens',
			'node_modules/@aws-sdk/credential-provider-ini',
			'@aws-sdk/credential-providers',
			'@aws-sdk/token-providers',
			'@aws-amplify/backend-secret',
			'js-cookie',
			'keytar',
			'stop_reason',
		]) {
			assert.equal(isCredentialField(k), false, k);
		}
	});

	it('redactDeep with keyAware:false redacts by value only (agent-written JSON)', () => {
		const value = { scripts: { secret: 'tsx aws-blocks/scripts/secret.ts' }, password: 'not-a-known-value', note: `x ${FAKE_CREDENTIAL_ENV.GITHUB_TOKEN}` };
		const out = redactDeep(value, redactPatterns, { keyAware: false });
		assert.equal(out.scripts.secret, 'tsx aws-blocks/scripts/secret.ts');
		assert.equal(out.password, 'not-a-known-value');
		assert.equal(out.note, 'x ***REDACTED-GH-TOKEN***');
	});

	it('redactDeep keeps an own `__proto__` property as data (no prototype setter, no data loss)', () => {
		const parsed = JSON.parse('{"__proto__":{"n":1},"score":42}');
		const out = redactDeep(parsed, redactPatterns);
		assert.equal(Object.hasOwn(out, '__proto__'), true);
		assert.equal(Object.getPrototypeOf(out), Object.prototype);
		assert.equal(JSON.stringify(out), '{"__proto__":{"n":1},"score":42}');
	});

	it('scrubs a PEM private key of any label, single- or multi-line', () => {
		const pem = `-----BEGIN ${'EC '}PRIVATE KEY-----\n${'QUJD'.repeat(16)}\n-----END EC PRIVATE KEY-----`;
		const out = redactPatterns(`key:\n${pem}\nafter`);
		assert.equal(out.includes('QUJD'), false);
		assert.match(out, /^key:\n\*\*\*REDACTED-PRIVATE-KEY\*\*\*\nafter$/);
	});
});
