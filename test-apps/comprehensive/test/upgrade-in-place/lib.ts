// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic of the upgrade-in-place harness (`../upgrade-in-place.ts`).
 *
 * Nothing in this module touches AWS, the network, the file system or a child
 * process, so all of it is unit-tested offline (`lib.test.ts`) against recorded
 * fixtures. The harness entry point does the I/O and calls into here for every
 * decision: argument and env handling, the real-mode opt-in gate, the template
 * continuity comparator, the `cdk diff` replacement parser, the stack-event
 * parser that surfaces the `UpdateUserPool` failure, and the post-upgrade
 * identity comparison.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The env var that must be exactly `'1'` before the harness touches AWS. */
export const OPT_IN_ENV = 'BLOCKS_UPGRADE_E2E';

/** Every stack this harness deploys is `bb-test-<suffix>`; the suffix must start with `upgrade-`. */
export const STACK_NAME_PREFIX = 'bb-test-';

/**
 * Dedicated suffix shape. The `upgrade-` lead keeps the stack name disjoint from
 * every other e2e stack (`bb-test-prod-…`, `bb-test-<user>-<id>…`), so this
 * harness can never deploy into — or destroy — another suite's stack. Kept short
 * because the block's `fullId` (and so the user pool name) embeds the stack name,
 * and Cognito caps pool names at 128 characters.
 */
export const SUFFIX_PATTERN = /^upgrade-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** The backend scope id and the auth block id in the fixture app — identical in both revisions. */
export const SCOPE_ID = 'upgrade';
export const AUTH_BLOCK_ID = 'auth';

/** The auth block's construct path below the stack (`<stack>/<scope>/<block>/…`). */
export const AUTH_BLOCK_PATH = `${SCOPE_ID}/${AUTH_BLOCK_ID}`;

/**
 * Default pre-refactor revision: the last release that ships `AuthCognito`,
 * which is what existing `AuthCognito` deployments run. A tag, not a branch:
 * after the cutover `main` has no `bb-auth-cognito`, so a branch default would
 * stop pointing at an `AuthCognito` revision. If a later `bb-auth-cognito`
 * patch is released before the cutover, move this to its tag. Override with
 * `--base-ref` / `BLOCKS_UPGRADE_BASE_REF`.
 */
export const DEFAULT_BASE_REF = '@aws-blocks/bb-auth-cognito@0.2.0';

/** The package the BEFORE app imports; the base revision must contain it. */
export const LEGACY_PACKAGE_NAME = '@aws-blocks/bb-auth-cognito';

/** Repo-relative directory of {@link LEGACY_PACKAGE_NAME} in the base revision. */
export const LEGACY_PACKAGE_DIR = 'packages/bb-auth-cognito';

/**
 * The resource type of `Auth`'s deploy-time immutability guard. `Auth`
 * synthesizes one whenever it owns a user pool; `AuthCognito` never did. Its
 * presence or absence is how the harness tells the two templates apart.
 */
export const AUTH_POOL_GUARD_TYPE = 'Custom::BlocksAuthPoolGuard';

/** Suffix used by the dry-run (it never deploys, so it needs no uniqueness). */
export const DRY_RUN_SUFFIX = 'upgrade-dryrun';

// ─────────────────────────────────────────────────────────────────────────────
// Arguments and environment
// ─────────────────────────────────────────────────────────────────────────────

export type HarnessMode = 'dry-run' | 'real';

export interface HarnessOptions {
	mode: HarnessMode;
	/** `BLOCKS_STACK_SUFFIX` for both deploys. */
	suffix: string;
	/** Git ref of the pre-refactor revision (the `AuthCognito` app). */
	baseRef: string;
	/** An existing, installed checkout of the pre-refactor revision. When set, no worktree is created. */
	baseDir?: string;
	/** Keep the base worktree the harness created (it is removed by default). */
	keepBase: boolean;
	/**
	 * Run `npm run build` in this checkout and in a `--base-dir` checkout.
	 * `--no-build` skips both; a base worktree the harness creates is always built.
	 */
	build: boolean;
	/**
	 * Skip the checks that need the new block's runtime (`requireAuth` on the
	 * pre-upgrade cookie, a fresh `signIn` through the app). For running the
	 * CloudFormation half before the runtime layers land; the verdict is then
	 * `PARTIAL`, never `PASS`.
	 */
	skipRuntimeChecks: boolean;
	help: boolean;
}

/** A user-facing argument or environment error. The harness prints `message` and exits 2. */
export class UsageError extends Error {
	override name = 'UsageError';
}

export const USAGE = `Usage: npx tsx test/upgrade-in-place.ts [options]      (from test-apps/comprehensive)

Modes:
  --dry-run              Offline: build + synth both revisions under --conditions=cdk and compare
                         the templates. Never touches AWS. (env: BLOCKS_UPGRADE_DRY_RUN=1)
  (default)              Real: deploy AuthCognito, seed, upgrade in place to Auth, assert, destroy.
                         Refuses to run unless ${OPT_IN_ENV}=1, AWS_REGION and AWS credentials are set.

Options:
  --suffix <upgrade-…>   BLOCKS_STACK_SUFFIX for both deploys; stack is bb-test-<suffix>.
                         (env: BLOCKS_STACK_SUFFIX; default: upgrade-<run id>)
  --base-ref <ref>       Pre-refactor git ref; must contain ${LEGACY_PACKAGE_DIR}
                         (env: BLOCKS_UPGRADE_BASE_REF; default: ${DEFAULT_BASE_REF})
  --base-dir <path>      Use an existing installed checkout of the base revision instead of
                         creating a worktree (env: BLOCKS_UPGRADE_BASE_DIR)
  --keep-base            Keep the base worktree the harness created
  --no-build             Do not run \`npm run build\` here or in --base-dir (a worktree the
                         harness creates is always built)
  --skip-runtime-checks  Real mode: skip the checks that need Auth's runtime; verdict is PARTIAL
  --help                 Show this help`;

/** Flags that take a value. */
const VALUE_FLAGS = new Set(['--suffix', '--base-ref', '--base-dir']);

/**
 * Parse the harness's command line and environment. Flags win over env vars.
 *
 * @param now - Clock for the generated default suffix (injected for tests).
 * @throws {UsageError} on an unknown flag, a missing value or an invalid suffix.
 */
export function parseHarnessArgs(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	now: () => number = Date.now,
): HarnessOptions {
	const values = new Map<string, string>();
	const switches = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const eq = arg.indexOf('=');
		const flag = eq > 0 ? arg.slice(0, eq) : arg;
		if (VALUE_FLAGS.has(flag)) {
			const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
			if (value === undefined || value === '' || value.startsWith('--')) {
				throw new UsageError(`${flag} needs a value.`);
			}
			values.set(flag, value);
			continue;
		}
		if (['--dry-run', '--keep-base', '--no-build', '--skip-runtime-checks', '--help', '-h'].includes(arg)) {
			switches.add(arg === '-h' ? '--help' : arg);
			continue;
		}
		throw new UsageError(`Unknown argument '${arg}'.`);
	}

	const mode: HarnessMode = switches.has('--dry-run') || env.BLOCKS_UPGRADE_DRY_RUN === '1' ? 'dry-run' : 'real';
	const suffix =
		values.get('--suffix') ??
		nonEmpty(env.BLOCKS_STACK_SUFFIX) ??
		(mode === 'dry-run' ? DRY_RUN_SUFFIX : defaultSuffix(env, now));
	if (!SUFFIX_PATTERN.test(suffix)) {
		throw new UsageError(
			`Stack suffix '${suffix}' is not a dedicated upgrade suffix. It must match ${SUFFIX_PATTERN} ` +
				"(lowercase, starting with 'upgrade-', at most 48 characters) so this harness can only ever " +
				'deploy and destroy its own stack. Set it with --suffix or BLOCKS_STACK_SUFFIX.',
		);
	}
	const baseDir = values.get('--base-dir') ?? nonEmpty(env.BLOCKS_UPGRADE_BASE_DIR);
	return {
		mode,
		suffix,
		baseRef: values.get('--base-ref') ?? nonEmpty(env.BLOCKS_UPGRADE_BASE_REF) ?? DEFAULT_BASE_REF,
		...(baseDir ? { baseDir } : {}),
		keepBase: switches.has('--keep-base'),
		build: !switches.has('--no-build'),
		skipRuntimeChecks: switches.has('--skip-runtime-checks'),
		help: switches.has('--help'),
	};
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/** `upgrade-<github run id>-<attempt>` in CI, else `upgrade-<base36 timestamp>`. */
function defaultSuffix(env: Readonly<Record<string, string | undefined>>, now: () => number): string {
	if (env.GITHUB_RUN_ID) return `upgrade-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`;
	return `upgrade-${now().toString(36)}`;
}

/** The CloudFormation stack name for a suffix. Must match `app/aws-blocks/index.cdk.ts`. */
export function stackNameFor(suffix: string): string {
	return `${STACK_NAME_PREFIX}${suffix}`;
}

/**
 * Why the real (AWS-touching) mode must not run, or `null` when it may.
 *
 * Requires the explicit opt-in, a region, and an explicit credential source in
 * the environment — an ambient `~/.aws/credentials` default profile alone is not
 * enough (set `AWS_PROFILE=default` to use it on purpose). The harness then also
 * probes STS before doing anything else.
 */
export function realModeRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
	if (env[OPT_IN_ENV] !== '1') {
		return (
			`Refusing to deploy: set ${OPT_IN_ENV}=1 to run the upgrade-in-place e2e against AWS ` +
			'(two deploys and a destroy, ~5–8 minutes). Use --dry-run for the offline check.'
		);
	}
	if (!nonEmpty(env.AWS_REGION) && !nonEmpty(env.AWS_DEFAULT_REGION)) {
		return 'Refusing to deploy: set AWS_REGION so the stack lands in a region you chose.';
	}
	const hasStaticKeys = Boolean(nonEmpty(env.AWS_ACCESS_KEY_ID) && nonEmpty(env.AWS_SECRET_ACCESS_KEY));
	const hasSource =
		hasStaticKeys ||
		Boolean(nonEmpty(env.AWS_PROFILE)) ||
		Boolean(nonEmpty(env.AWS_WEB_IDENTITY_TOKEN_FILE)) ||
		Boolean(nonEmpty(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)) ||
		Boolean(nonEmpty(env.AWS_CONTAINER_CREDENTIALS_FULL_URI));
	if (!hasSource) {
		return (
			'Refusing to deploy: no AWS credentials in the environment (AWS_PROFILE, AWS_ACCESS_KEY_ID + ' +
			'AWS_SECRET_ACCESS_KEY, or a web-identity/container credential source). Use a sandbox account.'
		);
	}
	return null;
}

/** Credential-bearing variables stripped from every dry-run child process. */
const AWS_CREDENTIAL_VARS = [
	'AWS_PROFILE',
	'AWS_DEFAULT_PROFILE',
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_SESSION_TOKEN',
	'AWS_SECURITY_TOKEN',
	'AWS_WEB_IDENTITY_TOKEN_FILE',
	'AWS_ROLE_ARN',
	'AWS_ROLE_SESSION_NAME',
	'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
	'AWS_CONTAINER_CREDENTIALS_FULL_URI',
	'AWS_CONTAINER_AUTHORIZATION_TOKEN',
	'AWS_CREDENTIAL_EXPIRATION',
];

/**
 * The environment for dry-run child processes: no credential can be found, so
 * any AWS call a child attempted would fail instead of touching an account.
 * Shared config/credential files point at a path that does not exist and the
 * instance-metadata lookup is disabled.
 */
export function offlineEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !AWS_CREDENTIAL_VARS.includes(key) && key !== OPT_IN_ENV) out[key] = value;
	}
	out.AWS_CONFIG_FILE = '/nonexistent/blocks-upgrade-dry-run/config';
	out.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/blocks-upgrade-dry-run/credentials';
	out.AWS_EC2_METADATA_DISABLED = 'true';
	out.CDK_DISABLE_CLI_TELEMETRY = 'true';
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CloudFormation templates — continuity comparator
// ─────────────────────────────────────────────────────────────────────────────

export interface CfnResource {
	Type: string;
	Properties?: Record<string, unknown>;
	Metadata?: Record<string, unknown>;
	DeletionPolicy?: string;
	UpdateReplacePolicy?: string;
	[key: string]: unknown;
}

export interface CfnTemplate {
	Resources: Record<string, CfnResource>;
	[key: string]: unknown;
}

/**
 * What a protected resource is to the auth block. `sessions` is the table of
 * the earlier release (child id `sessions`): the upgrade removes it from the
 * stack. `session-store` is `Auth`'s table (child id `session-store`): the
 * upgrade adds it.
 */
export type ProtectedRole = 'pool' | 'client' | 'group' | 'domain' | 'sessions' | 'session-store' | 'session-secret';

/** The child id of the sessions table of the earlier release, under the auth block. */
export const LEGACY_SESSIONS_CHILD_ID = 'sessions';
/** The child id of `Auth`'s session store, under the auth block. */
export const SESSION_STORE_CHILD_ID = 'session-store';

export interface ProtectedResource {
	role: ProtectedRole;
	logicalId: string;
	type: string;
	/** `aws:cdk:path`, for humans. Identity is the logical ID. */
	path: string;
	/** The name CloudFormation (or the secrets custom resource) creates the resource under. */
	physicalName: string | string[] | null;
}

/**
 * Roles whose loss or duplication destroys users or changes the cookie secret.
 * Every upgrade must keep exactly these. The sessions table is not one of
 * them: the upgrade replaces it with the session store, and each user signs in
 * once more.
 */
export const REQUIRED_ROLES: readonly ProtectedRole[] = ['pool', 'client', 'session-secret'];

const ROLE_BY_COGNITO_TYPE: Record<string, ProtectedRole> = {
	'AWS::Cognito::UserPool': 'pool',
	'AWS::Cognito::UserPoolClient': 'client',
	'AWS::Cognito::UserPoolGroup': 'group',
	'AWS::Cognito::UserPoolDomain': 'domain',
};

const PHYSICAL_NAME_PROPERTY: Record<string, string> = {
	'AWS::Cognito::UserPool': 'UserPoolName',
	'AWS::Cognito::UserPoolClient': 'ClientName',
	'AWS::Cognito::UserPoolGroup': 'GroupName',
	'AWS::Cognito::UserPoolDomain': 'Domain',
	'AWS::DynamoDB::Table': 'TableName',
	'AWS::SSM::Parameter': 'Name',
};

/**
 * User-pool properties that CloudFormation reports as "No interruption" but
 * Cognito's `UpdateUserPool` rejects once the pool exists — a change synths
 * cleanly, then the deploy rolls back. Compared exactly; `Schema` separately.
 */
export const SERVICE_IMMUTABLE_POOL_PROPERTIES = ['UsernameAttributes', 'AliasAttributes', 'UsernameConfiguration'];

/**
 * Properties whose change makes CloudFormation replace the resource (create
 * new, delete old) — checked on every protected resource, beyond the physical
 * name. `GenerateSecret` on the client is the frozen-contract one: replacing
 * `client` invalidates every refresh token in the session store.
 */
export const REPLACE_ONLY_PROPERTIES: Record<string, readonly string[]> = {
	'AWS::Cognito::UserPoolClient': ['UserPoolId', 'GenerateSecret'],
	'AWS::Cognito::UserPoolGroup': ['UserPoolId'],
	'AWS::Cognito::UserPoolDomain': ['UserPoolId'],
};

/** The construct path below the stack name (`<stack>/a/b` → `a/b`). */
function pathBelowStack(resource: CfnResource): string {
	const path = String(resource.Metadata?.['aws:cdk:path'] ?? '');
	const slash = path.indexOf('/');
	return slash < 0 ? '' : path.slice(slash + 1);
}

/** Session-secret parameter names managed by a bulk secrets custom resource, or `[]`. */
function sessionSecretParameterNames(resource: CfnResource): string[] {
	const params = resource.Properties?.Parameters;
	if (!Array.isArray(params)) return [];
	return params
		.map((p) => (p && typeof p === 'object' && 'name' in p ? String((p as { name: unknown }).name) : ''))
		.filter((name) => name.endsWith('-session-secret'))
		.sort();
}

/**
 * The auth block's identity-bearing resources in a template: the Cognito pool,
 * client, groups and domain under `blockPath`; the sessions table of the
 * earlier release (child id `sessions`) or `Auth`'s session-store table (child
 * id `session-store`); and the `session-secret` SSM parameter (owned by the
 * stack-level `BlocksSecretsBulk` custom resource, or a plain
 * `AWS::SSM::Parameter`). The secret is there under `secretsStore: 'ssm'`,
 * which the harness app uses (`BlocksPresets.sandbox`). Under
 * `'secrets-manager'` `Auth` keeps it in a Secrets Manager secret, which has
 * no role here.
 */
export function protectedResources(template: CfnTemplate, blockPath: string = AUTH_BLOCK_PATH): ProtectedResource[] {
	const out: ProtectedResource[] = [];
	for (const [logicalId, resource] of Object.entries(template.Resources ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const below = pathBelowStack(resource);
		const inBlock = below.startsWith(`${blockPath}/`);
		const path = String(resource.Metadata?.['aws:cdk:path'] ?? '');
		let role: ProtectedRole | undefined;
		let physicalName: string | string[] | null = null;
		if (inBlock && ROLE_BY_COGNITO_TYPE[resource.Type]) {
			role = ROLE_BY_COGNITO_TYPE[resource.Type];
		} else if (
			inBlock &&
			resource.Type === 'AWS::DynamoDB::Table' &&
			below.startsWith(`${blockPath}/${LEGACY_SESSIONS_CHILD_ID}/`)
		) {
			role = 'sessions';
		} else if (
			inBlock &&
			resource.Type === 'AWS::DynamoDB::Table' &&
			below.startsWith(`${blockPath}/${SESSION_STORE_CHILD_ID}/`)
		) {
			role = 'session-store';
		} else if (
			inBlock &&
			resource.Type === 'AWS::SSM::Parameter' &&
			below.startsWith(`${blockPath}/session-secret/`)
		) {
			role = 'session-secret';
		} else if (sessionSecretParameterNames(resource).length > 0) {
			role = 'session-secret';
			physicalName = sessionSecretParameterNames(resource);
		}
		if (!role) continue;
		if (physicalName === null) {
			const key = PHYSICAL_NAME_PROPERTY[resource.Type];
			const value = key ? resource.Properties?.[key] : undefined;
			physicalName = value === undefined ? null : typeof value === 'string' ? value : stableStringify(value);
		}
		out.push({ role, logicalId, type: resource.Type, path, physicalName });
	}
	return out;
}

/**
 * Why the base checkout's `bb-auth-cognito` manifest does not make it a
 * pre-refactor revision, or `null` when it does. `manifest` is the parsed
 * `packages/bb-auth-cognito/package.json`, or `undefined` when the file is
 * missing.
 */
export function legacyPackageProblem(manifest: unknown, revision: string): string | null {
	if (manifest === undefined) {
		return (
			`${revision} has no ${LEGACY_PACKAGE_DIR}: it is not a pre-refactor revision, so there is no ` +
			`AuthCognito to upgrade from. Pass --base-ref (BLOCKS_UPGRADE_BASE_REF) with a revision that ships ` +
			`AuthCognito, e.g. ${DEFAULT_BASE_REF}.`
		);
	}
	const name = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'name') : undefined;
	if (name !== LEGACY_PACKAGE_NAME) {
		return `${revision}: ${LEGACY_PACKAGE_DIR}/package.json names ${JSON.stringify(name)}, not ${LEGACY_PACKAGE_NAME}.`;
	}
	return null;
}

/**
 * Why the before/after template pair is not "an `AuthCognito` app, then the
 * same app on `Auth`" — the only pair the continuity proof means anything for —
 * or an empty list when it is. `AuthCognito` and `Auth` deliberately produce
 * the same pool, client and secret identity, so a before-template that is
 * secretly `Auth` could pass those checks vacuously. Here the
 * BEFORE side must own a user pool and no `Auth` immutability guard, and the
 * AFTER side must have the guard.
 */
export function upgradeRevisionErrors(before: CfnTemplate, after: CfnTemplate): string[] {
	const errors: string[] = [];
	const guards = (t: CfnTemplate) =>
		Object.entries(t.Resources ?? {})
			.filter(([, r]) => r.Type === AUTH_POOL_GUARD_TYPE)
			.map(([id]) => id);
	if (!protectedResources(before).some((r) => r.role === 'pool')) {
		errors.push(`the BEFORE template has no user pool under ${AUTH_BLOCK_PATH}: it is not an AuthCognito app`);
	}
	const beforeGuards = guards(before);
	if (beforeGuards.length > 0) {
		errors.push(
			`the BEFORE template has Auth's immutability guard (${beforeGuards.join(', ')}): it was synthesized by ` +
				'Auth, not AuthCognito, so the comparison would prove nothing. Use a pre-refactor --base-ref.',
		);
	}
	if (guards(after).length === 0) {
		errors.push(`the AFTER template has no ${AUTH_POOL_GUARD_TYPE}: it was not synthesized by Auth`);
	}
	return errors;
}

export interface ContinuityResult {
	/** Every protected resource, as found in the before-template. */
	before: ProtectedResource[];
	/** Each line is a reason the upgrade would destroy, replace or roll back. Empty = continuity holds. */
	errors: string[];
	/** Differences that are safe on update (informational). */
	notes: string[];
	/** The sessions table of the earlier release, as found in the before-template. The upgrade removes it. */
	legacySessions?: ProtectedResource;
	/** `Auth`'s session-store table, when the after-template has exactly one. The upgrade adds it. */
	sessionStore?: ProtectedResource;
}

/**
 * Compare the pre-upgrade template (`AuthCognito`) with the post-upgrade one
 * (`Auth`) for the auth block.
 *
 * **Kept:** the pool, the client, the groups, the domain and the session
 * secret must keep their logical ID, resource type and physical name; no
 * second pool, client or secret may appear; the pool's service-immutable
 * properties must be unchanged; and no replace-only property (the client's
 * `UserPoolId` / `GenerateSecret`, a group's `UserPoolId`) may change.
 *
 * **Replaced:** the sessions table. The pre-upgrade template has it under the
 * child id `sessions`. The post-upgrade template must not have that resource,
 * and must have exactly one session-store table (child id `session-store`)
 * with another physical name. A sessions table that stays is an error: its key
 * attribute changes, and CloudFormation cannot replace a table that has a fixed
 * name, so that deploy would fail.
 *
 * This is the offline equivalent of "`cdk diff` shows no replacement of what is
 * kept" plus the one check `cdk diff` cannot make (the rollback-on-update
 * properties).
 */
export function compareContinuity(
	before: CfnTemplate,
	after: CfnTemplate,
	blockPath: string = AUTH_BLOCK_PATH,
): ContinuityResult {
	const errors: string[] = [];
	const notes: string[] = [];
	const beforeProtected = protectedResources(before, blockPath);
	const afterProtected = protectedResources(after, blockPath);

	for (const role of [...REQUIRED_ROLES, 'sessions'] as const) {
		if (!beforeProtected.some((r) => r.role === role)) {
			errors.push(
				`the pre-upgrade template has no '${role}' resource under '${blockPath}' — wrong app or block path?`,
			);
		}
	}
	for (const b of beforeProtected.filter((r) => r.role === 'session-store')) {
		errors.push(
			`the pre-upgrade template already has the session-store table ${b.logicalId}: it was synthesized by ` +
				'this revision of Auth, not by the earlier release.',
		);
	}

	const legacySessions = beforeProtected.find((r) => r.role === 'sessions');
	const stores = afterProtected.filter((r) => r.role === 'session-store');
	const sessionStore = stores.length === 1 ? stores[0] : undefined;

	for (const b of beforeProtected) {
		const a = after.Resources?.[b.logicalId];
		const label = `${b.role} ${b.logicalId} (${b.type}, ${b.path || 'no path'})`;
		if (b.role === 'sessions') {
			if (a) {
				errors.push(
					`KEPT ${label} — the sessions table of the earlier release is still in the template. Its key ` +
						'attribute changes, and CloudFormation cannot replace a table that has a fixed name: the ' +
						`deploy would fail. Auth must build its session store under the child id '${SESSION_STORE_CHILD_ID}'.`,
				);
			} else {
				const policy = before.Resources[b.logicalId].DeletionPolicy ?? '(unset: Delete)';
				notes.push(
					`REMOVED ${label} — expected: the session store is a new table. CloudFormation removes this ` +
						`one from the stack (DeletionPolicy ${policy}).`,
				);
			}
			continue;
		}
		if (b.role === 'session-store') continue;
		if (!a) {
			errors.push(`REMOVED ${label} — CloudFormation would DELETE it from every existing deployment.`);
			continue;
		}
		if (a.Type !== b.type) {
			errors.push(`TYPE CHANGED ${label}: ${b.type} → ${a.Type} — CloudFormation would replace it.`);
			continue;
		}
		const afterMatch = afterProtected.find((r) => r.logicalId === b.logicalId);
		const afterName = afterMatch?.physicalName ?? null;
		if (stableStringify(afterName) !== stableStringify(b.physicalName)) {
			errors.push(
				`RENAMED ${label}: physical name ${stableStringify(b.physicalName)} → ${stableStringify(afterName)} — ` +
					'CloudFormation would REPLACE it (create new, delete old).',
			);
		}
		const beforeRes = before.Resources[b.logicalId];
		if (b.role === 'pool') comparePool(label, beforeRes, a, errors);
		const replaceOnly = REPLACE_ONLY_PROPERTIES[b.type] ?? [];
		for (const key of replaceOnly) {
			const pb = stableStringify(beforeRes.Properties?.[key] ?? (key === 'GenerateSecret' ? false : null));
			const pa = stableStringify(a.Properties?.[key] ?? (key === 'GenerateSecret' ? false : null));
			if (pa !== pb) {
				const consequence =
					key === 'GenerateSecret' ? ' and invalidate every refresh token in the session store' : '';
				errors.push(
					`CHANGED ${label}: ${key} ${pb} → ${pa} — replace-only: CloudFormation would REPLACE it${consequence}.`,
				);
			}
		}
		for (const attr of ['DeletionPolicy', 'UpdateReplacePolicy'] as const) {
			if (beforeRes[attr] !== a[attr]) {
				notes.push(
					`${label}: ${attr} ${beforeRes[attr] ?? '(unset)'} → ${a[attr] ?? '(unset)'} (template metadata; no resource update)`,
				);
			}
		}
		const changedProps = changedPropertyKeys(beforeRes.Properties, a.Properties).filter(
			(k) =>
				!replaceOnly.includes(k) &&
				!(b.role === 'pool' && (SERVICE_IMMUTABLE_POOL_PROPERTIES.includes(k) || k === 'Schema')),
		);
		if (changedProps.length > 0) {
			notes.push(`${label}: properties updated in place: ${changedProps.join(', ')}`);
		}
	}

	for (const a of afterProtected) {
		if (before.Resources?.[a.logicalId]) continue;
		const label = `${a.role} ${a.logicalId} (${a.type}, ${a.path || 'no path'})`;
		if (a.role === 'session-store') {
			notes.push(`ADDED ${label} — expected: the session store, a new table named ${stableStringify(a.physicalName)}.`);
		} else if (a.role === 'sessions') {
			errors.push(
				`ADDED ${label} — a table under the old child id '${LEGACY_SESSIONS_CHILD_ID}'. Auth must build its ` +
					`session store under '${SESSION_STORE_CHILD_ID}'.`,
			);
		} else if (REQUIRED_ROLES.includes(a.role)) {
			errors.push(
				`ADDED ${label} — a second ${a.role} next to the existing one means a child construct id ` +
					'changed: CloudFormation would create a new resource and delete the old one.',
			);
		} else {
			notes.push(`ADDED ${label}`);
		}
	}

	if (stores.length !== 1) {
		errors.push(
			`the post-upgrade template has ${stores.length} session-store table(s) under ` +
				`'${blockPath}/${SESSION_STORE_CHILD_ID}'; expected exactly one.`,
		);
	} else if (legacySessions) {
		const [store] = stores;
		if (stableStringify(store.physicalName) === stableStringify(legacySessions.physicalName)) {
			errors.push(
				`the session-store table has the name of the old sessions table (${stableStringify(store.physicalName)}): ` +
					'CloudFormation would create it while the old table still has that name, and fail.',
			);
		}
		if (typeof store.physicalName !== 'string' || !store.physicalName.endsWith(`-${SESSION_STORE_CHILD_ID}`)) {
			errors.push(
				`the session-store table name ${stableStringify(store.physicalName)} does not end with ` +
					`'-${SESSION_STORE_CHILD_ID}'.`,
			);
		}
	}

	return { before: beforeProtected, errors, notes, legacySessions, sessionStore };
}

function comparePool(label: string, before: CfnResource, after: CfnResource, errors: string[]): void {
	for (const key of SERVICE_IMMUTABLE_POOL_PROPERTIES) {
		const b = stableStringify(before.Properties?.[key] ?? null);
		const a = stableStringify(after.Properties?.[key] ?? null);
		if (a !== b) {
			errors.push(
				`CHANGED ${label}: ${key} ${b} → ${a} — immutable once the pool exists: UpdateUserPool ` +
					'rejects it and the stack rolls back (cdk diff reports "No interruption").',
			);
		}
	}
	const schemaOf = (r: CfnResource) => {
		const raw = r.Properties?.Schema;
		const map = new Map<string, unknown>();
		if (Array.isArray(raw)) {
			for (const attr of raw) {
				if (attr && typeof attr === 'object' && 'Name' in attr) map.set(String(attr.Name), attr);
			}
		}
		return map;
	};
	const bs = schemaOf(before);
	const as = schemaOf(after);
	for (const [name, attr] of bs) {
		if (!as.has(name)) {
			errors.push(
				`CHANGED ${label}: schema attribute '${name}' removed — existing attributes cannot be removed (rollback).`,
			);
		} else if (stableStringify(as.get(name)) !== stableStringify(attr)) {
			errors.push(
				`CHANGED ${label}: schema attribute '${name}' ${stableStringify(attr)} → ${stableStringify(as.get(name))} ` +
					'— existing attributes cannot be modified (rollback).',
			);
		}
	}
	for (const [name, attr] of as) {
		if (bs.has(name)) continue;
		const required = (attr as { Required?: unknown }).Required === true;
		if (required) {
			errors.push(
				`CHANGED ${label}: new required attribute '${name}' — required attributes are fixed at creation (rollback).`,
			);
		}
	}
}

/** Top-level `Properties` keys whose values differ. */
function changedPropertyKeys(
	before: Record<string, unknown> | undefined,
	after: Record<string, unknown> | undefined,
): string[] {
	const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
	return [...keys].filter((k) => stableStringify(before?.[k] ?? null) !== stableStringify(after?.[k] ?? null)).sort();
}

/** JSON with object keys sorted, so key order never reads as a difference. */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

// ─────────────────────────────────────────────────────────────────────────────
// `cdk diff` — replacement parser
// ─────────────────────────────────────────────────────────────────────────────

export type DiffAction = 'add' | 'remove' | 'update' | 'import' | 'unknown';
export type DiffImpact = 'replace' | 'may-replace' | 'destroy' | 'orphan' | 'import' | 'none';

export interface CdkDiffResourceChange {
	action: DiffAction;
	type: string;
	logicalId: string;
	/** The normalized construct path cdk prints before the logical ID, when it has one. */
	path?: string;
	impact: DiffImpact;
	/** Property names cdk marked "(requires replacement)" or "(may cause replacement)". */
	replacingProperties: string[];
	/** The resource line as printed (ANSI stripped). */
	line: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

const ACTION_BY_PREFIX: Record<string, DiffAction> = { '+': 'add', '-': 'remove', '~': 'update', '←': 'import' };
const IMPACT_BY_WORDS: Record<string, DiffImpact> = {
	replace: 'replace',
	'may be replaced': 'may-replace',
	destroy: 'destroy',
	orphan: 'orphan',
	import: 'import',
};

/**
 * Parse the "Resources" section of `cdk diff` output (as printed by
 * `@aws-cdk/cloudformation-diff`) into one entry per changed resource:
 *
 * ```
 * [~] AWS::Cognito::UserPool upgrade/auth/pool upgradeauthpool1A2B3C4D replace
 *  └─ [~] UserPoolName (requires replacement)
 * ```
 *
 * Color codes are stripped. Lines that are not resource changes (IAM tables,
 * outputs, parameters, headers) are ignored.
 */
export function parseCdkDiff(text: string): CdkDiffResourceChange[] {
	const out: CdkDiffResourceChange[] = [];
	let current: CdkDiffResourceChange | undefined;
	for (const rawLine of text.replace(ANSI, '').split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		const resource = /^\[([+\-~←?])\] ((?:AWS|Custom|Alexa)::\S+)\s+(.+)$/u.exec(line);
		if (resource) {
			let rest = resource[3].replace(/\s*\(OR move .*\)$/, '').trim();
			let impact: DiffImpact = 'none';
			const impactMatch = /\s(may be replaced|replace|destroy|orphan|import)$/.exec(rest);
			if (impactMatch) {
				impact = IMPACT_BY_WORDS[impactMatch[1]];
				rest = rest.slice(0, impactMatch.index).trim();
			}
			const tokens = rest.split(/\s+/);
			const logicalId = tokens[tokens.length - 1];
			const path = tokens.length > 1 ? tokens.slice(0, -1).join(' ') : undefined;
			current = {
				action: ACTION_BY_PREFIX[resource[1]] ?? 'unknown',
				type: resource[2],
				logicalId,
				...(path ? { path } : {}),
				impact,
				replacingProperties: [],
				line,
			};
			out.push(current);
			continue;
		}
		const property = /^\s*[├└]─\s+\[[+\-~ ]\]\s+(.+?)\s+\((requires replacement|may cause replacement)\)$/u.exec(
			line,
		);
		if (property && current) {
			current.replacingProperties.push(property[1]);
			continue;
		}
		// A blank line or a new section ends the current resource's property tree.
		if (line === '' || /^\S/.test(line)) current = undefined;
	}
	return out;
}

export interface DiffProtection {
	/** Resource types that must never be replaced, removed or duplicated. */
	types: readonly string[];
	/** Extra logical IDs to protect regardless of type (e.g. the secrets resource). */
	logicalIds?: readonly string[];
}

/** The Cognito resource types `cdk diff` must not show replaced, removed or added. */
export const DIFF_PROTECTED_TYPES = ['AWS::Cognito::UserPool', 'AWS::Cognito::UserPoolClient'] as const;

/**
 * Every `cdk diff` change that would replace, delete or duplicate a protected
 * resource, as one human-readable line each. Empty = the upgrade keeps them.
 *
 * - removal of a protected resource → it would be deleted;
 * - addition of a protected *type* → a new pool/client next to the old one,
 *   i.e. a renamed child construct id (cdk shows a rename as `[-]` + `[+]`);
 * - an update marked `replace` / `may be replaced`, or with any property marked
 *   "(requires replacement)" / "(may cause replacement)".
 */
export function findDiffViolations(changes: readonly CdkDiffResourceChange[], protection: DiffProtection): string[] {
	const out: string[] = [];
	const ids = new Set(protection.logicalIds ?? []);
	for (const c of changes) {
		const protectedType = protection.types.includes(c.type);
		if (!protectedType && !ids.has(c.logicalId)) continue;
		const where = `${c.type} ${c.path ? `${c.path} ` : ''}${c.logicalId}`;
		if (c.action === 'remove') {
			const verb = c.impact === 'orphan' ? 'ORPHAN (drop from the stack, retain unmanaged)' : 'DELETE';
			out.push(`would ${verb} ${where} (${c.line})`);
		} else if (c.action === 'add' && protectedType) {
			out.push(`would CREATE a new ${where} — a renamed child construct id? (${c.line})`);
		} else if (c.impact === 'replace' || c.impact === 'may-replace' || c.replacingProperties.length > 0) {
			const props = c.replacingProperties.length > 0 ? ` via ${c.replacingProperties.join(', ')}` : '';
			out.push(`would REPLACE ${where}${props} (${c.line})`);
		}
	}
	return out;
}

/**
 * What `cdk diff` must show for the session store: the sessions table of the
 * earlier release leaves the stack (a `[-]` line, `destroy` or `orphan`), and
 * the session-store table is added (a `[+]` line). One line per problem; empty
 * = the diff shows the replacement as planned. A sessions table shown as
 * updated or replaced in place is a problem: that deploy would fail.
 */
export function sessionStoreDiffErrors(
	changes: readonly CdkDiffResourceChange[],
	legacyLogicalId: string,
	storeLogicalId: string,
): string[] {
	const out: string[] = [];
	const legacy = changes.find((c) => c.logicalId === legacyLogicalId);
	if (!legacy) {
		out.push(`cdk diff shows no change for the old sessions table ${legacyLogicalId}; expected its removal.`);
	} else if (legacy.action !== 'remove') {
		out.push(
			`cdk diff does not remove the old sessions table ${legacyLogicalId} (${legacy.line}); an in-place ` +
				'change of its key would fail the deploy.',
		);
	}
	const store = changes.find((c) => c.logicalId === storeLogicalId);
	if (!store || store.action !== 'add') {
		out.push(
			`cdk diff does not add the session-store table ${storeLogicalId}${store ? ` (${store.line})` : ''}; ` +
				'expected a new table.',
		);
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stack status and stack events
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of a CloudFormation `StackEvent` the parser reads. */
export interface StackEventLike {
	EventId?: string;
	StackName?: string;
	LogicalResourceId?: string;
	PhysicalResourceId?: string;
	ResourceType?: string;
	Timestamp?: Date | string;
	ResourceStatus?: string;
	ResourceStatusReason?: string;
}

export type StackStatusClass = 'in-progress' | 'complete' | 'rolled-back' | 'failed';

/** Classify a CloudFormation stack status. */
export function classifyStackStatus(status: string): StackStatusClass {
	if (status.endsWith('_IN_PROGRESS')) return 'in-progress';
	if (status === 'UPDATE_ROLLBACK_COMPLETE' || status === 'ROLLBACK_COMPLETE') return 'rolled-back';
	if (status.endsWith('_COMPLETE') && !status.includes('ROLLBACK')) return 'complete';
	return 'failed';
}

export interface ResourceFailure {
	logicalId: string;
	type: string;
	status: string;
	reason: string;
	timestamp: string;
}

export interface UpdateFailureReport {
	/** When the stack's most recent `UPDATE_IN_PROGRESS` started (ISO), if found. */
	updateStartedAt?: string;
	/** The stack's latest status in the events, e.g. `UPDATE_ROLLBACK_COMPLETE`. */
	finalStackStatus?: string;
	/** Resource failures of this update, oldest first, cascade cancellations excluded. */
	failures: ResourceFailure[];
	/** The first failure — the cause the rest cascade from. */
	rootCause?: ResourceFailure;
	/** The first `AWS::Cognito::UserPool` failure: the `UpdateUserPool` error `cdk diff` could not show. */
	userPoolFailure?: ResourceFailure;
}

const CASCADE_REASON = /^Resource (update|creation|deletion) cancelled/i;

function eventTime(e: StackEventLike): number {
	return e.Timestamp === undefined ? 0 : new Date(e.Timestamp).getTime();
}

/**
 * Extract why the stack's most recent update failed from its events (any
 * order; `DescribeStackEvents` returns newest first). Only events from the most
 * recent stack-level `UPDATE_IN_PROGRESS` onward are considered, so an earlier
 * deploy's failures are never blamed on this one. "Resource update cancelled"
 * cascades are dropped; the first remaining failure is the root cause.
 */
export function extractUpdateFailures(events: readonly StackEventLike[], stackName: string): UpdateFailureReport {
	const sorted = [...events].sort((a, b) => eventTime(a) - eventTime(b));
	const isStackEvent = (e: StackEventLike) =>
		e.ResourceType === 'AWS::CloudFormation::Stack' && e.LogicalResourceId === stackName;
	let startIdx = -1;
	for (let i = sorted.length - 1; i >= 0; i--) {
		if (isStackEvent(sorted[i]) && sorted[i].ResourceStatus === 'UPDATE_IN_PROGRESS') {
			startIdx = i;
			break;
		}
	}
	const window = startIdx >= 0 ? sorted.slice(startIdx) : sorted;
	const stackEvents = window.filter(isStackEvent);
	const failures: ResourceFailure[] = window
		.filter(
			(e) =>
				!isStackEvent(e) &&
				typeof e.ResourceStatus === 'string' &&
				e.ResourceStatus.endsWith('_FAILED') &&
				!CASCADE_REASON.test(e.ResourceStatusReason ?? ''),
		)
		.map((e) => ({
			logicalId: e.LogicalResourceId ?? '(unknown)',
			type: e.ResourceType ?? '(unknown)',
			status: e.ResourceStatus ?? '(unknown)',
			reason: e.ResourceStatusReason ?? '(no reason given)',
			timestamp: new Date(eventTime(e)).toISOString(),
		}));
	const report: UpdateFailureReport = { failures };
	if (startIdx >= 0) report.updateStartedAt = new Date(eventTime(sorted[startIdx])).toISOString();
	const last = stackEvents[stackEvents.length - 1];
	if (last?.ResourceStatus) report.finalStackStatus = last.ResourceStatus;
	if (failures[0]) report.rootCause = failures[0];
	const pool = failures.find((f) => f.type === 'AWS::Cognito::UserPool');
	if (pool) report.userPoolFailure = pool;
	return report;
}

/** A multi-line explanation of a failed upgrade deploy, `UpdateUserPool` error first. */
export function formatUpdateFailureReport(report: UpdateFailureReport, stackName: string): string {
	const lines = [
		`Stack ${stackName} did not reach UPDATE_COMPLETE (latest status: ${report.finalStackStatus ?? 'unknown'}).`,
	];
	if (report.userPoolFailure) {
		lines.push(
			'',
			'UpdateUserPool rejected the change — the failure `cdk diff` cannot show:',
			`  ${report.userPoolFailure.logicalId}: ${report.userPoolFailure.reason}`,
		);
	}
	if (report.failures.length === 0) {
		lines.push('', 'No resource failure found in the stack events of this update.');
	} else {
		lines.push('', 'Resource failures (oldest first; cascade cancellations omitted):');
		for (const f of report.failures) {
			lines.push(`  ${f.timestamp}  ${f.status}  ${f.logicalId} (${f.type})`, `      ${f.reason}`);
		}
	}
	return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Deployed identity — the step-5 comparison
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the harness reads of the deployed auth block: the physical ids CloudFormation reports
 * (`ListStackResources`), plus the secret's parameter name from the template. Nothing here needs a
 * service-side read, so the harness runs with the CI e2e role's grants.
 *
 * The pool id, the client id and the secret's parameter name must be identical before and after the
 * upgrade: replacing a user pool or app client mints a new id. The table that holds the sessions must
 * NOT be the same: before the upgrade it is the `sessions` table of the earlier release, after it is
 * `Auth`'s session-store table, a new table with another name. The secret's value and the seeded
 * user's `sub` are proven by the app instead: signing in through the upgraded app returns the same
 * `userSub`, and the cookie it sets authenticates.
 */
export interface DeployedIdentity {
	userPoolId: string;
	clientId: string;
	/** The table that holds the sessions: the `sessions` table before the upgrade, the session-store table after. */
	sessionsTableName: string;
	sessionSecretParameterName: string;
}

/** The fields that must not change, with their labels for the report. */
const KEPT_IDENTITY_LABELS = {
	userPoolId: 'user pool id',
	clientId: 'app client id',
	sessionSecretParameterName: 'session-secret SSM parameter name',
} as const satisfies Partial<Record<keyof DeployedIdentity, string>>;

/**
 * One line per problem across the upgrade. Empty = the pool, the client and the secret kept their
 * identity, and the sessions are in a new table whose name ends with `-session-store`.
 */
export function compareDeployedIdentity(before: DeployedIdentity, after: DeployedIdentity): string[] {
	const out: string[] = [];
	for (const key of Object.keys(KEPT_IDENTITY_LABELS) as (keyof typeof KEPT_IDENTITY_LABELS)[]) {
		if (before[key] !== after[key]) {
			out.push(`${KEPT_IDENTITY_LABELS[key]} changed: ${before[key]} → ${after[key]}`);
		}
	}
	if (before.sessionsTableName === after.sessionsTableName) {
		out.push(
			`the sessions are still in the table ${after.sessionsTableName}: expected a new table for the session store`,
		);
	}
	if (!after.sessionsTableName.endsWith(`-${SESSION_STORE_CHILD_ID}`)) {
		out.push(`the session-store table name ${after.sessionsTableName} does not end with -${SESSION_STORE_CHILD_ID}`);
	}
	return out;
}

/**
 * How a resource left the stack, read from the stack events: `'deleted'` (a `DELETE_COMPLETE`
 * event), `'retained'` (`DELETE_SKIPPED`: its `DeletionPolicy` is `Retain`, so it is still in the
 * account), `'failed'` (`DELETE_FAILED`), or `'unknown'` when the events hold none of these for it.
 */
export function removalOutcome(
	events: readonly StackEventLike[],
	logicalId: string,
): 'deleted' | 'retained' | 'failed' | 'unknown' {
	const statuses = new Set(
		events.filter((e) => e.LogicalResourceId === logicalId).map((e) => e.ResourceStatus ?? ''),
	);
	if (statuses.has('DELETE_COMPLETE')) return 'deleted';
	if (statuses.has('DELETE_SKIPPED')) return 'retained';
	if (statuses.has('DELETE_FAILED')) return 'failed';
	return 'unknown';
}

/**
 * Every AWS API action the harness itself sends (the CDK deploy/destroy scripts use the CDK bootstrap
 * roles). `lib.test.ts` checks this list against the SDK commands in `upgrade-in-place.ts`, and the
 * IAM-authorized ones against the CI e2e role in `test-infra/github-oidc-stack.ts`.
 */
export const HARNESS_AWS_ACTIONS: readonly string[] = [
	'cloudformation:DeleteStack',
	'cloudformation:DescribeStackEvents',
	'cloudformation:DescribeStacks',
	'cloudformation:GetTemplate',
	'cloudformation:ListStackResources',
	'cognito-idp:AdminCreateUser',
	'cognito-idp:AdminSetUserPassword',
	'cognito-idp:InitiateAuth',
	'sts:GetCallerIdentity',
];

/** Actions IAM does not authorize: Cognito's public client API, and the caller-identity lookup. */
export const UNAUTHENTICATED_AWS_ACTIONS: readonly string[] = ['cognito-idp:InitiateAuth', 'sts:GetCallerIdentity'];

// ─────────────────────────────────────────────────────────────────────────────
// HTTP: JSON-RPC and the session cookie
// ─────────────────────────────────────────────────────────────────────────────

/** A JSON-RPC 2.0 request body for `<namespace>.<method>(...args)`. */
export function encodeRpcRequest(namespace: string, method: string, args: readonly unknown[], id = 1): string {
	return JSON.stringify({ jsonrpc: '2.0', method: `${namespace}.${method}`, params: args, id });
}

export type RpcOutcome = { ok: true; result: unknown } | { ok: false; code: number; message: string; name?: string };

/** Decode a JSON-RPC 2.0 response body. Errors cross the wire by `data.name`. */
export function decodeRpcResponse(body: unknown): RpcOutcome {
	if (!body || typeof body !== 'object') return { ok: false, code: -32700, message: 'Response is not a JSON object' };
	const rpc = body as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: { name?: unknown } } };
	if (rpc.error) {
		const name = rpc.error.data?.name;
		return {
			ok: false,
			code: typeof rpc.error.code === 'number' ? rpc.error.code : -32603,
			message: typeof rpc.error.message === 'string' ? rpc.error.message : 'Unknown RPC error',
			...(typeof name === 'string' ? { name } : {}),
		};
	}
	return { ok: true, result: rpc.result };
}

export interface SessionCookie {
	name: string;
	value: string;
}

/**
 * The live session cookie among `Set-Cookie` values: the first `auth_<fullId>`
 * cookie that is not a deletion (`Max-Age<=0`, an `Expires` in the past, or an
 * empty value). `null` when the response sets none.
 */
/** Whether a `Set-Cookie` line deletes its cookie: `Max-Age` not above zero, or an `Expires` in the past. */
function deletesCookie(attrs: readonly string[], now: number): boolean {
	for (const attr of attrs) {
		const [k, ...v] = attr.split('=');
		const key = k.trim().toLowerCase();
		const val = v.join('=').trim();
		if (key === 'max-age' && Number(val) <= 0) return true;
		if (key === 'expires' && !Number.isNaN(Date.parse(val)) && Date.parse(val) <= now) return true;
	}
	return false;
}

/** Whether one of the `Set-Cookie` lines deletes the cookie `name` (what `Auth` sends with a signed-out answer). */
export function clearsCookie(setCookies: readonly string[], name: string, now: number = Date.now()): boolean {
	return setCookies.some((header) => {
		const [pair, ...attrs] = header.split(';');
		const eq = pair.indexOf('=');
		return eq > 0 && pair.slice(0, eq).trim() === name && deletesCookie(attrs, now);
	});
}

export function extractSessionCookie(
	setCookies: readonly string[],
	now: number = Date.now(),
	namePrefix = 'auth_',
): SessionCookie | null {
	for (const header of setCookies) {
		const [pair, ...attrs] = header.split(';');
		const eq = pair.indexOf('=');
		if (eq <= 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (!name.startsWith(namePrefix) || value === '') continue;
		if (!deletesCookie(attrs, now)) return { name, value };
	}
	return null;
}
