---
"@aws-blocks/bb-auth-cognito": patch
---

fix(bb-auth-cognito): reject `auth.admin.scan()` filter values that contain `"` or `\`

`auth.admin.scan({ attribute, match, value })` put `value` into the Cognito `ListUsers` filter with only its double quotes escaped, so a value ending in `\` could escape the closing quote. Cognito unescapes the filter more than once, so no escaping makes such a value match: users whose attribute holds a quote or a backslash were not found on AWS, while the local mock found them. `scan()` now throws a 400 `AuthCognitoErrors.InvalidParameter` for a value containing `"` or `\`, both locally and on AWS.
