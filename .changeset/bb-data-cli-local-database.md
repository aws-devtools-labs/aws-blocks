---
"@aws-blocks/bb-data": patch
---

Make `bb-data migrate`, `status` and `generate-types` work on the local database that `npm run dev` uses.

- They no longer refuse every local app with "This app uses an external database (fromExisting())". The check read the `db-url` secret through the `AppSetting` mock, which invents a random value for an unset secret, so it always found one, and `status` saved that fake secret to `.bb-data/settings.json`. An app now counts as external only when a `*_DB_URL` / `*_CONNECTION_STRING` variable is set in the environment or in `.env.local`, or when `.bb-data/settings.json` holds a connection string for that setting.
- They open `.bb-data/<fullId>/`, the directory the dev mock uses, instead of a separate database at `.bb-data/`. Before, `status` reported migrations as pending that `npm run dev` had applied, and `migrate` changed a database the app never read. With several local databases, pass `--block <fullId>`. With none yet, `status` lists every migration as pending, and `migrate` says how to create the database.
- They refuse while another process, such as `npm run dev`, has the database open, because two processes on one PGlite database corrupt it. Concurrent `bb-data` commands on one database now wait for each other instead of failing.
- PGlite no longer quarantines a directory that also holds other data. Before, concurrent `migrate` runs could move the whole `.bb-data/`, `settings.json` included, to `.bb-data.corrupt-*`.
