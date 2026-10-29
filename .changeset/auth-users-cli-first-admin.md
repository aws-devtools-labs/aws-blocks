---
'@aws-blocks/bb-auth': minor
---

Add `npx @aws-blocks/bb-auth users`, a supported way to make the first admin. `users add-to-group <user> <group>` puts a user into one of the groups the `Auth` block declares in `users.groups`; `remove-from-group` and `list-groups` are also available.

```sh
npx @aws-blocks/bb-auth users add-to-group you@example.com admin                    # the local pool in .bb-data/
npx @aws-blocks/bb-auth users add-to-group you@example.com admin --stage prod --yes # the deployed pool
```

- Without `--stage` or `--stack`, the command edits the local pool. It refuses while the dev server is running, because the server would write its in-memory copy back over the change.
- With `--stage sandbox|prod` (or `--stack <name>`), it calls Cognito on the pool the block owns in that stack, using your AWS credentials (`--profile`, `--region`). It finds the pool and its groups in the stack's template.
- It refuses a group the block doesn't declare, a user the pool doesn't have, and an email or phone number the pool hasn't verified. It also refuses a value that is one user's username and another user's verified email (anyone can register the username `boss@example.com` on a pool that signs in with usernames). `--username <name>` and `--email <address>` name the user outright.
- On a deployed stage it prints the AWS account and Region your credentials point at with the pool, so a wrong `--profile` shows before `--yes`.
- Every write to a deployed pool needs `--yes`. Without it, the command checks everything, prints what it would do, and changes nothing.

The README's first-admin recipe now uses the command. The `onSignIn` recipe is kept as an alternative, with its security notes.
