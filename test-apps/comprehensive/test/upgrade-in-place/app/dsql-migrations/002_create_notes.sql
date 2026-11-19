-- Fixture of `upgrade-sql-blocks.ts`: the file that the upgraded app adds.
CREATE TABLE notes (
	id TEXT PRIMARY KEY,
	body TEXT NOT NULL
);
