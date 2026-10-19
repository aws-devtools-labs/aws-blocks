---
"@aws-blocks/bb-data": patch
---

fix(bb-data): `db pull` no longer erases other settings in `.env.local` and `.env.production`

`db pull` used to replace the whole env file with a single `SUPABASE_DB_URL=` line, deleting anything else you kept there (for example `AWS_PROFILE` or an OIDC client secret). Because these files are usually gitignored, those values couldn't be recovered. `db pull` now adds or updates only the `SUPABASE_DB_URL` entry and keeps every other line, comment, blank line, line ending and the file's permissions. An existing `SUPABASE_DB_URL` is updated in place rather than duplicated, and a connection string that needs quoting (for example one containing `#`) is quoted so it reads back intact. As before, the file is written in place, so its owner, group and ACLs are kept too. When `.env.production` already exists, the production prompt now asks whether to update its `SUPABASE_DB_URL` entry and says that other settings are kept.
