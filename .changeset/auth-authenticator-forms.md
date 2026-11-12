---
"@aws-blocks/auth-common": patch
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

The `Authenticator` renders each action as a `<form>`, so browsers and password managers see the username and password fields together (Chrome no longer warns that the password inputs are not in a form). Enter in any field or a click on the button submits it once, and it never reloads the page; native validation is off, so the server's error is the one shown. Inputs carry `autocomplete` hints by default: `username`, `current-password` (`new-password` on sign-up and for a new password), `one-time-code` for codes, `email` for an email field and `tel` for `phone_number`. A field override's `autocomplete` still wins. Because each action is a form, a `<button>` without a `type` inside a field's `render` override now submits the action (the HTML default, `type="submit"`); give a button that should not submit `type="button"`. The `data-testid` hooks are unchanged; `authenticator-action-<action>` is now the `<form>` element.
