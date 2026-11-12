---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': minor
---

`Auth` can send its user pool's email through your own Amazon SES identity, with the `email` option: `email: { fromAddress: 'no-reply@example.com', fromName?, replyTo?, sesRegion?, sesVerifiedDomain?, configurationSetName? }`. Cognito's default sender is capped at 50 emails a day, so set this before real users sign up.

- **Prerequisites:**
  - `fromAddress` (or `sesVerifiedDomain`) must be a verified SES identity. It defaults to the pool's Region; set `sesRegion` otherwise.
  - New SES accounts start in the sandbox, so request production access before launch.
  - Cognito creates its email service-linked role on the first deploy, so the deploying role needs `iam:CreateServiceLinkedRole`.
- **It also allows the email factors on a pool `Auth` creates:** email MFA (`mfa.types` including `'EMAIL'`) and `users.preferredChallenge: 'EMAIL_OTP'`. Cognito sends those codes only through SES, so synth refuses them without `email`.
- **Safe to add to a deployed pool:** the pool is updated in place, and its users, sessions and tokens are unaffected.
- **Refused at synth with the reason:**
  - on a pool wrapped with `Auth.fromExisting`, whose email configuration belongs to its owner;
  - on a configuration that creates no user pool;
  - for a malformed address or Region;
  - for a `sesVerifiedDomain` that isn't the domain of `fromAddress`.
- **Local development** (`npm run dev`) delivers codes locally, without SES.

The migration codemod recommends `email: { fromAddress }` for `preferredChallenge: 'EMAIL_OTP'`, rather than wrapping the pool.
