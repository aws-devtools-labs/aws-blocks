# 03 — Amazon Cognito capabilities & constraints

> **Purpose.** Establish precisely what Cognito can and cannot do, so a unified auth Building Block's API doesn't promise something the service won't deliver.
>
> **Scope.** Planning document for merging `bb-auth-basic` + `bb-auth-cognito` + `bb-auth-oidc` into one BB with Cognito as the sole backing service. No source was modified.
>
> **Verified.** 2026-09-22 against `docs.aws.amazon.com` (Cognito Developer Guide, CloudFormation Template Reference) and `aws.amazon.com/cognito/pricing`. Every non-obvious claim below carries a URL. Statements marked **[repo]** come from cross-checking the existing implementation and are *not* in AWS docs — treat those as empirically discovered and re-verify before relying on them.

---

## 0. Executive summary

### 0.1 The nine hard constraints that shape the API

| # | Constraint | Consequence for the unified BB |
|---|---|---|
| **H1** | **Federated sign-in cannot be driven through the SDK.** "You can't sign in federated users with API operations like `InitiateAuth` and `AdminInitiateAuth`… federated users can only sign in with the Login endpoint or the Authorize endpoint." | One coherent API across native + federated is **impossible at the transport level**. Native = request/response RPC; federated = browser redirect. The BB can unify the *shape* (see §3.4) but not the mechanism. |
| **H2** | **Federation requires a user-pool domain.** "If you want your users to sign in with federated providers, you must choose a domain." | Enabling OIDC in the unified BB provisions a `UserPoolDomain` — a new public internet endpoint, a new immutable-ish name, and a 60 s–5 min propagation delay. |
| **H3** | **Generic OIDC/SAML MAUs are priced separately with a 50-user free tier** ($0.015/MAU, flat across Lite/Essentials/Plus) vs **10,000 free** for direct + social. | A framework default that turns on generic OIDC federation starts billing at user 51. This is a 200× smaller free tier. See §7.2. |
| **H4** | **MFA does not apply to federated users at all.** "In the case of federated users, Amazon Cognito delegates all authentication processes to the IdP and doesn't offer them additional authentication factors." | The single most-cited reason to route OIDC *through* Cognito (managed MFA on social/enterprise sign-in) **is false**. §8.2. |
| **H5** | **Several user-pool properties are immutable at the service level while CloudFormation reports "No interruption."** `UsernameAttributes`/`AliasAttributes`, `UsernameConfiguration.CaseSensitive`, required attributes, and existing custom attributes. | CDK will happily synth the change, then `UpdateUserPool` rejects it → **stack rollback, not replacement**. The BB must refuse these changes at synth. §5.3. |
| **H6** | **Passwordless OTP and required MFA are mutually exclusive.** "You can't set MFA to required in user pools that support one-time passwords." | `mfa: 'required'` and `passwordless: 'emailOtp'` cannot both be options in one config object without a validated conflict. |
| **H7** | **`USER_AUTH` (choice-based) is the only flow with passwordless/passkeys, and it requires Essentials.** Passkeys are "available in all feature plans except **Lite**". | Passwordless is not a Lite-tier feature; the BB's default tier choice *is* a pricing decision. |
| **H8** | **Managed login is not usable on a CFN/SDK-created app client until a branding style exists.** "Managed login isn't available for an app client created with an AWS SDK until you create one with a `CreateManagedLoginBranding` request." | The CDK layer must emit `AWS::Cognito::ManagedLoginBranding` (or fall back to hosted-UI classic, `ManagedLoginVersion: 1`), otherwise federation silently 500s on a fresh deploy. |
| **H9** | **Cognito-as-relying-party requires a client secret and `client_secret_post`.** "Amazon Cognito doesn't support `client_secret_basic`." A client secret is a required field. | Any OIDC provider that only issues public/PKCE-only clients **cannot** be federated through Cognito. Direct-OIDC can handle those; Cognito cannot. |

### 0.2 Bad-fit verdict, up front

**Generic-OIDC-through-Cognito is strictly worse than talking to the OIDC provider directly, for the typical AWS Blocks user.** Evidence in §8. Summary: it costs money from the 51st user (H3), forces a hosted-UI redirect the app can't style without an Essentials-tier upgrade (H1/H2/H8), adds a third network hop, loses claims unless every claim is pre-declared as a mapped Cognito attribute (§2.4), cannot be mocked locally at all (§6), and delivers **none** of the security benefits usually claimed for it (H4).

**Cognito-native auth is a good fit** and is genuinely hard to replicate (password policy, MFA state machine, threat protection, account recovery, passkeys, SOC 2). **Cognito-as-an-OIDC-broker is the weak part of the story.** Recommendation in §10.

---

## 1. Cognito user pools as the engine

### 1.1 Authentication flows

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/authentication-flows-selection-sdk.html>, <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html>

Cognito splits flows into two families, and **the split is load-bearing for the API design**:

| Family | `AuthFlow` values | App-client flag | Notes |
|---|---|---|---|
| **Client-based** (app declares the method up front) | `USER_PASSWORD_AUTH`, `ADMIN_USER_PASSWORD_AUTH`, `USER_SRP_AUTH`, `REFRESH_TOKEN_AUTH`, `CUSTOM_AUTH` | `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_CUSTOM_AUTH`, … | `REFRESH_TOKEN_AUTH` and `CUSTOM_AUTH` are **only** available here. |
| **Choice-based** (app asks what's available) | `USER_AUTH` | `ALLOW_USER_AUTH` | **Requires Essentials tier or higher.** Only place passwordless + passkeys exist. |

Choice-based mechanics (exact names matter for the state machine):
- `InitiateAuth` with `AuthFlow: USER_AUTH` and only `USERNAME` → Cognito returns a `SELECT_CHALLENGE` challenge plus `AvailableChallenges`.
- With `PREFERRED_CHALLENGE` → Cognito either proceeds into that challenge, or returns `SELECT_CHALLENGE` + the available list if the preference isn't available for that user/pool/client.
- First-factor challenge names: `PASSWORD`, `PASSWORD_SRP`, `EMAIL_OTP`, `SMS_OTP`, `WEB_AUTHN`.
- Pool-level gating is `Policies.SignInPolicy.AllowedFirstAuthFactors: ["PASSWORD","WEB_AUTHN","EMAIL_OTP","SMS_OTP"]`. `PASSWORD` is always required in that list.
- `GetUserAuthFactors` (access-token authorized) reports a signed-in user's available factors + MFA settings — useful for a "security settings" screen.
- Equivalences: `USER_PASSWORD_AUTH` ≡ `PASSWORD`; `USER_SRP_AUTH` ≡ `PASSWORD_SRP`.

Default app-client flows when `ExplicitAuthFlows` is omitted: `ALLOW_REFRESH_TOKEN_AUTH`, `ALLOW_USER_SRP_AUTH`, `ALLOW_CUSTOM_AUTH` (<https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpoolclient.html>) — note this default does **not** include password auth, so the BB must set it explicitly.

Useful nuance: `ALLOW_USER_AUTH` "can do username-password and SRP authentication without other `ExplicitAuthFlows` permitting them" — so a single `ALLOW_USER_AUTH` grant covers password + SRP + passwordless + passkey, but **not** `CUSTOM_AUTH`.

**Custom auth (`CUSTOM_AUTH`)** uses the `DefineAuthChallenge` / `CreateAuthChallenge` / `VerifyAuthChallengeResponse` Lambda triad. Critical incompatibility: **"Amazon Cognito managed login doesn't support custom authentication with custom authentication challenge Lambda triggers"** (<https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html>). Since federation *requires* managed login (H2), **custom auth and federation cannot coexist in one app client's UI**.

**[repo]** `bb-auth-cognito` implements `USER_PASSWORD_AUTH` + `USER_AUTH` + `REFRESH_TOKEN_AUTH` and deliberately throws at **both** synth and runtime construction for `USER_SRP_AUTH`/`CUSTOM_AUTH` (`packages/bb-auth-cognito/src/index.cdk.ts:82-94`, mirrored at `src/index.aws.ts:630-641`). The double-throw exists so a `fromExisting()` pool can't bypass the synth guard. Worth carrying into the merged BB verbatim. It also sets `adminUserPassword: false` (`index.cdk.ts:256`) — never uses the `Admin*Auth` variants.

### 1.2 Sign-up, verification, password policy, recovery

- **Email/phone verification**: `AutoVerifiedAttributes`; codes valid **24 h** for sign-up confirmation and attribute verification; forgot-password codes valid **1 h**.
- **Password policy**: `Policies.PasswordPolicy` — `MinimumLength` (service range **6–99**), `RequireLowercase/Uppercase/Numbers/Symbols`, `TemporaryPasswordValidityDays`, and `PasswordHistorySize` (**Essentials+** only — "Prevent use of previous passwords"). Max password length **256 chars**.
- **Account recovery**: `AccountRecoverySetting.RecoveryMechanisms` with priorities (`verified_email`, `verified_phone_number`, `admin_only`).
- **Recovery ↔ MFA interlock (a real API-design trap).** "Users can't receive MFA and password reset codes at the same email address or phone number." A user with only an email attribute, email MFA enabled, and email-only recovery **cannot reset their password** — Cognito returns `InvalidParameterException`. Docs recommend making both `email` and `phone_number` required to avoid the dead state. The unified BB should validate this combination at synth.
- Per-user hourly caps (non-adjustable): `ForgotPassword`+`ConfirmForgotPassword` **5–20/user/hr** (risk-dependent), `ResendConfirmationCode` **5**, `ConfirmSignUp` **15**, `ChangePassword` **5**, `GetUserAttributeVerificationCode` **5**, `VerifyUserAttribute` **15**.

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html>, <https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html>

### 1.3 MFA

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html>

| Method | `EnabledMfas` | Tier | Prerequisite |
|---|---|---|---|
| TOTP (authenticator app) | `SOFTWARE_TOKEN_MFA` | Lite+ | — |
| SMS | `SMS_MFA` | Lite+ | `SmsConfiguration` (SNS caller role + external ID); SNS sandbox exit for production |
| Email | `EMAIL_OTP` | **Essentials+** | `EmailConfiguration.EmailSendingAccount = DEVELOPER` (**your own SES**) |

- `MfaConfiguration`: `OFF | ON | OPTIONAL`. With `OPTIONAL`, "managed login doesn't automatically prompt users to set up MFA" — the app must build the enrollment UI.
- **`SMS_MFA` is one-way-ish**: "After you enable `SMS_MFA`, you can only disable it by setting `MfaConfiguration` to `OFF`" (CFN `EnabledMfas` doc).
- Challenge names the state machine must handle: `SMS_MFA`, `SOFTWARE_TOKEN_MFA`, `EMAIL_OTP`, `SELECT_MFA_TYPE` (with `MFAS_CAN_SELECT`), `MFA_SETUP` (with `MFAS_CAN_SETUP`), `NEW_PASSWORD_REQUIRED`.
- TOTP enrollment: `AssociateSoftwareToken` → `VerifySoftwareToken` → `RespondToAuthChallenge(MFA_SETUP)`.
- MFA code validity **3–15 min**; **after 5 failed MFA codes** Cognito starts an exponential-timeout lockout.
- **Threat protection (Plus) requires `MfaConfiguration: OPTIONAL`** — adaptive auth can't escalate to MFA if MFA is already `ON`.
- **H4 again:** federated users get no MFA from Cognito. Also "Third-party IdPs must separately manage devices and MFA for their users."

**[repo]** `bb-auth-cognito` already discovered the SES requirement and throws at synth: `index.cdk.ts:134-138` — *"AWS Cognito requires Email MFA to be backed by SES (Cognito's internal sender has a 50-msg/day quota and Cognito's own validator rejects it for Email MFA)."* AWS docs confirm both halves: the tier+SES requirement, and the 50/day figure — though the docs say the quota is **"Email messages sent daily per AWS account: 50"**, i.e. *account-wide*, not per pool. That is worse than the repo comment implies and should be documented in the merged README.

### 1.4 Passwordless

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html>

| Capability | GA? | Tier | Flow | Hard constraints |
|---|---|---|---|---|
| **Email OTP** (`EMAIL_OTP` first factor) | GA | **Essentials+** | `USER_AUTH` only | Requires your own SES (`DEVELOPER`). Incompatible with required MFA (H6). |
| **SMS OTP** (`SMS_OTP`) | GA | **Essentials+** | `USER_AUTH` only | Requires SNS config + sandbox exit. Incompatible with required MFA (H6). |
| **Passkeys / WebAuthn** (`WEB_AUTHN`) | GA | **all plans except Lite** | `USER_AUTH` only | See below. |

Verbatim: *"Passwordless sign-in doesn't have a client-based `AuthFlow`… OTP authentication is only available in the choice-based `AuthFlow` of `USER_AUTH`."* And: *"Passkeys are an opt-in feature that's available in all feature plans except **Lite**. It is only available in the choice-based authentication flow."*

**Region availability.** AWS docs for these features contain no region-exclusion table; availability tracks the feature plans, which are region-wide. The one real regional dependency is **SES** for email OTP/MFA — and Cognito's SES-region mapping is genuinely awkward: some Cognito regions are "In-Region only," some "Backwards compatible" (may also use us-east-1/us-west-2/eu-west-1), and some are "Alternate Region" where SES isn't available at all and you must verify an identity in a *different* region and grant `cognito-idp.<pool-region>.amazonaws.com` permission on it. Full table: <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html>. **The unified BB cannot auto-wire SES portably** — this must be a customer-supplied input.

Passkey constraints (all from the auth-flows page, load-bearing):
- **"They can only register a passkey after they have signed in to your user pool at least once."** So a passkey can never be a *first* credential — signup always needs another factor first.
- **Max 20 passkeys per user** (non-adjustable quota).
- **RP ID choice is effectively permanent**: *"If you change your RP ID, your users must register again with the new RP ID."* Default RP ID is your custom domain if you have one, else your prefix domain; can be any non-public-suffix domain.
- **Adding a custom domain silently breaks existing passkeys**: CFN `CustomDomainConfig` doc — *"When you create a custom domain, the passkey RP ID defaults to the custom domain. If you had a prefix domain active, this will cause passkey integration for your prefix domain to stop working due to a mismatch in RP ID."*
- Passkeys are **not** a second factor to a password: *"Passkeys cannot be used as a second factor to password sign-in."* They can *satisfy* MFA when `WebAuthnFactorConfiguration = MULTI_FACTOR_WITH_USER_VERIFICATION`.
- **Passkey sign-in is not available in the classic hosted UI** — only managed login (branding v2) or the SDK.
- Passkey APIs: `StartWebAuthnRegistration`, `CompleteWebAuthnRegistration`, `ListWebAuthnCredentials`, `DeleteWebAuthnCredential`.

**[repo]** `bb-auth-cognito` already gates all of this at synth: throws on `featurePlan: 'lite'` + `enablePasskeys`, and requires `webAuthnRelyingParty: {id, origins}` with no default because *"an incorrect rpId silently breaks every browser prompt at the authenticator layer"* (`index.cdk.ts:100-122`). It also records a CFN naming trap: the passkey RP config maps to **top-level** `WebAuthnRelyingPartyId`/`WebAuthnUserVerification`, not a `WebAuthnConfiguration` envelope — *"that name was used in some early docs but Cognito rejects it on `CreateUserPool`"* (`index.cdk.ts:214-219`). The current CFN reference confirms the top-level properties.

### 1.5 Device tracking

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-device-tracking.html>

- `DeviceConfiguration`: `ChallengeRequiredOnNewDevice`, `DeviceOnlyRememberedOnUserPrompt` → console's Always / User-opt-in / Don't-remember. No tier gating found in the features table.
- **Device auth only replaces the MFA challenge**: *"Device authentication only replaces the MFA-authentication challenge with a device-authentication challenge. You can't sign users in with device authentication only."* And: *"Remembered devices can override MFA only in user pools with MFA active."*
- Requires a full client-side SRP implementation: `ConfirmDevice` with a device-specific salt + password verifier, then `DEVICE_SRP_AUTH` → `DEVICE_PASSWORD_VERIFIER` challenges with HMAC/HKDF math. This is real crypto work in the BB.
- **Not available via managed login**: *"managed login automatically adds device information to advanced security user logs, and doesn't offer to remember devices."*
- **Not available for federated users**: *"Third-party IdPs must separately manage devices and MFA for their users."*
- Interacts with refresh: with device remembering active, *"you must provide the device key in `GetTokensFromRefreshToken` requests."*

**[repo]** `bb-auth-cognito`'s AWS runtime throws 501 for `rememberDevice` — *"it requires `NewDeviceMetadata` capture and a device SRP verifier"* (`index.aws.ts:1902-1905`) — while the mock mints a synthetic device key. This is a mock↔AWS parity break that should be resolved (either implement or remove) rather than carried forward.

### 1.6 Tokens and refresh

Sources: <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html>, <https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html>

| Artifact | Default | Configurable range |
|---|---|---|
| ID token | 1 hour | 5 min – 1 day |
| Access token | 1 hour | 5 min – 1 day |
| Refresh token | **30 days** | 1 hour – **3,650 days** (CFN: 60 min – 10 years) |
| Auth challenge session (`AuthSessionValidity`) | 3 min | 3 – 15 min |
| Managed login / hosted UI session cookie | **1 hour, fixed** | not configurable |
| Authorization code | 5 min | fixed |

- Tokens are RS256-signed; JWKS at `https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/jwks.json`. Refresh tokens are **encrypted and opaque** — you cannot inspect them.
- **Refresh token rotation** (Essentials+ per the pricing page) is configured per app client (`RefreshTokenRotation: {Feature, RetryGracePeriodSeconds ≤ 60}`). **It is incompatible with `REFRESH_TOKEN_AUTH`**: *"Refresh token rotation isn't compatible with the authentication flow `REFRESH_TOKEN_AUTH`. To implement refresh token rotation, you must disable this authentication flow in your app client and design your application to submit token-refresh requests with the `GetTokensFromRefreshToken` API operation."* → The unified BB must pick one refresh code path based on a CDK-time flag, or always use `GetTokensFromRefreshToken`.
- Without rotation, a refresh returns new ID + access tokens only and the original refresh token stays valid. With rotation, all three rotate and the new refresh token inherits the **remaining** lifetime of the original.
- Enabling rotation **adds `origin_jti` and `jti` claims**, increasing token size — relevant if tokens ride in a cookie.
- **Federated refresh works but does not re-contact the IdP.** Cognito issues its own refresh tokens for federated users; refreshing them yields new Cognito tokens without any IdP round-trip. Practical consequence: **disabling or deleting a user at the upstream IdP does not invalidate their Cognito session** for up to the refresh-token lifetime. Revocation must be done against Cognito (`RevokeToken`, `GlobalSignOut`, `AdminUserGlobalSignOut`).
- **Hosted-UI sessions and API sessions are separate**: *"Token refresh in custom applications doesn't affect managed login sessions… The `GetTokensFromRefreshToken` response issues new ID, access, and optionally refresh tokens, but doesn't renew the managed login session cookie."* And after `GlobalSignOut`, *"because managed login session cookies don't expire automatically, your user can re-authenticate with a session cookie, with no additional prompt for credentials."* → **Sign-out must hit `/logout` as well as the API**, or the user is not actually signed out. This is a security-relevant API-design requirement.

**[repo]** `bb-auth-cognito` verifies tokens once at sign-in with `aws-jwt-verify` then issues its own HMAC-signed opaque session cookie pointing at a `KVStore` `SessionRecord{idToken, accessToken, refreshToken}` (`DESIGN.md:60-78`). It exposes **no** token-lifetime options at all and never configures `RefreshTokenValidity` — session lifetime is purely the BB's own 400-day cookie/TTL. It also documents a real parity gap: `revokeUserSessions` on AWS uses `AdminUserGlobalSignOut`, which revokes refresh tokens only, so an already-issued access token stays valid until expiry and `checkAuth` doesn't flip immediately; the mock deletes the record and flips immediately (`DESIGN.md:91`). AWS docs corroborate the AWS-side behavior. **This architecture ports unchanged and is the biggest reuse win** — it is independent of which flow produced the tokens, including federation.

---

## 2. Federation

### 2.1 Supported provider types

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation.html>

`CreateIdentityProvider` `ProviderType` ∈ { `SAML`, `OIDC`, `Google`, `Facebook`, `LoginWithAmazon`, `SignInWithApple` }. All are available in **all feature plans** ("Sign-in with social, SAML, and OIDC providers: Lite + Essentials + Plus").

**Billing split matters more than the type split**: the four named social providers bill as ordinary MAUs (10,000 free); `OIDC` and `SAML` bill as enterprise MAUs (**50 free**). See §7.2.

### 2.2 Generic OIDC — required configuration

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html>

Required in `ProviderDetails`:
- `client_id` — **required**
- `client_secret` — **required** (no public-client / PKCE-only option — H9)
- `authorize_scopes` — space-delimited; `openid` mandatory; `email` needed for `email`/`email_verified`; `profile` for all attributes; `phone` for phone claims
- `attributes_request_method` — `GET` or `POST`, because "IdPs might require that requests to their `userInfo` endpoints are formatted as either `GET` or `POST`"
- **Either** `oidc_issuer` (auto-discovery via `/.well-known/openid-configuration`) **or** manual `authorize_url` / `token_url` / `attributes_url` / `jwks_uri`

IdP-side prerequisites, quoted:
- *"Supports `client_secret_post` client authentication. Amazon Cognito doesn't check the `token_endpoint_auth_methods_supported` claim… Amazon Cognito doesn't support `client_secret_basic`."*
- *"Only uses HTTPS for OIDC endpoints"*; *"Only uses TCP ports 80 and 443"*
- *"Only signs ID tokens with HMAC-SHA, ECDSA, or RSA algorithms"*
- *"Publishes a key ID `kid` claim at its `jwks_uri` and includes a `kid` claim in its tokens"*
- Non-expired public key with a valid root CA chain
- Issuer URL must start `https://`, must not end in `/`
- The IdP app must register `https://<your-domain>/oauth2/idpresponse` as its callback URL

### 2.3 What Cognito does and doesn't support as an OIDC client

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-flow.html>

Cognito → IdP (Cognito as relying party):
- Authorization-code grant, confidential client, `client_secret_post`.
- **No documented PKCE toward the upstream IdP.** The flow description lists no `code_challenge`; combined with the mandatory client secret, assume Cognito does not use PKCE as an RP. Do not promise it.
- **No `nonce` guarantee surfaced to your app.** Cognito validates the IdP ID token itself (see below) but does not forward a nonce you control.
- `prompt` forwarding: *"Amazon Cognito forwards all values of `prompt` except `none` to your IdPs"*; `select_account` and `consent` have "no effect on local sign-in and must be submitted in requests that redirect to IdPs."
- `login_hint` forwarding: **OIDC IdPs only** — *"You can't forward login hints to SAML, Apple, Login With Amazon, Google, or Facebook (Meta) IdPs."*
- ID-token validation Cognito performs: signature algorithm ∈ {RSA, HMAC, EC}; `kid` present at `jwks_uri`; signature match; `iss` == configured issuer; `aud` contains the configured client ID; `exp` in the future. It **refreshes the JWKS on every IdP ID token it processes**.
- Access token: *"Amazon Cognito doesn't independently validate the access token. Instead, it requests user-attribute information from the provider `userInfo` endpoint and expects the request to be denied if the token isn't valid."*
- **Cognito never gives you the IdP's tokens**: *"Your user pool doesn't pass these tokens on to your user or your app."* (Workaround: map `id_token`/`access_token` to a custom attribute — but only if under 2,048 chars; see §2.4.)
- Max **20 HTTP redirects** between Cognito and the IdP.
- Auth sessions are cancelled after **5 minutes**.
- IdP-side error surfacing is coarse — everything becomes a redirect to your callback with `error=invalid_request&error_description=...` (e.g. `Timeout+occurred+in+calling+IdP+token+endpoint`, `Timeout+in+calling+jwks+uri`, `[IdP name]+Error+-+[status code]+error getting token`). You cannot distinguish IdP misconfiguration from IdP downtime programmatically.

Your app → Cognito (Cognito as OP): PKCE **is** supported, `S256` only — *"the PKCE RFC defines two methods, S256 and plain; however, Amazon Cognito authentication server supports only S256."* Custom scopes via resource servers are supported. `prompt=none|login` supported, **"Available in the managed login branding version only, not in the classic hosted UI."** `resource` (RFC 8707 audience binding) supported. Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html>

### 2.4 Attribute mapping — the gotchas

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-specifying-attribute-mapping.html>

1. **Every required pool attribute must have a mapping**, or federated sign-in fails.
2. **Mapped emails are unverified by default**: *"By default, mapped email addresses are unverified. You can't verify a mapped email address using a one-time code."* You must map `email_verified` from the IdP.
3. **Target custom attributes must be `Mutable`**: *"If your IdP sends a value for a mapped immutable attribute, Amazon Cognito returns an error and sign-in fails."* And mapping to an **immutable** attribute means the user *can only ever sign in once* — the docs spell this out explicitly.
4. **The app client must have write access to every mapped attribute** (`WriteAttributes`), *"otherwise Amazon Cognito doesn't set the attribute value and proceeds with authentication"* — i.e. **silent claim loss**, no error. The CFN `WriteAttributes` doc is blunter: *"this array must include all attributes that you have mapped to IdP attributes… Amazon Cognito throws an error when it tries to update the attribute."*
5. **2,048-byte ceiling per attribute.** *"Amazon Cognito doesn't support mapping IdP tokens to custom attributes when the tokens are more than 2,048 characters long."* Real ID tokens from enterprise IdPs routinely exceed this.
6. **Multi-valued claims are mangled**: Cognito *"flattens all values into a single comma-delimited string enclosed in the square-bracket characters `[` and `]`"* and URL-encodes non-alphanumerics except `. - * _`. **You must decode and parse yourself.** Group/role claims are the common casualty.
7. **Stale claims are never removed**: *"Amazon Cognito doesn't remove attributes from users when the source attribute is no longer sent."* Workaround is a Pre-Authentication Lambda that deletes the attribute so it repopulates.
8. **Only mapped claims survive.** Unmapped claims are silently dropped — there is no passthrough. Every claim the app wants must be pre-declared as a pool attribute (≤ 50 custom attributes, name ≤ 20 chars). **This is the structural claim-fidelity loss versus direct OIDC**, where the app reads the raw ID token.
9. **`sub` → `username` is automatic and prefixed**: `MyOIDCIdP_<sub>`. Not overridable; map to `preferred_username` if you need a clean value.

### 2.5 How federated identities appear in the pool

- A **local profile is auto-created** on first federated sign-in, `username` = `<IdPName>_<sub>` (OIDC/Google/Apple), `<IdPName>_<id>` (Facebook), `<IdPName>_<user_id>` (LWA), `<IdPName>_<NameID>` (SAML).
- **Case-insensitive pools lowercase the entire username, including the IdP prefix.** And: *"To link your IdP to a user pool with a different case-sensitivity setting than your current pool, create a new user pool."*
- User status is `EXTERNAL_PROVIDER`.
- An `identities` attribute + ID-token claim records `{userId, providerName, providerType, issuer, primary, dateCreated}`. **"You can't change the `identities` attribute in a user profile directly."**
- Cognito **auto-creates a group per IdP**, named `<userPoolId>_<IdPName>`, and auto-adds each generated federated profile. Linked users are *not* auto-added. This pollutes `cognito:groups` — if the BB surfaces groups as app roles, IdP groups will leak in.
- `UpdateIdentityProvider` changes take **up to a minute** to appear in managed login.
- IdP name limit: **32 characters**.

### 2.6 `AdminLinkProviderForUser` — linking to a native user

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation-consolidate-users.html>

- Must be done **before the federated user's first sign-in** — "in a planned prestaging task or in a Pre sign-up Lambda trigger." **"To link a federated user who has previously signed in, you must first delete their existing profile."** There is no repair path short of deletion.
- Max **5 linked identities per user**, and max **5 distinct source attribute names per IdP**.
- Attribute-based linking (`ProviderAttributeName: email`) is **OIDC/SAML only**; social providers must use `ProviderAttributeName: Cognito_Subject`.
- **Not available in the console** — API only.
- Reversible via `AdminDisableProviderForUser`.
- **Security warning, verbatim:** *"Because `AdminLinkProviderForUser` allows a user with an external federated identity to sign in as an existing user in the user pool, it is critical that it only be used with external IdPs and provider attributes that have been trusted by the application owner."* A naive "link by email" implementation is an **account-takeover primitive** if the IdP doesn't verify emails. The unified BB must not offer auto-link-by-email as a default.
- **Billing consequence**, from the quotas page: *"When you link federated users to local users, with SAML or OIDC federation, the local user will count as an enterprise directory MAU or `EnterpriseMAU`, regardless of whether the user signs in directly or via federation."* → **Linking permanently promotes a $0-in-free-tier native user to a $0.015 enterprise MAU, even for native password sign-ins.**
- Setting a password on a federated profile (`AdminSetUserPassword`) flips status `EXTERNAL_PROVIDER` → `CONFIRMED` and enables API flows — but the docs say *"As a best security practice… don't set passwords on federated user profiles."*

### 2.7 What you cannot do with a federated user via the pool APIs

- **Sign them in** — H1. `InitiateAuth`/`AdminInitiateAuth` are unavailable.
- **Give them MFA** — H4.
- **Give them device tracking** — §1.5.
- **Let them use password APIs** — `ChangePassword`, `ForgotPassword` are meaningless without a password (unless you `AdminSetUserPassword`, which the docs advise against).
- **Edit `identities`** directly.
- **Register a passkey** — passkey registration requires an authenticated session established through the pool; for a federated user the pool has no first factor of its own to enroll against.
- **Recover the IdP's tokens** — §2.3.

---

## 3. Hosted UI / Managed Login vs. API-driven

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html>

### 3.1 The two branding versions

| | Classic hosted UI (`ManagedLoginVersion: 1`) | Managed login (`ManagedLoginVersion: 2`) |
|---|---|---|
| Tier | **Lite+** — *"In the Lite feature plan, the classic hosted UI is your only option for user pool domain services."* | **Essentials+** — *"The Essentials plan is the lowest plan level that unlocks access to managed login."* |
| Customization | File-based: upload a logo + a CSS file with predetermined properties | Visual **branding editor**: light/dark/adaptive, background images, per-component styles |
| Passkey sign-in | ❌ *"passkey sign-in isn't available in the classic hosted UI"* | ✅ |
| `prompt` param | ❌ *"Available in the managed login branding version only"* | ✅ |
| Localization (`lang`) | ❌ | ✅ (12 languages; requires Essentials+ **and** managed-login branding) |
| TLS | 1.2 not required for custom domains | 1.2 required for both prefix and custom domains |

Switching branding version: allowed, takes up to 4 min, and **"Amazon Cognito doesn't maintain user sessions. They must sign in again with the new interface."**

### 3.2 Why federation *requires* the hosted endpoints

Mechanically: the federated flow is a browser redirect chain — your app → Cognito `/oauth2/authorize` → IdP `/authorize` → IdP login → IdP redirects to Cognito `/oauth2/idpresponse` with a code → Cognito exchanges it at the IdP `/token`, fetches `jwks_uri`, validates, calls `userInfo`, applies attribute mapping, creates/updates the local profile, then redirects to **your** callback with a Cognito authorization code, which you exchange at Cognito `/oauth2/token`.

Every step after the first lives on the user-pool domain. There is no server-to-server equivalent, and AWS states it outright (H1). You *can* skip the Cognito-branded login page for a known provider by passing `identity_provider=<name>` or `idp_identifier=<id>` to `/oauth2/authorize` — *"it silently redirects your user to the sign-in page for that identity provider"* — but the **domain and the redirect are still mandatory**. You are only skipping the visual page, not the hosted endpoints.

### 3.3 Practical constraints on the hosted path

- **Managed login needs a branding style to exist for SDK/CFN-created app clients** (H8). CDK must emit `AWS::Cognito::ManagedLoginBranding` or pin `ManagedLoginVersion: 1`.
- **Callback URLs must be pre-registered** — max 100 per app client; `redirect_uri` must match exactly; no fragment; HTTPS except `http://localhost`, `http://127.0.0.1`, `http://[::1]`; custom schemes (`myapp://`) allowed.
- **No custom CORS**: *"Neither managed login nor the hosted UI support custom cross-origin resource sharing (CORS) origin policies."*
- **Cookie-dependent**: sets `XSRF-TOKEN`, `csrf-state`, `csrf-state-legacy`, `cognito`, `lang`, `page-data`. iOS "block all cookies" **breaks it entirely** — docs say build with an SDK instead in that case.
- **1-hour non-renewing session cookie**, and sign-out is not real until `/logout` is hit (§1.6).
- **No self-service profile management**: *"Managed login doesn't support user self-service profile management like attribute changes and setting of MFA preference. You must implement profile management in your own application code."* → even with the hosted UI, the BB still needs API-driven code for the rest of the surface.
- Prefix domain: up to 60 s to become available. Custom domain: up to 5 min, needs ACM cert in **us-east-1** and a DNS alias to a CloudFront distribution; max **4 custom domains per region**.
- **Custom auth Lambda triggers are unsupported in managed login** (§1.1).
- Hosted-endpoint rate limits (all non-adjustable): 300 RPS per source IP per domain, 300 RPS per app client per domain, 500 RPS per domain, 50,000 RPS for `jwks.json` per account per region.

### 3.4 What this means for "one coherent API"

The honest answer: **the BB can unify the *data shape* but not the *control flow*.**

- Native flows are `Promise`-returning RPC methods: `signIn()` → `{ nextStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' }` → `confirmSignIn()` → done.
- Federated flow is: return a **URL** the browser must navigate to, then handle a callback route, then exchange a code.

**[repo]** `auth-common` already solved exactly this with its "Unified Form Model": an `AuthAction` carries either internal `fields` (native form) or a `url` + `method` (redirect), so `<Authenticator>` renders "Sign in with Okta" as a sibling of the password form with no special-casing (`packages/auth-common/DESIGN.md:26-33`). **This is the right abstraction and the merged BB should preserve it.** It is the only place the two mechanisms genuinely converge.

---

## 4. Identity pools — not needed

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/identity-pools.html>, <https://aws.amazon.com/cognito/pricing/>

An identity pool does exactly one thing user pools don't: **vend temporary AWS credentials** (`GetId` → `GetCredentialsForIdentity`, or `AssumeRoleWithWebIdentity` in basic flow) to browser/mobile clients, plus guest (unauthenticated) identities, role-based access control by claim rules, and principal-tag ABAC.

**They are not required for user-pool authentication**, and they are **free**: *"Use of Amazon Cognito identity pools for authenticating users and generating unique identifiers is provided at no charge."*

**Recommendation: do not add one.** AWS Blocks is a server-rendered / Lambda-backed framework — the Lambda has an IAM role, so there is nothing for credential vending to solve. Costs of adding one: a second resource with its own IdP trust config, two auth flows (basic vs enhanced), role-mapping rules (max 25, max 10 IdPs with role mappings), a second set of quotas (`GetId` 25 RPS, `GetCredentialsForIdentity` 200 RPS), and a `Warning` in the docs that *"Changing the linked IdP application ID in your identity pool prevents existing users from authenticating."* Also note `Custom developer provider` is immutable: *"If you configure a Custom developer provider, you can't modify or delete it after you create your identity pool."*

**[repo]** Both existing BBs already reached this conclusion: *"Blocks uses User Pools only, not Identity Pools; to call AWS from the browser, use the Lambda's IAM role rather than vending temporary credentials to the client"* (`packages/bb-auth-cognito/DESIGN.md:38`). Keep that decision and keep `credentials`/`identityId` absent from the session type.

---

## 5. Hard limits, quotas, and immutability

### 5.1 Resource quotas

Source: <https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html>

| Resource | Quota | Adjustable | Max |
|---|---|---|---|
| App clients per user pool | 1,000 | Yes | 10,000 |
| User pools per region | 1,000 | Yes | 10,000 |
| **Identity providers per user pool** | **300** | Yes | 1,000 |
| Users per user pool | 40,000,000 | Yes | contact AWS |
| Resource servers per user pool | 25 | Yes | 300 |
| **Custom attributes per user pool** | **50** | **No** | — |
| **Characters per attribute** | **2,048 bytes** | **No** | — |
| **Characters in custom attribute name** | **20** | **No** | — |
| Password policy minimum length | 6–99 | No | — |
| Characters in password | 256 | No | — |
| **Characters in IdP name** | **32** | **No** | — |
| **Identities linked to a user** | **5** | **No** | — |
| **Passkeys per user** | **20** | **No** | — |
| Callback URLs / Logout URLs per app client | 100 each | No | — |
| Identifiers per identity provider | 50 | No | — |
| Scopes per app client / per resource server | 50 / 100 | No | — |
| Custom domains per region | 4 | No | — |
| Managed login branding styles per user pool | 20 | No | — |
| Groups per user pool / per user | 10,000 / 100 | No | — |
| **Email messages daily per AWS account** (default sender) | **50** | **No** | — |
| Pre-token-generation total claim changes | 5,000 | Yes | contact AWS |
| Characters in a SAML response | 100,000 | No | — |

### 5.2 Rate limits — note which are *not* raisable

Category quotas are **pooled across all user pools in one account+region**. Per-user caps: 10 read ops/user/sec, 10 write ops/user/sec.

| Category | Default RPS | Adjustable | Key operations |
|---|---|---|---|
| `UserAuthentication` | 120 | **Yes** | `InitiateAuth`, `RespondToAuthChallenge`, `GetTokensFromRefreshToken`, hosted-UI sign-in |
| `UserCreation` | 50 | **Yes** | `SignUp`, `ConfirmSignUp`, `AdminCreateUser` |
| **`UserFederation`** | **25** | Yes | IdP responses at the federation endpoint — *"OIDC or social provider operations that result in an IdP token, and all SAML requests"* |
| **`UserAccountRecovery`** | **30** | **NO** | `ForgotPassword`, `ConfirmForgotPassword`, `ChangePassword`, `AdminSetUserPassword` |
| `UserRead` | 120 | Yes | `GetUser`, `AdminGetUser` |
| **`UserUpdate`** | **25** | **NO** | `UpdateUserAttributes`, **`AdminLinkProviderForUser`**, `GlobalSignOut`, `AdminDeleteUser`, group add/remove |
| **`UserResourceUpdate`** | **25** | **NO** | `SetUserMFAPreference`, `AssociateSoftwareToken`, `VerifySoftwareToken`, `ConfirmDevice` |
| **`UserList`** | **30** | **NO** | `ListUsers`, `ListUsersInGroup` |
| **`UserPoolResourceUpdate`** | **15** (and **5 RPS per pool per individual op**) | **NO** | **`CreateIdentityProvider`**, `CreateUserPoolDomain`, `SetUserPoolMfaConfig`, `CreateGroup` |
| `UserPoolUpdate` | 15 | **NO** | `CreateUserPool`, `UpdateUserPool` |
| `UserToken` | 120 | Yes | `RevokeToken` |
| `ClientAuthentication` | 150 | **NO** | M2M `client_credentials` |

Special handling: `RespondToAuthChallenge` gets **3× the `UserAuthentication` quota**; overflow beyond three challenge responses counts against the base category.

**Design implications.**
1. **`UserUpdate` at 25 RPS, non-adjustable**, is the tightest constraint on any feature that writes user attributes per-request. Do not put attribute writes in a hot path. Rule 2 of AGENTS.md ("persist state only through BBs") pushes toward `KVStore` for app state anyway — reinforce that: **do not use Cognito custom attributes as an app database.** AWS says the same: *"Use an external database for frequently updated attributes."*
2. **`UserResourceUpdate` at 25 RPS, non-adjustable**, caps MFA enrollment throughput.
3. **`UserAccountRecovery` at 30 RPS, non-adjustable**, caps password resets — relevant during an incident.
4. `CreateIdentityProvider` is capped at **5 RPS per pool** — fine for deploy-time, fatal for any runtime/dynamic IdP registration design.
5. Quota increases are **paid** (≈ $20 per RPS-month), regional, and require `UpdateProvisionedLimit` after Service Quotas approval.

### 5.3 Immutability — the CDK update-vs-replace matrix

**This is the most important section for the CDK layer, and CloudFormation's own metadata is misleading.**

Almost every `AWS::Cognito::UserPool` property is documented as `Update requires: No interruption`. That does **not** mean the change is safe — it means CloudFormation will call `UpdateUserPool`, and **the Cognito API will reject some of those calls**, producing a failed stack update and rollback rather than a clean replacement.

#### 5.3.1 Immutable at the service level (CFN says "No interruption" — it lies)

| Property | Evidence |
|---|---|
| `UsernameAttributes` / `AliasAttributes` | *"When you create a user pool, you can set up username attributes… Alternatively, you can set up alias attributes… **Important**: After you create a user pool, you can't change this setting."* |
| `UsernameConfiguration.CaseSensitive` | CFN doc itself: *"This configuration is immutable after you set it."* Plus: *"To link your IdP to a user pool with a different case-sensitivity setting than your current pool, create a new user pool."* |
| Required attributes (`Schema[].Required`) | *"After you create a user pool, you can't switch an attribute between required and not required."* and *"You can't change required attributes after you create a user pool."* |
| Existing custom attributes | *"You can't remove or change it after you add it to the user pool."* (Adding new ones is fine, up to 50.) |

**→ The unified BB's CDK layer must detect changes to these four and fail at synth with an actionable message**, exactly as `bb-auth-cognito` already does for `signInWith`. **[repo]** `packages/bb-auth-cognito/README.md:250`: *"Changing `signInWith` on a deployed pool is destructive — Cognito rejects the alias-shape transition with `InvalidParameterException`. Pick the right value for your initial deploy."* Locked by tests at `src/index.cdk.test.ts:341-465`. This is correct and corroborated by AWS docs.

#### 5.3.2 Genuine CloudFormation `Replacement`

| Resource.Property | Effect |
|---|---|
| `AWS::Cognito::UserPoolClient.GenerateSecret` | **Replacement** — new client ID, every existing session invalid |
| `AWS::Cognito::UserPoolClient.UserPoolId` | Replacement |
| **`AWS::Cognito::UserPoolDomain.Domain`** | **Replacement** — changing the domain prefix destroys and recreates the domain; all hosted-UI sessions die, and passkey RP ID may change |
| `AWS::Cognito::UserPoolDomain.UserPoolId` | Replacement |

Note the asymmetry: **no `AWS::Cognito::UserPool` property triggers replacement.** A user pool is effectively permanent once created; you cannot "just recreate it" without losing every user. `DeletionProtection: ACTIVE` should be the production default, and `RemovalPolicy.RETAIN` should follow the same rule.

#### 5.3.3 Safely mutable (verified `No interruption` **and** accepted by `UpdateUserPool`)

`UserPoolTier`, `Policies` (password + `SignInPolicy`), `MfaConfiguration`, `EnabledMfas`, `AutoVerifiedAttributes`, `AccountRecoverySetting`, `AdminCreateUserConfig`, `EmailConfiguration`, `SmsConfiguration`, `LambdaConfig`, `DeviceConfiguration`, `VerificationMessageTemplate`, `UserAttributeUpdateSettings`, `UserPoolAddOns`, `UserPoolName`, `UserPoolTags`, `WebAuthnRelyingPartyID`*, `WebAuthnUserVerification`, `WebAuthnFactorConfiguration`, `DeletionProtection`, adding new `Schema` custom attributes.

\* `WebAuthnRelyingPartyID` is *technically* mutable but **semantically destructive** — every registered passkey is invalidated. Treat it as immutable in the BB's API.

App client: everything except `GenerateSecret` and `UserPoolId` is safely mutable, including `CallbackURLs`, `SupportedIdentityProviders`, `ExplicitAuthFlows`, `AllowedOAuthFlows/Scopes`, token validities, and `RefreshTokenRotation`.

Domain: `ManagedLoginVersion`, `CustomDomainConfig`, `Routing` are mutable; `Domain` is not.

#### 5.3.4 An undocumented CDK trap worth preserving

**[repo]** `packages/bb-auth-cognito/src/index.cdk.ts:187-197`:

> *"Explicit feature plan — Cognito otherwise defaults to `ESSENTIALS` and re-applies the tier as a side effect on every `UpdateUserPool`, which silently resets `AdminCreateUserConfig.AllowAdminCreateUserOnly` back to `true` (breaking self-signup on every deploy after the first)."*

AWS docs corroborate the premise (*"When you don't specify a value for `UserPoolTier`, your user pool defaults to `Essentials`"*; CFN: *"Defaults to `ESSENTIALS`"*) but **not the reset side effect**, which appears to be an empirical discovery locked by a regression test (`src/index.cdk.test.ts:468-518`). **Carry this forward: always emit `UserPoolTier` explicitly.** Also note the corollary — because `UserPoolTier` defaults to `ESSENTIALS`, **a BB that doesn't pin the tier silently opts the customer into the $0.015/MAU plan** (see §7.4).

### 5.4 Other fixed behaviors that shape the API

- `sub` format: *"Amazon Cognito generates `sub` in an Amazon Cognito-specific format that doesn't conform to a specific UUID format… You shouldn't strictly validate the format of `sub`."*
- `username` is immutable per user: *"After you create a user, you can't change the value of the `username` attribute."* Reusable only after deletion.
- **Never key app data on a sign-in attribute**: *"The fixed-value user identifier `sub` is the only consistent indicator of your user's identity."*
- With `UsernameAttributes`, `SignUp` sets `username` to a **UUID equal to `sub`**, and `ListUsers` filtering by `username` needs that UUID, not the email.
- Alias collisions surface as `AliasExistsException` at confirm time (not signup) and require `ConfirmSignUp(forceAliasCreation)` to resolve.
- Custom attributes **cannot be required**, are written as **strings in the ID token** regardless of declared type, and need the `custom:` prefix.
- `email`/`phone_number` are the only verifiable standard attributes.

---

## 6. Local-mock feasibility

The repo's mock layer must "behave like the real thing." Rating scale: **A** = faithful (same code path, same observable behavior), **B** = behaviorally faithful, different internals, **C** = shape-faithful only (types/errors match, semantics approximated), **F** = cannot be mocked; must diverge.

| Capability | Rating | Notes / necessary divergence |
|---|---|---|
| Sign-up, confirm, sign-in (`USER_PASSWORD_AUTH`) | **A** | Pure request/response; challenge names and error names are just strings. |
| Password policy | **B** | Enforce a superset of Cognito's rules. Cognito's exact validation regex is unpublished → drift is possible. **[repo]** already flags this. |
| Error surface | **A** | Cognito's wire names (`CodeMismatchException`, `NotAuthorizedException`, `ResourceNotFoundException` for a missing group) are strings and can be reproduced exactly. **[repo]** `bb-auth-cognito` already does this and documents the non-obvious `GroupNotFound` → `ResourceNotFoundException` mapping. |
| MFA state machine (TOTP/SMS/email) | **B** | Challenge sequencing, `SELECT_MFA_TYPE`/`MFA_SETUP`, retriable-vs-dead session semantics are all reproducible. **Divergence:** no real code delivery; mock must accept any well-formed code (or expose a `codeDelivery` hook / `last-code.json`). TOTP can be done properly with a real HMAC-OTP implementation — **[repo]** already ships `src/test-support/totp.ts`. |
| Account recovery | **B** | Same as MFA: logic faithful, delivery faked. The **MFA↔recovery interlock** (§1.2) must be modeled deliberately or the mock will let through a config that dead-ends in production. |
| Passwordless email/SMS OTP | **B** | Same as MFA. Must also model the H6 conflict with required MFA and the "marks the attribute verified + flips `UNCONFIRMED`→`CONFIRMED`" side effect. |
| **Passkeys / WebAuthn** | **C** | The protocol is mockable, but faithful mocking means real COSE/CBOR assertion verification. **[repo]** deliberately chose a "loose mock" (accepts any well-formed JSON whose `id` matches a registered credential) to avoid a `@simplewebauthn/server` runtime dep. Acceptable, but **must** be documented and backed by a sandbox e2e. Browser-side `navigator.credentials` cannot be driven in `node:test` at all. |
| Device tracking / `DEVICE_SRP_AUTH` | **C→F** | SRP math is implementable but nontrivial. **[repo]** currently mocks a synthetic device key while the AWS runtime throws 501 — the worst case: the mock teaches an API that doesn't exist in production. Either implement both or ship neither. |
| Token *shape* (JWT header/payload/signature, claims) | **A** | Structurally identical; parsing code needs no branching. |
| **Token signing / verification** | **F** | Real Cognito signs RS256 against a hosted JWKS. A mock cannot be a real Cognito issuer. Two options: (a) `alg: none` + placeholder signature — **[repo]**'s choice (`index.ts:2316-2332`), simple but means the mock never exercises JWKS fetch or signature verification; (b) generate a real RSA keypair + serve a local JWKS, so the verification code path is identical — **[repo]**'s `bb-auth-oidc` `stub-idp.ts` does exactly this and documents why (D2: *"If the stub used HMAC instead, JWKS-fetching or RS256-verification bugs could slip past mock tests"*). **Recommendation: adopt (b) for the merged BB.** It is strictly better and the repo already has the code. |
| **Refresh-token lifecycle** | **F→C** | **[repo]**'s Cognito mock has *no refresh concept* — an expired access token is treated as dead and the session dropped, whereas AWS transparently refreshes. That is an observable behavior divergence in the happy path. Fixable to **B**: the mock should issue opaque refresh tokens and implement `REFRESH_TOKEN_AUTH` / `GetTokensFromRefreshToken`, including the rotation-vs-no-rotation distinction. Worth fixing. |
| Session revocation | **C** | AWS revokes refresh tokens only; an outstanding access token survives to expiry. The mock deletes the record and flips immediately. **[repo]** documents this. To reach **B**, the mock must keep issued access tokens valid until `exp`. |
| Groups / RBAC | **A** | Plain data. |
| Custom attributes + immutability rules | **B** | The 50-attribute cap, 20-char names, 2,048-byte values, can't-remove, and can't-require rules are all enforceable in a mock — and **should be**, because they're the rules most likely to bite in production. |
| **Hosted UI / managed login** | **F** | There is no way to host Cognito's pages locally. Any mock is a different UI with different cookies, different CSRF handling, a different 1-hour session model, and no branding. |
| **OIDC redirect flow (federation)** | **F for Cognito-mediated; A for direct** | Two very different answers, and this is the crux. **Cognito-mediated:** unmockable — the redirect target is `https://<prefix>.auth.<region>.amazoncognito.com`, the code exchange is against Cognito, the `identities` claim is synthesized by Cognito, and attribute mapping is server-side. **[repo]** conceded exactly this: `bb-auth-oidc`'s mock wires the Cognito federation engine to `cognitoUnavailableLocally()`, which **throws immediately** — *"local dev for Cognito federation is simply unavailable."* **Direct OIDC:** highly mockable — `stub-idp.ts` runs a real RS256 keypair, real JWKS, real discovery document, real code+PKCE flow, real refresh rotation, real RFC 7009 revocation, and even replicates Google's `redirect_uri` rejection behavior. Its documented residual gaps are minor (no per-client `redirect_uri` allowlist, PKCE unconditionally required, `userInfo` not bound to the presented access token, `localhost` accepted alongside loopback IPs). |
| Attribute mapping / claim flattening | **C** | The mapping *rules* are mockable and the multi-value `[a,b,c]` URL-encoded flattening should be replicated (it's a common bug source). But without a real IdP there's nothing to map from except the stub. |
| Threat protection / adaptive auth | **F** | Risk scoring, compromised-credential detection, breach corpora — not reproducible. Sandbox only. |
| Rate limits / quotas | **F (intentionally)** | Do not simulate. Document instead. |
| Cognito Lambda triggers | **C** | Invoking a local function at the right lifecycle point is easy; matching Cognito's exact event/response schemas per trigger version (e.g. pre-token-generation V1/V2/V3) is the hard part. **[repo]** currently supports none. |
| Managed login branding / localization | **F** | N/A locally. |

**Bottom line for §6:** every *Cognito-native* capability is mockable to **B** or better, with two fixable regressions (token signing, refresh lifecycle). Every *hosted-UI / federation* capability is **F**. **A unified BB that offers OIDC via Cognito offers a feature that cannot be developed locally** — which directly contradicts AWS Blocks' core promise ("Everything runs locally with no AWS account").

---

## 7. Cost model

Source: <https://aws.amazon.com/cognito/pricing/>, <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html>

### 7.1 Tiers

| Tier | Free tier | Price / MAU above free |
|---|---|---|
| **Lite** | 10,000 MAU (50,000 for pools created ≤ 2024-11-22 10:00 PT) | $0.0055 for first 90,000 billable, then $0.0046 |
| **Essentials** ← **default for new pools** | 10,000 MAU | $0.015 |
| **Plus** | **none** | $0.020 |

Free tier is per account or per AWS organization, does not expire, and is unavailable in GovCloud.

### 7.2 The federation cost cliff — the most important number in this document

> For users federated through SAML 2.0 or an OIDC identity provider, Cognito has a free tier of **50 MAUs** per month per account/organization, and **$0.015 per MAU above it — regardless of your user pool pricing tier.**

| Sign-in type | Free MAU | Price above free |
|---|---|---|
| Direct (username/password, passwordless, passkey) | **10,000** | $0.0055 (Lite) / $0.015 (Essentials) |
| **Social** (Google, Facebook, Apple, Amazon) | **10,000** | same as direct |
| **Generic OIDC** | **50** | **$0.015, all tiers** |
| **SAML** | **50** | **$0.015, all tiers** |

**A 200× difference in free tier, purely for choosing the generic-OIDC provider type.** An app with 1,000 Okta users pays ~$14.25/month for federation it could get for free by talking to Okta directly; at 100,000 users, ~$1,500/month.

And §2.6's kicker: **linking a federated identity to a local user makes that local user an `EnterpriseMAU` forever**, "regardless of whether the user signs in directly or via federation." So a "link your work account" feature silently moves users out of the 10,000 free tier into the 50 free tier.

### 7.3 Feature gating by tier

| Feature | Lite | Essentials | Plus |
|---|---|---|---|
| Sign-up/sign-in, groups, SRP, custom auth, M2M, resource servers, user import | ✅ | ✅ | ✅ |
| **Social / SAML / OIDC federation** | ✅ | ✅ | ✅ |
| Classic hosted UI | ✅ | ✅ | ✅ |
| CSS-based hosted-UI customization | ✅ | ✅ | ✅ |
| TOTP + SMS MFA | ✅ | ✅ | ✅ |
| ID-token customization (pre-token-gen V1) | ✅ | ✅ | ✅ |
| Lambda triggers | ✅ | ✅ | ✅ |
| **Managed login + branding visual editor** | ❌ | ✅ | ✅ |
| **Managed login localization** | ❌ | ✅ | ✅ |
| **Email MFA** | ❌ | ✅ | ✅ |
| **Passwordless email/SMS OTP** | ❌ | ✅ | ✅ |
| **Passkeys (`WEB_AUTHN`)** | ❌ | ✅ | ✅ |
| **Choice-based auth (`USER_AUTH`)** | ❌ | ✅ | ✅ |
| **Password history / reuse prevention** | ❌ | ✅ | ✅ |
| **Access-token customization (V2/V3)** | ❌ | ✅ | ✅ |
| **Refresh token rotation** | ❌ | ✅ | ✅ |
| Threat protection (compromised creds, adaptive auth, risk logs) | ❌ | ❌ | ✅ |

Notes: tier is **per user pool**, not per app client, and switchable at any time — but downgrades require deactivating dependent features first, and mid-month tier changes bill each MAU at the highest tier active during their activity. Setting `AdvancedSecurityMode` forces `PLUS`.

Also billable, easy to miss: **SES** charges for every email, **SNS** for every SMS, **access-token customization with V2 events costs extra**, multi-region replication is +$0.0045/MAU, M2M is $0.00225 per token response with **no free tier**, and RPS quota increases are ~$20/RPS-month.

### 7.4 What counts as a MAU (this is broader than "sign-in")

Any of: sign-up or admin create; account confirmation or attribute verification; **sign-in or challenge response**; **sign-out or token revocation**; **token refresh**; password change or self-service reset; attribute or group-membership change; **`AdminGetUser`**. CSV import does *not* count. `AdminResetUserPassword` does *not* count.

**Two design defects this makes possible:**
1. **Token refresh is a billable event.** A short access-token lifetime with aggressive refresh converts idle users into MAUs. The BB's default token lifetimes are a cost decision.
2. **`AdminGetUser` is billable; `ListUsers` is not.** Docs: *"A detailed user-by-user query in a large user pool can have a significant impact on your AWS bill."* An admin UI that calls `AdminGetUser` per row bills every user it displays. **Never put `AdminGetUser` in a list path.**

### 7.5 Framework-default recommendation

A default that silently costs money is a design defect (task framing), so state the tradeoff plainly:

- **`Lite` is the only genuinely cheap default** ($0.0055/MAU, 10k free) but it **excludes passwordless, passkeys, `USER_AUTH`, email MFA, refresh-token rotation, and managed login** — i.e. most of what a modern auth BB would want to offer.
- **`Essentials` is Cognito's own default** and is what you get if the BB omits `UserPoolTier` (§5.3.4). At $0.015/MAU with 10k free, it's ~2.7× Lite's rate.
- **`Plus` has no free tier at all** — never default to it, and note that setting `AdvancedSecurityMode` forces it.

**Recommendation:** make `featurePlan` a **required, non-defaulted** option in the unified BB (or default to `lite` and throw at synth when a requested feature needs a higher tier, with the error naming both the feature and the price delta). Always emit `UserPoolTier` explicitly. Never enable generic-OIDC federation implicitly.

---

## 8. Where "Cognito as the sole service" is a bad fit

### 8.1 Generic OIDC through Cognito is strictly worse than direct OIDC — plainly

For the AWS Blocks target user (a developer who wants "sign in with Okta/Entra/Auth0" in a TypeScript app), routing generic OIDC through a Cognito user pool is worse on **six** axes and better on **zero**:

| Axis | Direct OIDC (`openid-client`) | Via Cognito | Evidence |
|---|---|---|---|
| **Cost** | $0 | **$0.015/MAU from user 51**, all tiers | §7.2 |
| **Local dev** | Full offline stub: real RS256 keys, real JWKS, real discovery, real PKCE, real rotation | **Impossible** — the repo's own mock throws `cognitoUnavailableLocally()` | §6, **[repo]** `bb-auth-oidc/src/index.mock.ts:50-56` |
| **Claim fidelity** | App reads the raw ID token; every claim available | Only pre-declared mapped attributes survive; ≤ 50 custom attrs, ≤ 20-char names, ≤ 2,048 bytes, multi-values mangled to `[a,b,c]`, unmapped claims silently dropped, IdP tokens not forwarded | §2.4, §2.3 |
| **Network hops** | browser → IdP → app (1 redirect chain) | browser → **Cognito** → IdP → **Cognito** → app (plus a Cognito token exchange, plus Cognito's own JWKS + `userInfo` calls to the IdP) | §3.2 |
| **UI control** | App owns the page | Hosted UI mandatory (H2); styling it properly requires **Essentials** (§3.1); needs a `ManagedLoginBranding` resource from CFN (H8); no custom CORS; cookie-dependent; 1-hour non-renewing session | §3 |
| **Provider compatibility** | Public clients, PKCE-only clients, `client_secret_basic`, any port, any signing alg supported by `jose` | **Client secret mandatory**, `client_secret_post` only, ports 80/443 only, HTTPS only, `kid` required | §2.2, H9 |
| **Security** | App verifies signature + `nonce` + PKCE itself | Cognito verifies the IdP token; **no MFA for federated users** (H4); **no device tracking**; IdP deactivation doesn't invalidate the Cognito session for up to the refresh-token lifetime | H4, §1.5, §1.6 |

**Conclusion: yes — generic-OIDC-through-Cognito is strictly worse for the user.** The only genuine wins are (a) a single token format if you *also* have native Cognito users, and (b) Cognito's compliance posture on the token-minting step. Neither outweighs a 200× free-tier reduction plus zero local development.

### 8.2 A claim in the current repo is factually wrong

**[repo]** `packages/bb-auth-oidc/README.md:366-369` justifies the Cognito-federation path with: *"**Cognito-mediated** (`cognitoFederated()`): Managed security (SOC 2, HIPAA-eligible), **MFA on social sign-in**, adaptive authentication, brute-force protection."* The engine header comment repeats it: *"Cognito handles token rotation, **MFA (if configured)**, and brute-force protection."*

**AWS documentation contradicts this directly** (<https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html>):

> *"In the case of federated users, Amazon Cognito delegates all authentication processes to the IdP and doesn't offer them additional authentication factors."*

Reinforced by the device-tracking page: *"Third-party IdPs must separately manage devices and MFA for their users."* Adaptive authentication and compromised-credential detection likewise operate on password sign-ins, not on delegated IdP authentications. **This should be corrected in the docs regardless of the refactor outcome** — it is the primary stated reason a user would choose the more expensive path.

### 8.3 Other places Cognito is a poor fit

1. **Replacing `bb-auth-basic` with Cognito is a regression for its intended use case.** `bb-auth-basic` is DynamoDB + bcrypt + a self-signed JWT: **$0 per user**, no external service, arbitrary usernames, customer-supplied code delivery, fully offline, zero deploy latency. On Cognito the same app gains MAU billing, a ~1–3 min pool deploy, Cognito's username/attribute schema, Cognito's fixed password-policy knobs, and Cognito's email-delivery model (50 messages/day account-wide without SES). If the merged BB has no zero-cost / zero-external-service mode, **the cheapest option in the framework disappears.**
2. **Cognito custom attributes are not an app database.** 50 attributes, 20-char names, 2,048 bytes, non-removable, string-only in tokens, and a non-adjustable 25 RPS `UserUpdate` quota. AWS itself says use an external store. Any unified API that makes `user.attributes` look like a general profile store is inviting a wall.
3. **No self-service profile management in managed login.** Even on the hosted path you must build attribute changes and MFA-preference UI yourself — so the BB carries the full API surface anyway and gets no size savings from adopting the hosted UI.
4. **Custom auth (`CUSTOM_AUTH`) and federation are mutually exclusive in one app client's UI**, because managed login doesn't support custom-auth triggers. A BB that offers both must either use separate app clients or document the exclusion.
5. **Email delivery is a portability cliff.** Email OTP and email MFA require Essentials **and** your own SES, and Cognito's SES-region mapping has three different rulesets with cross-region service-principal grants in "Alternate Region" regions. The BB cannot make email OTP work out of the box portably.
6. **Hosted-UI sign-out is not sign-out.** Because the managed-login cookie survives `GlobalSignOut`, any federated sign-out must also redirect to `/logout`. A unified `signOut()` that only calls the API is a security bug on the federated path.

---

## 9. Cross-check against the existing implementation

Where the repo already encodes a constraint, and whether AWS docs agree:

| **[repo]** finding | Location | Docs verdict |
|---|---|---|
| Changing `signInWith` post-deploy is destructive | `bb-auth-cognito/README.md:250`, tests `index.cdk.test.ts:341-465` | ✅ **Confirmed** — alias/username attributes immutable after creation |
| Email MFA requires SES; Cognito's internal sender has a 50-msg/day quota | `bb-auth-cognito/src/index.cdk.ts:134-138` | ✅ **Confirmed**, and worse — the 50/day quota is **per AWS account**, not per pool |
| Passkeys unsupported on `lite` | `index.cdk.ts:117-121` | ✅ Confirmed — "all feature plans except Lite" |
| Passkey RP config is top-level `WebAuthnRelyingPartyId`, not a `WebAuthnConfiguration` envelope | `index.cdk.ts:214-219` | ✅ Confirmed by the current CFN reference |
| `UserPoolTier` must be pinned or `UpdateUserPool` resets `AllowAdminCreateUserOnly` | `index.cdk.ts:187-197`, tests `index.cdk.test.ts:468-518` | ⚠️ **Premise confirmed** (Essentials is the default), **side effect undocumented** — treat as an empirical finding, keep the test |
| `revokeUserSessions` revokes refresh tokens only on AWS; access token survives | `bb-auth-cognito/DESIGN.md:91` | ✅ Confirmed |
| Cognito federation requires a Cognito domain / Hosted UI; no bypass | `bb-auth-oidc/src/engines/cognito-federation-engine.ts:124-133` | ✅ Confirmed (H1, H2) |
| CFN cannot use `ssm-secure` dynamic references in `UserPoolIdentityProvider.ProviderDetails`, forcing a custom-resource Lambda | `bb-auth-oidc/DESIGN.md:97-111` | ✅ Consistent — a CloudFormation limitation, not a Cognito one. Note the runtime cost: `CreateIdentityProvider` is capped at **5 RPS per pool** (fine at deploy time) |
| Cognito federation skips ID-token signature verification because "Cognito already verified it" | `cognito-federation-engine.ts` (D6) | ✅ Cognito does validate the **IdP's** token (§2.3). But the token *your app* receives is Cognito-issued and RS256-signed — **your app should still verify it**; skipping that is an independent choice, not something Cognito's validation covers |
| Cognito doesn't verify a `nonce`, so the engine returns `nonce: undefined` | `cognito-federation-engine.ts:240-245` | ✅ Consistent — Cognito accepts a `nonce` at `/oauth2/authorize` and echoes it into the ID token it issues, but forwards no nonce guarantee to the upstream IdP |
| Cognito may not rotate refresh tokens; keep the old value if absent | `oidc-client-engine.ts` comment | ✅ Confirmed — rotation is opt-in per app client, and **incompatible with `REFRESH_TOKEN_AUTH`** |
| Local dev for Cognito federation is unavailable (`cognitoUnavailableLocally()`) | `bb-auth-oidc/src/index.mock.ts:50-56` | ✅ **Correct and unavoidable** (§6) |
| Federation `AttributeMapping` hardcoded to `{email, name}`; `cognitoFederated()` exposes no override while `customOidc()` does | `bb-auth-oidc/src/index.cdk.ts:282` | ⚠️ A real gap. Docs confirm **unmapped claims are silently dropped** and the app client must have `WriteAttributes` for every mapped attribute — so this hardcoding caps federated profiles at two claims |
| Custom domains deferred (ACM required) | `bb-auth-oidc/src/index.cdk.ts:164` | ✅ Reasonable — ACM cert must be in us-east-1, max 4 custom domains/region, and adding one **breaks existing prefix-domain passkeys** |
| App-client callback URL is a `https://localhost` placeholder at synth | `bb-auth-oidc/src/index.cdk.ts:241-242` | ⚠️ Mutable at no interruption, so a post-deploy update is safe — but it must actually happen; `redirect_uri` must match a registered `CallbackURL` exactly or `/oauth2/authorize` rejects it |
| `bb-auth-cognito` has zero federation/hosted-UI code and sets `disableOAuth: true` | `bb-auth-cognito/src/index.cdk.ts:248-251`, `DESIGN.md:25` | ✅ Accurate — the merge must **build** this surface (`UserPoolDomain` + `UserPoolIdentityProvider` + `ManagedLoginBranding` + OAuth flows), not port it |
| No identity pool, by design | `bb-auth-cognito/DESIGN.md:38` | ✅ Endorsed (§4) |

---

## 10. Implications for the unified API

Design consequences that follow directly from the constraints above. Not a proposal — inputs to one.

1. **Model native and federated sign-in as two `AuthAction` kinds, not one method.** Native returns challenge state; federated returns a redirect URL. Reuse `auth-common`'s unified-form model (`fields` vs `url`+`method`) — it is the only honest unification (§3.4).
2. **Do not default generic-OIDC federation to Cognito brokering.** Offer both paths explicitly and document the cost/local-dev/claims tradeoff (§8.1). If only one can ship, **direct OIDC serves users better**; Cognito brokering is justified mainly when the customer needs one token format across native + enterprise users, or has a compliance requirement on the broker.
3. **`featurePlan` must be explicit and always emitted.** Never omit `UserPoolTier` (§5.3.4, §7.5). Validate feature-vs-tier at synth with errors that name the feature *and* the price delta.
4. **Synth-time guards for the four service-immutable properties** (sign-in attributes, case sensitivity, required attributes, existing custom attributes) — CloudFormation will not stop you (§5.3.1). Extend the existing `signInWith` guard pattern.
5. **Keep the double-throw pattern** (synth + runtime construction) for every unsupported flow, so `fromExisting()` can't bypass a guard.
6. **Validate the documented impossible combinations at synth:** required MFA + passwordless OTP (H6); email MFA without SES; email-only recovery + email MFA; `CUSTOM_AUTH` + federation on one app client; threat protection + required MFA; passkeys on Lite.
7. **Pick one refresh path.** Prefer `GetTokensFromRefreshToken` unconditionally — it works with and without rotation, whereas `REFRESH_TOKEN_AUTH` is incompatible with rotation (§1.6).
8. **`signOut()` on a federated session must also hit `/logout`**, or the managed-login cookie silently re-authenticates the user (§1.6, §8.3.6).
9. **Never auto-link federated identities by email.** `AdminLinkProviderForUser` is an account-takeover primitive on an IdP that doesn't verify emails, it's irreversible-without-deletion after first sign-in, and it permanently promotes the user to enterprise MAU pricing (§2.6).
10. **Do not surface Cognito custom attributes as a profile store.** Point users at `KVStore` keyed on `sub` (§8.3.2). Never call `AdminGetUser` in a list path — it's billable per user (§7.4).
11. **Fix the two mock regressions while merging:** (a) sign mock tokens with a real generated RSA keypair + local JWKS so the verification code path is exercised (the `stub-idp.ts` approach already in the repo); (b) implement a real refresh-token lifecycle in the mock. Both move behaviors from **F** to **B** (§6).
12. **Preserve a zero-cost path** or explicitly accept that the framework's cheapest auth option is being removed (§8.3.1). If Cognito is truly the sole backing service, say so in the README's "When not to use."
13. **Resolve `rememberDevice`** — implement `DEVICE_SRP_AUTH` on the AWS path or drop it from the mock. A mock-only API is worse than no API (§1.5, §6).
14. **Ship a mock-parity table in the merged `DESIGN.md`** covering every row in §6, including the unmockable ones. Per AGENTS.md, any serialization/behavior change also needs a sandbox e2e.

---

## Appendix — sources

Cognito Developer Guide:
- Authentication flows (methods): <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html>
- Manage authentication methods in AWS SDKs (choice-based vs client-based): <https://docs.aws.amazon.com/cognito/latest/developerguide/authentication-flows-selection-sdk.html>
- Adding MFA to a user pool: <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html>
- Working with user attributes: <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html>
- Working with user devices: <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-device-tracking.html>
- Understanding user pool JWTs: <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-with-identity-providers.html>
- Refresh tokens: <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html>
- Third-party sign-in (federation): <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation.html>
- OIDC IdPs with a user pool: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html>
- OIDC user pool IdP authentication flow: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-flow.html>
- Mapping IdP attributes: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-specifying-attribute-mapping.html>
- Linking federated users: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation-consolidate-users.html>
- User pool managed login: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html>
- Branding editor: <https://docs.aws.amazon.com/cognito/latest/developerguide/managed-login-brandingdesigner.html>
- Authorize endpoint: <https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html>
- User pool feature plans: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html>
- Essentials plan features: <https://docs.aws.amazon.com/cognito/latest/developerguide/feature-plans-features-essentials.html>
- Email settings (SES, quotas, region mapping): <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html>
- Identity pools console overview: <https://docs.aws.amazon.com/cognito/latest/developerguide/identity-pools.html>
- Quotas: <https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html>

CloudFormation Template Reference:
- `AWS::Cognito::UserPool`: <https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpool.html>
- `AWS::Cognito::UserPoolClient`: <https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpoolclient.html>
- `AWS::Cognito::UserPoolDomain`: <https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpooldomain.html>

Pricing: <https://aws.amazon.com/cognito/pricing/>

Repo cross-check (read-only): `packages/bb-auth-cognito/{DESIGN.md,README.md,src/index.cdk.ts,src/index.aws.ts,src/index.ts,src/state-machine.ts,src/index.cdk.test.ts}`, `packages/bb-auth-oidc/{DESIGN.md,README.md,src/engine.ts,src/engines/*.ts,src/index.cdk.ts,src/index.mock.ts,src/idp-registration-lambda.ts}`, `packages/bb-auth-basic/{DESIGN.md,README.md,src/index.ts}`, `packages/auth-common/{DESIGN.md,src/ui.ts,src/cookies.ts}`.
