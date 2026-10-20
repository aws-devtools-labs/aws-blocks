---
"@aws-blocks/bb-auth-cognito": patch
---

fix(bb-auth-cognito): escape backslashes in `auth.admin.scan()` filter values

`auth.admin.scan({ attribute, match, value })` escaped double quotes in `value` but not backslashes, so a value ending in `\` could escape the closing quote of the Cognito `ListUsers` filter. Backslashes are now escaped before quotes.
