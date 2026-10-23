// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The rewrite tables behind `bb-auth migrate`: which modules, names, methods,
 * options and error names move from `AuthBasic` / `AuthCognito` / `AuthOIDC`
 * to `Auth`. Data only — `transform.ts` applies it.
 *
 * Every row here is mirrored in `MIGRATION.md`; keep the two in step.
 */

/** Which old block a symbol came from. */
export type OldBlock = 'basic' | 'cognito' | 'oidc';

/** The marker every comment the codemod leaves starts with. Grep for it. */
export const TODO_TAG = 'TODO(aws-blocks-auth-migrate)';

/** The new package. */
export const NEW_MODULE = '@aws-blocks/bb-auth';

/** Old package specifier → which block it is. */
export const OLD_MODULES: Readonly<Record<string, OldBlock>> = {
	'@aws-blocks/bb-auth-basic': 'basic',
	'@aws-blocks/bb-auth-cognito': 'cognito',
	'@aws-blocks/bb-auth-oidc': 'oidc',
};

/** Old sub-path specifiers that have a direct replacement. */
export const OLD_SUBPATHS: Readonly<Record<string, string>> = {
	'@aws-blocks/bb-auth-cognito/ui': '@aws-blocks/bb-auth/ui',
};

/**
 * What each name exported by an old sub-path in {@link OLD_SUBPATHS} becomes.
 * A name absent here is kept as it is.
 */
export const SUBPATH_NAME_RULES: Readonly<Record<string, Readonly<Record<string, NameRule>>>> = {
	// Everything `@aws-blocks/bb-auth-cognito/ui` exported.
	'@aws-blocks/bb-auth-cognito/ui': {
		cognitoOverrides: { to: 'authOverrides', role: 'value' },
		CognitoActionName: { to: 'AuthActionName', role: 'type' },
		CognitoNextStepName: { to: 'AuthNextStepName', role: 'type' },
		CognitoActionFields: { to: 'AuthActionFields', role: 'type' },
		CognitoActionOverride: { to: 'AuthTypedActionOverride', role: 'type' },
		CognitoAuthenticatorOptions: { to: 'AuthTypedAuthenticatorOptions', role: 'type' },
	},
};

/**
 * Old sub-path specifiers with no replacement module (the codemod leaves a
 * TODO). Both re-exported `AuthOIDC`'s browser entry: the names that also
 * exist in `@aws-blocks/bb-auth` (its `oidc` rows in {@link NAME_RULES}) are
 * moved there; the client handle and its helpers have no equivalent.
 */
export const DEAD_SUBPATHS: Readonly<Record<string, string>> = {
	'@aws-blocks/bb-auth-oidc/middleware':
		'Auth has no client middleware: sign-in buttons come from getAuthState() (signIn:<id> actions carry a url). Delete this import and any getClient() usage.',
	'@aws-blocks/bb-auth-oidc/client':
		'Auth has no OIDC client handle: sign-in buttons come from getAuthState() (signIn:<id> actions carry a url). Delete this import and any getClient() usage.',
};

/** Old packages' unexported sub-paths, and anything else under them: never compiled, so only flagged. */
export function unknownOldSubpath(spec: string): boolean {
	return Object.keys(OLD_MODULES).some((m) => spec.startsWith(`${m}/`));
}

/** TODOs for import shapes the codemod can't rewrite. */
export const IMPORT_TODOS = {
	noEquivalent: (names: readonly string[]): string =>
		`${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} no equivalent in @aws-blocks/bb-auth: remove ${names.length === 1 ? 'its' : 'their'} uses.`,
	emptyImport: 'this import names nothing: delete it (or import what you use from @aws-blocks/bb-auth).',
	unknownSubpath: 'this old auth package path was never public: import from @aws-blocks/bb-auth instead.',
	namespaceUse:
		'the codemod cannot follow this use of the namespace: rename any AuthBasic / AuthCognito / AuthOIDC names reached through it by hand (MIGRATION.md, "Names").',
} as const;

/**
 * Umbrella specifiers. Their module specifier is kept (at the cutover release
 * `@aws-blocks/blocks` re-exports `Auth` and its types); only old names are
 * renamed.
 */
export const UMBRELLA_MODULES: ReadonlySet<string> = new Set(['@aws-blocks/blocks', '@aws-blocks/blocks/cdk']);

/** What one imported name becomes. */
export interface NameRule {
	/**
	 * The new export name. Omitted: the same name exists in `@aws-blocks/bb-auth`.
	 * `null`: the export is gone (the specifier is kept, with a TODO, so the
	 * compiler points at every use).
	 */
	to?: string | null;
	/** What the symbol is, so references can be handled. */
	role: 'class' | 'errors' | 'factory' | 'type' | 'value';
	/** Left as a TODO next to the import. */
	todo?: string;
	/** For `role: 'factory'`: the old provider factory. */
	factory?: OidcFactory;
}

/** `AuthOIDC`'s provider factories. */
export type OidcFactory = 'google' | 'github' | 'customOidc' | 'customOauth2' | 'stubIdp' | 'cognitoFederated';

const same = (role: NameRule['role']): NameRule => ({ role });

/**
 * Old export name → rule, per block. A name absent from its block's table is
 * left untouched (it was never exported, so the import was already broken).
 */
export const NAME_RULES: Readonly<Record<OldBlock, Readonly<Record<string, NameRule>>>> = {
	cognito: {
		AuthCognito: { to: 'Auth', role: 'class' },
		AuthCognitoErrors: { to: 'AuthErrors', role: 'errors' },
		AuthCognitoOptions: { to: 'AuthOptions', role: 'type' },
		AuthCognitoMockOptions: { to: 'AuthMockOptions', role: 'type' },
		CognitoUser: { to: 'AuthenticatedUser', role: 'type' },
		FetchAuthSessionOptions: { to: 'GetAuthSessionOptions', role: 'type' },
		MFAPreference: { to: 'MfaPreference', role: 'type' },
		MFAPreferenceInput: { to: 'MfaPreferenceInput', role: 'type' },
		MFASetting: { to: 'MfaSetting', role: 'type' },
		WebAuthnRelyingPartyConfig: {
			to: 'PasskeyOptions',
			role: 'type',
			todo: "PasskeyOptions is shaped { relyingPartyId, origins, userVerification? } (was { id, origins, userVerification? }); 'discouraged' is no longer accepted.",
		},
		AuthFlowType: {
			to: null,
			role: 'type',
			todo: "AuthFlowType is gone. Use NonNullable<UserPoolOptions['authFlow']> ('USER_PASSWORD_AUTH' | 'USER_AUTH').",
		},
		SignInWith: {
			to: null,
			role: 'type',
			todo: "SignInWith is gone. Use NonNullable<UserPoolOptions['signInWith']>[number].",
		},
		ConfirmSignInResponse: {
			to: null,
			role: 'type',
			todo: 'confirmSignIn() now takes the answer as a plain string (the code, the new password, the MFA type, …).',
		},
		makeExternalUserPoolRef: {
			to: null,
			role: 'value',
			todo: 'makeExternalUserPoolRef() is gone. Use Auth.fromExisting(userPoolId, clientId).',
		},
		envVarNames: {
			to: null,
			role: 'value',
			todo: 'envVarNames() is gone. Read pool identifiers with getSdkIdentifiers(auth) from @aws-blocks/blocks.',
		},
		isRetriableAuthError: {
			to: null,
			role: 'value',
			todo: 'isRetriableAuthError() is not exported by @aws-blocks/bb-auth. Match the names you retry on with isAuthError(e, AuthErrors.X).',
		},
		SessionStore: { to: null, role: 'value', todo: 'SessionStore was internal and is gone.' },
		SessionRecord: { to: null, role: 'type', todo: 'SessionRecord was internal and is gone.' },
		// Unchanged names (also exported by @aws-blocks/bb-auth).
		AdminAction: same('type'),
		AdminActionGate: same('type'),
		AdminCreateInit: same('type'),
		AdminDisabled: same('type'),
		AdminGetterOf: same('type'),
		AdminGrants: same('type'),
		AdminOptions: same('type'),
		AdminSurface: same('type'),
		AdminUser: same('type'),
		AdminUserFilter: same('type'),
		AttrOf: same('type'),
		AuthSession: same('type'),
		CodeDeliveryDetails: same('type'),
		CodeDeliveryFn: same('type'),
		CompletePasskeyRegistrationResult: same('type'),
		ConfirmSignInOptions: same('type'),
		ConfirmSignUpResult: same('type'),
		CustomAttrNames: same('type'),
		DeviceRecord: same('type'),
		ExternalUserPoolRef: same('type'),
		GroupAdmin: same('type'),
		GroupOf: same('type'),
		JWT: same('type'),
		LifecycleAdmin: same('type'),
		MfaTypeOf: same('type'),
		PasskeyDescription: same('type'),
		PasswordPolicy: same('type'),
		PreferredChallenge: same('type'),
		ReadAttrOf: same('type'),
		ResetPasswordResult: same('type'),
		SetPasswordOptions: same('type'),
		SignInNextStep: same('type'),
		SignInOptions: same('type'),
		SignInResult: same('type'),
		SignUpOptions: same('type'),
		SignUpResult: same('type'),
		StandardUserAttributeKey: same('type'),
		StartPasskeyRegistrationResult: same('type'),
		UpdateAttributeOutcome: same('type'),
		UserAttribute: same('type'),
	},
	basic: {
		AuthBasic: { to: 'Auth', role: 'class' },
		AuthBasicErrors: { to: 'AuthErrors', role: 'errors' },
		AuthBasicOptions: { to: 'AuthMockOptions', role: 'type' },
		AuthBasicUser: {
			to: 'AuthenticatedUser',
			role: 'type',
			todo: 'AuthenticatedUser has no createdAt. Read the creation date with auth.admin.getUser() if you need it.',
		},
		CodeDeliveryFn: same('type'),
		PasswordPolicy: same('type'),
		// Re-exported from @aws-blocks/auth-common by AuthBasic; bb-auth does not re-export them.
		AuthAction: { to: null, role: 'type', todo: 'Import AuthAction from @aws-blocks/blocks instead.' },
		AuthActionInput: { to: null, role: 'type', todo: 'Import AuthActionInput from @aws-blocks/blocks instead.' },
		AuthField: { to: null, role: 'type', todo: 'Import AuthField from @aws-blocks/blocks instead.' },
		AuthState: { to: null, role: 'type', todo: 'Import AuthState from @aws-blocks/blocks instead.' },
		AuthUser: { to: null, role: 'type', todo: 'Import AuthUser from @aws-blocks/blocks instead.' },
		BlocksAuth: { to: null, role: 'type', todo: 'Import BlocksAuth from @aws-blocks/blocks instead.' },
	},
	oidc: {
		AuthOIDC: { to: 'Auth', role: 'class' },
		AuthOIDCErrors: { to: 'AuthErrors', role: 'errors' },
		AuthOIDCErrorName: { to: 'AuthErrorName', role: 'type' },
		OIDCUser: {
			to: 'AuthenticatedUser',
			role: 'type',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: user-facing text naming the `${iss}:${sub}` id format, not a template
			todo: 'AuthenticatedUser has no iss / sub / provider / email / name: use claims?.iss, claims?.sub, signInProvider, attributes.email, attributes.name; userId is still `${iss}:${sub}`.',
		},
		OIDCClient: {
			to: null,
			role: 'type',
			todo: 'OIDCClient (getClient()) is gone: federated sign-in buttons come from getAuthState() (signIn:<id> actions carry a url).',
		},
		google: { to: null, role: 'factory', factory: 'google' },
		customOidc: { to: null, role: 'factory', factory: 'customOidc' },
		cognitoFederated: { to: null, role: 'factory', factory: 'cognitoFederated' },
		github: { to: 'github', role: 'factory', factory: 'github' },
		customOauth2: { to: 'customOauth2', role: 'factory', factory: 'customOauth2' },
		stubIdp: { to: 'stubIdp', role: 'factory', factory: 'stubIdp' },
		relayOrigin: same('value'),
		RelayOrigin: same('type'),
		MappedClaims: same('type'),
		OnStubAuthorize: same('type'),
		StubAuthorizeRequest: same('type'),
		StubUser: same('type'),
	},
};

/** The old umbrella names, and which block each belongs to. */
export function umbrellaBlockFor(name: string): OldBlock | undefined {
	// Only names that are *specific* to an old block. Shared names
	// (`SignInResult`, `CodeDeliveryFn`, …) are re-exported by the umbrella at
	// cutover from `@aws-blocks/bb-auth`, so they need no rewrite.
	const specific: Record<string, OldBlock> = {
		AuthBasic: 'basic',
		AuthBasicErrors: 'basic',
		AuthBasicOptions: 'basic',
		AuthBasicUser: 'basic',
		AuthCognito: 'cognito',
		AuthCognitoErrors: 'cognito',
		AuthCognitoOptions: 'cognito',
		AuthFlowType: 'cognito',
		CognitoUser: 'cognito',
		MFAPreference: 'cognito',
		AuthOIDC: 'oidc',
		AuthOIDCErrors: 'oidc',
		AuthOIDCErrorName: 'oidc',
		OIDCUser: 'oidc',
		google: 'oidc',
		customOidc: 'oidc',
		cognitoFederated: 'oidc',
		github: 'oidc',
		customOauth2: 'oidc',
		stubIdp: 'oidc',
	};
	return specific[name];
}

// ─── Methods ───────────────────────────────────────────────────────────────

/** Plain method renames on an `AuthCognito` instance (D3: G14, avoid `fetch`). */
export const COGNITO_METHOD_RENAMES: Readonly<Record<string, string>> = {
	fetchAuthSession: 'getAuthSession',
	fetchUserAttributes: 'getUserAttributes',
	fetchMFAPreference: 'getMfaPreference',
	fetchDevices: 'scanDevices',
	setUpTOTP: 'setUpTotp',
	verifyTOTPSetup: 'verifyTotpSetup',
	updateMFAPreference: 'updateMfaPreference',
};

/** `AuthOIDC` members with no `Auth` equivalent. */
export const OIDC_GONE_MEMBERS: Readonly<Record<string, string>> = {
	handleCallback: 'Auth serves the callback route itself (GET /aws-blocks/auth/callback); remove this call.',
	handleCallbackDispatch: 'Auth serves the callback route itself (GET /aws-blocks/auth/callback); remove this call.',
	handleExchange: 'Auth serves POST /aws-blocks/auth/exchange itself; remove this call.',
	getAuthorizeParams: 'Auth serves POST /aws-blocks/auth/authorize-params/<id> itself; remove this call.',
	refreshBearerTokens: 'Auth serves POST /aws-blocks/auth/exchange/refresh itself; remove this call.',
	signInRoutePath: 'Use getSignInUrl(context, provider) instead.',
	signInBasePath: 'Use getSignInUrl(context, provider) instead.',
	providers: 'Auth has no providers getter; the provider ids are the keys of oidcProviders / socialProviders.',
	callbackPath: 'Auth has no callbackPath getter; it is redirects.callbackPath in the options.',
	signOutPath: 'Auth has no signOutPath getter; it is redirects.signOutPath in the options.',
	postSignInPath: 'Auth has no postSignInPath getter; it is redirects.postSignInPath in the options.',
	allowBearerAuth: 'Auth has no allowBearerAuth getter.',
};

/** `confirmSignIn` object-response keys, all of which collapse to the plain string. */
export const CONFIRM_SIGN_IN_KEYS: ReadonlySet<string> = new Set([
	'code',
	'newPassword',
	'mfaType',
	'email',
	'password',
	'firstFactor',
	'credential',
]);

/** Old method names worth a TODO even when the receiver can't be resolved. */
export const DISTINCTIVE_OLD_METHODS: ReadonlySet<string> = new Set([
	...Object.keys(COGNITO_METHOD_RENAMES),
	'updateUserAttribute',
]);

// ─── Errors ────────────────────────────────────────────────────────────────

/** A renamed error-constant key. `split` marks one name that became two. */
export interface ErrorKeyRule {
	to: string;
	split?: string;
}

/**
 * `<Old>Errors.<key>` → `AuthErrors.<key>`, per block (C1's mapping table).
 * Keys absent here are kept as they are (Cognito's and OIDC's all are).
 */
export const ERROR_KEY_RULES: Readonly<Record<OldBlock, Readonly<Record<string, ErrorKeyRule>>>> = {
	basic: {
		InvalidCredentials: { to: 'NotAuthorized' },
		UserAlreadyExists: { to: 'UserAlreadyExists' },
		SessionExpired: { to: 'NotAuthenticated' },
		InvalidPassword: { to: 'InvalidPassword' },
		InvalidCode: {
			to: 'CodeMismatch',
			split: 'InvalidCodeException split in two: a wrong code is now CodeMismatchException (matched here), an expired or missing code is ExpiredCodeException (AuthErrors.ExpiredCode). Add that check if you handled expiry here.',
		},
	},
	cognito: {},
	oidc: {},
};

/** AuthBasic wire names → canonical wire names (for string literals). */
export const BASIC_STRING_RENAMES: Readonly<Record<string, ErrorKeyRule>> = {
	InvalidCredentialsException: { to: 'NotAuthorizedException' },
	UserAlreadyExistsException: { to: 'UsernameExistsException' },
	SessionExpiredException: { to: 'NotAuthenticatedException' },
	InvalidCodeException: { to: 'CodeMismatchException', split: ERROR_KEY_RULES.basic.InvalidCode?.split },
};

/** AuthOIDC's engine error, which split five ways (no mechanical rename). */
export const OIDC_ENGINE_ERROR = 'AuthOIDCEngineError';
export const OIDC_ENGINE_ERROR_TODO =
	'AuthOIDCEngineError is gone. It split into ProviderNotConfiguredException, InvalidStateException, InvalidCallbackException, IdpErrorException and TokenExpiredException: match the one(s) you meant.';

/** Every name an auth error check can mention — old and canonical. */
export const AUTH_ERROR_NAMES: ReadonlySet<string> = new Set([
	'NotAuthenticatedException',
	'NotAuthorizedException',
	'PasswordResetRequiredException',
	'TokenExpiredException',
	'ReauthenticationRequiredException',
	'UsernameExistsException',
	'UserNotConfirmedException',
	'UserNotFoundException',
	'AliasExistsException',
	'UnsupportedUserStateException',
	'InvalidPasswordException',
	'CodeMismatchException',
	'ExpiredCodeException',
	'InvalidParameterException',
	'MFAMethodNotFoundException',
	'SoftwareTokenMFANotFoundException',
	'EnableSoftwareTokenMFAException',
	'WebAuthnNotEnabledException',
	'WebAuthnOriginNotAllowedException',
	'WebAuthnRelyingPartyMismatchException',
	'WebAuthnChallengeNotFoundException',
	'WebAuthnCredentialNotSupportedException',
	'WebAuthnClientMismatchException',
	'WebAuthnConfigurationMissingException',
	'ProviderNotConfiguredException',
	'ProviderMisconfiguredException',
	'IdpErrorException',
	'InvalidStateException',
	'InvalidCallbackException',
	'InvalidRelayException',
	'SdkOutdatedException',
	'EmailPasswordNotEnabledException',
	'NoFederatedProviderException',
	'LimitExceededException',
	'TooManyRequestsException',
	'TooManyFailedAttemptsException',
	'ResourceNotFoundException',
	'InvalidLambdaResponseException',
	'UserLambdaValidationException',
	'InternalErrorException',
	'InvalidCredentialsException',
	'UserAlreadyExistsException',
	'SessionExpiredException',
	'InvalidCodeException',
	OIDC_ENGINE_ERROR,
]);

/** The review note every auth error check gets. */
export const ERROR_CHECK_TODO =
	'review this auth error check: Auth renamed some error names and changed which flows return which (see MIGRATION.md, "Error names").';

/** Functions whose calls are auth error checks. */
export const ERROR_CHECK_FUNCTIONS: ReadonlySet<string> = new Set(['hasAuthError', 'isBlocksError', 'isAuthError']);

// ─── Social providers (cognitoFederated) ──────────────────────────────────

/** `cognitoFederated({ identityProvider })` values that are Cognito social providers. */
export const SOCIAL_IDPS: Readonly<Record<string, 'google' | 'facebook' | 'amazon' | 'apple'>> = {
	Google: 'google',
	Facebook: 'facebook',
	LoginWithAmazon: 'amazon',
	SignInWithApple: 'apple',
};

// ─── Warnings repeated in the printed summary ─────────────────────────────

/** Printed once at the end of a run, for anything that can delete user data on deploy. */
export const SUMMARY_WARNINGS = {
	emailOtpOwnPool: [
		"WARNING: preferredChallenge 'EMAIL_OTP' (see the TODO). Do not wrap the block's own user pool with",
		'  userPool: Auth.fromExisting(<its pool id>) to keep it: that removes the pool from the stack, and the deploy',
		'  deletes it and every user in it. Drop preferredChallenge for the first deploy instead (MIGRATION.md, "AuthCognito").',
	],
} as const;

// ─── Standard TODO texts ──────────────────────────────────────────────────

export const TODOS = {
	authBasic: [
		'AuthBasic has no migration path to Auth. Existing users cannot sign in after this deploy and must sign up again.',
		'Export them first if you need them (MIGRATION.md, "AuthBasic"); the users / codes tables and the jwt-secret',
		'parameter are retained under BlocksPresets.production and deleted under BlocksPresets.sandbox.',
		'Sign-up now needs the emailed code (autoSignIn then signs the user in), Cognito sends at most 50 emails/day',
		'with its default sender, and the password policy now defaults to requiring upper/lower/digit/symbol.',
	],
	basicCodeDelivery:
		'codeDelivery is now local-only (npm run dev / tests). On AWS, Cognito emails the codes itself; this hook no longer runs there.',
	idNotRewritten: (name: string): string =>
		`the block id expression mentions ${name}; it was deliberately left unchanged. It must evaluate to exactly the same string as before, or the user pool is replaced. Inline the old value.`,
	optionsByReference:
		'options are passed by reference, so the codemod could not map them. Map each option by hand (MIGRATION.md, "Option mapping").',
	spreadOptions: 'spread into the options: map the spread object’s keys by hand (MIGRATION.md, "Option mapping").',
	unknownOption: (key: string): string =>
		`unknown option \`${key}\` was kept as is; map it by hand (MIGRATION.md, "Option mapping").`,
	providersNotArray:
		'`providers` is not an array literal, so the codemod could not key it. Rewrite it as oidcProviders / socialProviders records keyed by provider id.',
	providerNotFactory:
		'this provider is not an inline factory call, so the codemod could not key it. Add it to oidcProviders / socialProviders by hand.',
	providerName:
		'the provider name is not a string literal; it is used as a computed key. The record key is the provider id.',
	secretNotAppSetting:
		'provider secrets must be AppSetting references now (not strings or functions). Pass the AppSetting itself.',
	clientIdNotString:
		'clientId is now a plain string (it is not a secret). It was read from an AppSetting at runtime; paste the client id here.',
	domain: [
		'AuthOIDC federated through its own Cognito pool (child id `cognito-pool`); Auth uses `pool`, so the old pool and its',
		'shadow users are deleted on deploy, and users sign in once more. Auth derives a NEW domain prefix by default:',
		're-register https://<new prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse in every IdP console.',
		'To keep the old prefix instead, set hostedUi: { domainPrefix: <old cognitoDomain> } and deploy twice',
		'(MIGRATION.md, "AuthOIDC with cognitoFederated()") — a single deploy fails on the domain collision.',
	],
	cognitoFederatedRekey: [
		"users of this provider get a NEW userId: Auth's hosted-UI federation uses the Cognito username (cognito:username),",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: user-facing text naming the `${iss}:${sub}` id format, not a template
		'AuthOIDC cognitoFederated() used `${iss}:${sub}`. Re-key any data stored under the old userId',
		'(MIGRATION.md, "Re-keying cognitoFederated() users").',
	],
	apple: 'Sign in with Apple needs teamId, keyId and privateKey (an AppSetting with the .p8 key) instead of clientSecret.',
	socialRenamed: (from: string, to: string): string =>
		`the provider id changes from '${from}' to '${to}' (social provider ids are fixed): update signIn:${from} / getSignInUrl(…, '${from}') references.`,
	emailOtpNeedsSes: [
		"preferredChallenge 'EMAIL_OTP' needs a pool with an Amazon SES sender: Auth refuses it at synth on a pool it creates.",
		"WARNING: do NOT wrap this block's OWN pool with userPool: Auth.fromExisting(<its pool id>). The block then no longer",
		"owns `pool`, so it leaves the template, and this deploy DELETES the pool and every user in it (AuthCognito's pool was",
		"destroy unless removalPolicy: 'retain'). Nothing refuses that on the first Auth synth. For the first deploy, drop",
		'preferredChallenge (or pick another first factor), deploy, and commit aws-blocks/baselines/. To wrap an SES pool',
		'later, see MIGRATION.md ("AuthCognito") and the retain + cdk import runbook in the @aws-blocks/bb-auth DESIGN.md.',
	],
	authFlowUnsupported:
		"Auth supports authFlow 'USER_PASSWORD_AUTH' and 'USER_AUTH' only (AuthCognito rejected this value at synth too).",
	passkeysNeedRp: 'enablePasskeys needs a relying party: set passkeys: { relyingPartyId, origins }.',
	passkeysRpByRef:
		'webAuthnRelyingParty is not an object literal. Write passkeys: { relyingPartyId: <id>, origins: <origins>, userVerification? } by hand.',
	passkeysDisabledRp: 'webAuthnRelyingParty without enablePasskeys: true was ignored by AuthCognito and was dropped.',
	signInWithByRef: 'users.signInWith must be an array now; wrap this value if it is a single string.',
	passwordPolicyByRef:
		'AuthBasic passwordPolicy.requireSpecialChars is now requireSymbols; rename it in this object.',
	signUpAutoSignIn:
		'signUp() no longer takes autoSignIn: it is emailPassword.autoSignIn in the options (default true), and applies when a context is passed.',
	cognitoSession: 'signIn() no longer takes cognitoSession; remove it.',
	updateUserAttributeResult:
		'updateUserAttributes() returns a record keyed by attribute name (was a single outcome): read the outcome for this attribute from it.',
	updateUserAttributeByRef:
		'updateUserAttribute(ctx, name, value) is gone: call updateUserAttributes(ctx, { [name]: value }).',
	confirmSignInObject:
		'confirmSignIn() takes the answer as a plain string now (the code, new password, MFA type, …), not an object.',
	basicSignInResult:
		'signIn() now returns { status: "signedIn", user } or { status: "continueSignIn", nextStep } instead of the user.',
	buildApi: 'buildApi() is gone: export auth.createApi() and drive it with the Authenticator UI.',
	getClient:
		'getClient() is gone with AuthOIDC: federated sign-in buttons come from getAuthState() (signIn:<id> actions carry a url).',
	oidcUserField: (field: string): string =>
		`OIDCUser.${field} is gone: AuthenticatedUser has signInProvider, attributes (string claims), claims (iss, sub, …) and userId (still \`\${iss}:\${sub}\`).`,
	oidcUserClaims:
		'AuthenticatedUser.claims is optional now: it is set for users of a direct oidcProviders entry, and absent for user-pool users (a cognitoFederated() provider becomes one). Read it as claims?.x.',
	namespaceImport: 'namespace import of an old auth package: rename its members by hand (MIGRATION.md, "Names").',
	dynamicImport:
		'dynamic import of an old auth package: point it at @aws-blocks/bb-auth and rename its members by hand.',
	typeArguments: 'explicit type arguments on the old class: Auth<O> captures the options literal; drop them.',
	unknownReceiver: (method: string, to: string): string =>
		`if this is an AuthCognito instance, ${method}() is now ${to}().`,
	stubIdpDeployed: [
		'RISK: stubIdp() is local-only in Auth — synth refuses it unless it sets unsafeAllowDeployed. AuthOIDC served this stub',
		'from deployed stacks too, so the codemod kept that with unsafeAllowDeployed: true. A deployed stub signs ANYONE who',
		'can reach the app in as its users, with no credentials. Keep the flag only on a disposable test stack. For',
		'production, remove it and deploy the real provider instead (choose the provider by environment, so npm run dev',
		'keeps the stub) — MIGRATION.md, "stubIdp() is local-only".',
	],
	removedProviderFactory: (name: string): string =>
		`${name}() is gone in Auth: a generic OIDC provider is a plain { issuer, clientId, clientSecret? } entry in oidcProviders.`,
} as const;
