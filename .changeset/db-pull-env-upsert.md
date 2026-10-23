---
"@aws-blocks/bb-data": patch
---

fix(bb-data): `db pull` no longer erases other settings in `.env.local` and `.env.production`

`db pull` used to replace the whole env file with a single `SUPABASE_DB_URL=` line, deleting anything else you kept there (for example `AWS_PROFILE` or an OIDC client secret). Because these files are usually gitignored, those values couldn't be recovered. `db pull` now adds or updates only the `SUPABASE_DB_URL` entry and keeps every other line, comment, blank line, line ending and the file's permissions. An existing `SUPABASE_DB_URL` is updated in place rather than duplicated: the whole line after `=` is rewritten, so nothing from the old value is left behind (including the tail of an unquoted password containing `#` written by an earlier `db pull`), and a comment at the end of that line is not kept. A connection string that needs quoting (for example one containing `#`) is quoted so it reads back intact. As before, the file is written in place, so its owner, group and ACLs are kept too. If `.env.local` can't be updated safely (for example, the change would alter how another entry is read), `db pull` now stops before connecting or generating any files, instead of failing after writing them. When `.env.production` already exists, the production prompt now asks whether to update its `SUPABASE_DB_URL` entry and says that other settings are kept.
