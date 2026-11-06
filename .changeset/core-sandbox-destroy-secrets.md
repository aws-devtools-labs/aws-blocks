---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): `sandbox destroy` deletes the database connection string that the sandbox deploy stored in SSM

- When `.env.local` sets a `*_DB_URL` or `*_CONNECTION_STRING`, the sandbox deploy writes it, password included, to the SSM SecureString `/<sandbox stack>-db-url`. CloudFormation never owned that parameter, so `sandbox destroy` left it in the account after the stack was gone.
- After the stack is deleted, `sandbox destroy` now deletes that parameter too. It derives only the sandbox's own name, never the production one, and skips a parameter that doesn't exist.
- If SSM refuses the delete (access denied, throttling), `sandbox destroy` still exits 0 once the stack is gone, and warns with the parameter name and the `aws ssm delete-parameter` command to run.
