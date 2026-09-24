---
"@aws-blocks/auth-common": patch
---

fix(auth-common): Enter submits the Authenticator form from any field, not just the last

The rendered auth form isn't a native `<form>`, so submit-on-Enter is wired
explicitly — but the handler was bound only to the *last* visible input. In any
multi-field form, pressing Enter in an earlier field did nothing: the username in
a username+password sign-in, or the verification code in a code+newPassword
confirm-reset form. Enter now submits from every visible field, matching native
form behavior.
