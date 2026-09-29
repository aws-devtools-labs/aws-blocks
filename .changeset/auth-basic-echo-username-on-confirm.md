---
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/blocks": patch
---

fix(bb-auth-basic): echo the username on the confirm-signup / confirm-reset forms

AuthBasic's `confirmingSignUp` and `confirmingPasswordReset` states rendered
`username` as an empty, visible text field — so after signing up (or requesting a
reset) the user had to **retype** their username on the confirmation step, and a
mismatch silently broke the flow. The username is now echoed as a **hidden**
field prefilled with the value just entered (mirroring `bb-auth-cognito`), so the
confirm form carries it automatically. The `code` / `password` / `newPassword`
fields are unchanged.
