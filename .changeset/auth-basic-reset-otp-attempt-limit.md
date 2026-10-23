---
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/blocks": patch
---

AuthBasic now caps the number of failed guesses against a single verification
code (sign-up confirmation and password-reset OTP), closing a brute-force hole.
A 6-digit code (~19.8 bits) is exhaustively guessable within its 10-minute
validity window at any reasonable request rate, so the attempt cap — not the
code entropy — is what bounds an attacker.

After 5 consecutive wrong guesses the code is invalidated and the user must
request a fresh one; a wrong guess never extends the code's life. The error is
the same generic `InvalidCodeException` on both a wrong guess and an exhausted
code, so no oracle reveals whether the cap was hit. This is always on, unlike
the opt-in sign-in `lockout` policy.
