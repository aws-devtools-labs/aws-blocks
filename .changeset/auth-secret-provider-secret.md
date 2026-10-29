---
"@aws-blocks/bb-auth": minor
"@aws-blocks/bb-secret": patch
"@aws-blocks/blocks": minor
---

feat(bb-auth): accept a `Secret` as a provider client secret

A provider's `clientSecret` (and Sign in with Apple's `privateKey`) now accepts a string-valued `Secret` (AWS Secrets Manager) as well as an `AppSetting` created with `secret: true`, so a value set with `npm run secret` reaches the provider:

```ts
const googleSecret = new Secret(scope, 'google-client-secret', {
  name: 'my-app/GOOGLE_CLIENT_SECRET',
  generate: true, // a placeholder value, so the first deploy can register the provider
});
new Auth(scope, 'auth', {
  socialProviders: { google: { clientId: 'your-client-id.apps.googleusercontent.com', clientSecret: googleSecret } },
});
```

After the first deploy, set the real value with `npm run secret -- set GOOGLE_CLIENT_SECRET --prefix my-app` and deploy again. For a social or `federateVia: 'cognito'` provider, the deploy-time provider registration reads the secret from Secrets Manager, with a grant scoped to that secret's ARN (plus `kms:Decrypt` via Secrets Manager). As with any `Secret`, the app's execution role can read it too. A directly federated provider reads it at request time through the `Secret`, and locally from the `Secret`'s local value. A `Secret` with a `schema` is refused by the type. Synth warns (using a new internal flag on the `Secret` CDK construct) when a hosted-UI provider's secret is a stack-managed `Secret` created with no value (no `generate: true`), which would fail the first deploy, and says how to recover. The new `SecretRef` and `ProviderSecretRef` types name the accepted references. The `Secret` README describes using a `Secret` as an `Auth` provider secret and setting a named secret with `npm run secret`.
