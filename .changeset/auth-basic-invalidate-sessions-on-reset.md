---
"@aws-blocks/bb-auth-basic": minor
"@aws-blocks/blocks": patch
---

AuthBasic now invalidates every outstanding session when a user resets their
password. Previously `confirmResetPassword` only changed the credential, so a
token stolen before the reset kept authenticating until it expired — the reset
did not actually lock the attacker out. Each session JWT now carries the user's
current session epoch (an `ep` claim); `confirmResetPassword` bumps a per-user
epoch counter, and every auth check rejects a token whose epoch predates it
(reported as `SessionRevokedException`), so a password reset signs the user out
on all devices.

Tokens issued before this change have no epoch claim and are treated as the
lowest epoch, so the first reset invalidates them too. If the sessions cannot be
invalidated, `confirmResetPassword` throws `SignOutIncompleteException` (503)
and leaves the password unchanged; request a new reset code and try again. The
umbrella `@aws-blocks/blocks` is bumped because the bundled `bb-auth-basic`
README/DESIGN docs it mirrors have changed.
