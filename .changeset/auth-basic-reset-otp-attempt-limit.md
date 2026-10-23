---
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/blocks": patch
---

AuthBasic now caps the number of failed guesses against a single verification
code (sign-up confirmation and password-reset OTP). A 6-digit code (~19.8 bits)
is exhaustively guessable within its 10-minute validity window at any reasonable
request rate, so an always-on per-code attempt cap narrows that exposure.

After 5 consecutive wrong guesses the code is invalidated and the user must
request a fresh one; a wrong guess never extends the code's life. The cap is
enforced atomically — each attempt is reserved with a compare-and-swap before
the guess is evaluated, so concurrent guesses (including across Lambda
instances on one row) cannot bypass it. The error is the same generic
`InvalidCodeException` on a wrong guess, a lost race, and an exhausted code, so
no oracle reveals whether the cap was hit. The cap bounds guesses against one
code; rate-limiting code issuance volume remains an infrastructure-layer
concern (WAF / API Gateway throttling).
