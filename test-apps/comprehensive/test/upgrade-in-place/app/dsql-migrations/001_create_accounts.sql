-- Fixture of `upgrade-sql-blocks.ts`. No IF NOT EXISTS: a second run of this file fails.
CREATE TABLE accounts (
	owner TEXT NOT NULL,
	name TEXT NOT NULL,
	balance NUMERIC NOT NULL DEFAULT 0,
	PRIMARY KEY (owner, name)
);
