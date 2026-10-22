---
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/blocks": patch
---

AuthBasic now caps the number of failed guesses against a single verification
code (sign-up confirmation and password-reset OTP), closing a brute-force hole
(issue #766). A 6-digit code (~19.8 bits) is exhaustively guessable within its
10-minute validity window at any reasonable request rate, so the attempt cap —
not the code entropy — is what bounds an attacker.

After 5 consecutive wrong guesses the code is invalidated (its row is deleted),
so even the correct code no longer works and the user must request a fresh one.
A wrong guess never extends the code's life: the incremented attempt counter is
re-persisted under the code's **original** TTL, so the window still closes on
schedule. The error is the same generic `InvalidCodeException` on both a wrong
guess and an exhausted code — no oracle reveals whether the cap was hit.

This is always on (unlike the opt-in sign-in `lockout` policy): unlimited OTP
guesses is a flat security hole regardless of sign-in-throttling configuration.
The counter lives inside the code record itself (`attempts`), so it is bounded
by the code's own TTL and reaped with it — no new store key and no separate
expiry to manage. Rows written before this change default to `attempts = 0`, so
the upgrade is safe for in-flight codes.

No public surface change: `MAX_CODE_ATTEMPTS` is internal and the error reuses
the existing `AuthBasicErrors.InvalidCode` constant, so this is a `patch`. The
umbrella `@aws-blocks/blocks` is bumped because the bundled `bb-auth-basic`
README/DESIGN docs it mirrors have changed.
