---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

`admin.scan` checks its filter before it reaches Cognito's `ListUsers`, in the local pool and on AWS alike: the attribute must be one Cognito can search on (`username`, `email`, `phone_number`, `name`, `given_name`, `family_name`, `preferred_username`, `cognito:user_status`, `status` or `sub`), and a value containing a double quote, a backslash or a control character is refused with `InvalidParameterException` (400). Cognito does not honour the `\"` escape its reference documents (against a real user pool, an escaped quote still ends the value and the rest runs as filter syntax), and it documents no escape for a backslash. The filter is checked once, when `scan` is called, and the pages are fetched with that checked copy, so changing the filter object afterwards has no effect. A filter longer than Cognito's 256-character limit is refused the same way, and the local pool filters `status` and `cognito:user_status` on each account's state, as Cognito does.
