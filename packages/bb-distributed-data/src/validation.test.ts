// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateStatement, classifyStatement, TransactionTracker, validateMigrations, stripLiteralsAndComments } from './validation.js';

describe('validateStatement', () => {
  it('allows basic SQL', () => {
    assert.doesNotThrow(() => validateStatement('SELECT * FROM users'));
    assert.doesNotThrow(() => validateStatement("INSERT INTO users VALUES ('1', 'Alice')"));
    assert.doesNotThrow(() => validateStatement('CREATE TABLE users (id TEXT PRIMARY KEY)'));
    assert.doesNotThrow(() => validateStatement('CREATE INDEX ASYNC idx ON users(name)'));
  });

  it('allows keywords inside string literals', () => {
    assert.doesNotThrow(() => validateStatement("INSERT INTO docs (c) VALUES ('REFERENCES')"));
  });

  it('allows keywords inside comments', () => {
    assert.doesNotThrow(() => validateStatement("-- FOREIGN KEY\nSELECT 1"));
  });

  const rejects = [
    // REFERENCES is a foreign key — DSQL has no referential integrity enforcement
    ['FOREIGN KEY', 'CREATE TABLE t (id TEXT, x TEXT REFERENCES users(id))'],
    // Triggers require PL/pgSQL runtime — not available in DSQL
    ['CREATE TRIGGER', 'CREATE TRIGGER t BEFORE INSERT ON u FOR EACH ROW EXECUTE FUNCTION f()'],
    // Views are not supported — materialize queries in application code
    ['CREATE VIEW', 'CREATE VIEW v AS SELECT 1'],
    // PL/pgSQL procedural language is not available — only SQL-language functions
    ['PL/pgSQL', "CREATE FUNCTION f() RETURNS INT AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql"],
    // SERIAL is syntactic sugar for a sequence — DSQL has no sequence support
    ['SERIAL', 'CREATE TABLE t (id SERIAL PRIMARY KEY)'],
    // TRUNCATE is not implemented — use DELETE FROM for the same effect
    ['TRUNCATE', 'TRUNCATE TABLE users'],
    // LISTEN requires the async notification subsystem — not present in DSQL
    ['LISTEN', 'LISTEN ch'],
    // NOTIFY requires the async notification subsystem — not present in DSQL
    ['NOTIFY', "NOTIFY ch, 'x'"],
    // Extensions require loading shared libraries — DSQL runs a fixed binary
    ['CREATE EXTENSION', 'CREATE EXTENSION pg_trgm'],
    // ADD COLUMN with DEFAULT rewrites all existing rows — DSQL disallows this
    ['ADD COLUMN DEFAULT', 'ALTER TABLE t ADD COLUMN x BOOLEAN DEFAULT true'],
    // Row Level Security policies are not supported — enforce access in app code
    ['RLS', 'ALTER TABLE t ENABLE ROW LEVEL SECURITY'],
    // Temporary tables use session state — DSQL connections are stateless
    ['TEMP TABLE', 'CREATE TEMP TABLE t (id INT)'],
    // DSQL uses fixed Repeatable Read isolation — cannot be changed per-transaction
    ['ISOLATION LEVEL', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'],
    // DSQL only supports C collation — locale-aware sorting is not available
    ['COLLATE', 'SELECT * FROM t ORDER BY name COLLATE "en_US"'],
  ] as const;

  for (const [label, sql] of rejects) {
    it(`rejects ${label}`, () => {
      assert.throws(() => validateStatement(sql), { name: 'DsqlValidationError' });
    });
  }
});

describe('classifyStatement', () => {
  it('classifies DDL/DML/other', () => {
    assert.equal(classifyStatement('CREATE TABLE t (id TEXT)'), 'ddl');
    assert.equal(classifyStatement('ALTER TABLE t ADD COLUMN x INT'), 'ddl');
    assert.equal(classifyStatement('DROP TABLE t'), 'ddl');
    assert.equal(classifyStatement("INSERT INTO t VALUES ('1')"), 'dml');
    assert.equal(classifyStatement('UPDATE t SET x = 1'), 'dml');
    assert.equal(classifyStatement('DELETE FROM t'), 'dml');
    assert.equal(classifyStatement('SELECT * FROM t'), 'other');
  });
});

describe('TransactionTracker', () => {
  it('allows single DDL', () => {
    const t = new TransactionTracker();
    assert.doesNotThrow(() => t.recordStatement('CREATE TABLE t (id TEXT)'));
  });

  it('allows multiple DML', () => {
    const t = new TransactionTracker();
    t.recordStatement("INSERT INTO t VALUES ('1')");
    assert.doesNotThrow(() => t.recordStatement("UPDATE t SET x = 1"));
  });

  it('rejects multiple DDL', () => {
    const t = new TransactionTracker();
    t.recordStatement('CREATE TABLE a (id TEXT)');
    assert.throws(() => t.recordStatement('CREATE TABLE b (id TEXT)'), { name: 'DsqlValidationError' });
  });

  it('rejects DDL+DML mixing', () => {
    const t = new TransactionTracker();
    t.recordStatement("INSERT INTO t VALUES ('1')");
    assert.throws(() => t.recordStatement('CREATE TABLE t (id TEXT)'), { name: 'DsqlValidationError' });
  });

  it('enforces 3000 row limit', () => {
    const t = new TransactionTracker();
    t.recordStatement("INSERT INTO t VALUES ('1')");
    t.recordRowCount(3000);
    assert.throws(() => t.recordRowCount(1), { name: 'TransactionRowLimitExceededException' });
  });

  it('resets', () => {
    const t = new TransactionTracker();
    t.recordStatement('CREATE TABLE t (id TEXT)');
    t.reset();
    assert.doesNotThrow(() => t.recordStatement('CREATE TABLE t2 (id TEXT)'));
  });
});

describe('validateMigrations', () => {
  it('passes valid migrations', () => {
    assert.doesNotThrow(() => validateMigrations({
      '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY)',
      '002.sql': "INSERT INTO t (id) VALUES ('1')",
    }));
  });

  it('rejects multiple DDL in one file', () => {
    assert.throws(() => validateMigrations({
      '001.sql': 'CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);',
    }), { name: 'DsqlMigrationValidationError' });
  });

  it('rejects DDL+DML mixed', () => {
    assert.throws(() => validateMigrations({
      '001.sql': "CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('1');",
    }), { name: 'DsqlMigrationValidationError' });
  });

  it('rejects unsupported features', () => {
    assert.throws(() => validateMigrations({
      '001.sql': 'CREATE TABLE t (id TEXT REFERENCES other(id))',
    }), { name: 'DsqlMigrationValidationError' });
  });
});

describe('stripLiteralsAndComments', () => {
  it('strips strings and comments', () => {
    assert.ok(!stripLiteralsAndComments("SELECT 'FOREIGN KEY'").includes('FOREIGN KEY'));
    assert.ok(!stripLiteralsAndComments("-- TRUNCATE\nSELECT 1").includes('TRUNCATE'));
    assert.ok(!stripLiteralsAndComments("/* REFERENCES */ SELECT 1").includes('REFERENCES'));
  });
});

describe('validateStatement — complex scenarios', () => {
  // DSQL-compatible: UUID primary keys are the recommended pattern (no SERIAL)
  it('allows UUID primary key with gen_random_uuid()', () => {
    assert.doesNotThrow(() => validateStatement(
      'CREATE TABLE orders (id TEXT PRIMARY KEY DEFAULT gen_random_uuid(), total INT NOT NULL)'
    ));
  });

  // DSQL-compatible: composite primary keys work fine
  it('allows composite primary key', () => {
    assert.doesNotThrow(() => validateStatement(
      'CREATE TABLE order_items (order_id TEXT, item_id TEXT, qty INT, PRIMARY KEY (order_id, item_id))'
    ));
  });

  // DSQL-compatible: CHECK constraints are supported (only FK is not)
  it('allows CHECK constraints', () => {
    assert.doesNotThrow(() => validateStatement(
      'CREATE TABLE products (id TEXT PRIMARY KEY, price INT CHECK (price > 0))'
    ));
  });

  // DSQL-compatible: UNIQUE constraints work (just not FK)
  it('allows UNIQUE constraint', () => {
    assert.doesNotThrow(() => validateStatement(
      'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL)'
    ));
  });

  // DSQL-compatible: partial indexes are supported
  it('allows partial index with ASYNC', () => {
    assert.doesNotThrow(() => validateStatement(
      'CREATE INDEX ASYNC idx_active ON users (email) WHERE active = true'
    ));
  });

  // Rejected: JSONB is not a supported storage type in DSQL — use JSON instead.
  // JSONB is only available as a query runtime cast (::jsonb).
  it('rejects JSONB column definition', () => {
    assert.throws(
      () => validateStatement('CREATE TABLE events (id TEXT PRIMARY KEY, payload JSONB NOT NULL)'),
      { name: 'DsqlValidationError' }
    );
  });

  // DSQL-compatible: JSON columns work (supported storage type with compression)
  it('allows JSON column definition', () => {
    assert.doesNotThrow(() => validateStatement(
      'CREATE TABLE events (id TEXT PRIMARY KEY, payload JSON NOT NULL)'
    ));
  });

  // DSQL-compatible: ::jsonb cast is a valid runtime operation
  it('allows ::jsonb cast in queries', () => {
    assert.doesNotThrow(() => validateStatement(
      "SELECT data::jsonb->>'name' FROM events WHERE id = $1"
    ));
  });

  // Rejected: BIGSERIAL is a sequence under the hood — DSQL has no sequences
  it('rejects BIGSERIAL (sequence-backed auto-increment)', () => {
    assert.throws(
      () => validateStatement('CREATE TABLE logs (id BIGSERIAL PRIMARY KEY, msg TEXT)'),
      { name: 'DsqlValidationError' }
    );
  });

  // Rejected: REFERENCES in column definition is a foreign key constraint
  it('rejects inline REFERENCES in multi-column CREATE TABLE', () => {
    assert.throws(
      () => validateStatement(
        'CREATE TABLE comments (id TEXT PRIMARY KEY, post_id TEXT REFERENCES posts(id), body TEXT)'
      ),
      { name: 'DsqlValidationError' }
    );
  });

  // Rejected: explicit FOREIGN KEY in table constraint form
  it('rejects FOREIGN KEY as table constraint', () => {
    assert.throws(
      () => validateStatement(
        'CREATE TABLE comments (id TEXT, post_id TEXT, FOREIGN KEY (post_id) REFERENCES posts(id))'
      ),
      { name: 'DsqlValidationError' }
    );
  });

  // Rejected: CREATE OR REPLACE VIEW is still a view
  it('rejects CREATE OR REPLACE VIEW', () => {
    assert.throws(
      () => validateStatement('CREATE OR REPLACE VIEW active_users AS SELECT * FROM users WHERE active'),
      { name: 'DsqlValidationError' }
    );
  });

  // Rejected: TEMPORARY TABLE — DSQL doesn't support session-scoped temp tables
  it('rejects CREATE TEMPORARY TABLE (full keyword)', () => {
    assert.throws(
      () => validateStatement('CREATE TEMPORARY TABLE staging (id TEXT, data JSONB)'),
      { name: 'DsqlValidationError' }
    );
  });

  // Rejected: TRUNCATE is not supported — must use DELETE FROM
  it('rejects TRUNCATE with CASCADE', () => {
    assert.throws(
      () => validateStatement('TRUNCATE TABLE orders CASCADE'),
      { name: 'DsqlValidationError' }
    );
  });

  // Rejected: CREATE POLICY is RLS — not available in DSQL
  it('rejects CREATE POLICY (row-level security)', () => {
    assert.throws(
      () => validateStatement(
        "CREATE POLICY user_isolation ON orders USING (user_id = current_setting('app.user_id'))"
      ),
      { name: 'DsqlValidationError' }
    );
  });

  // Rejected: ALTER TABLE ADD COLUMN with DEFAULT requires rewriting all rows — DSQL disallows it
  it('rejects ADD COLUMN with DEFAULT on existing table', () => {
    assert.throws(
      () => validateStatement("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'"),
      { name: 'DsqlValidationError' }
    );
  });

  // Allowed: ADD COLUMN without DEFAULT is fine (nullable column, no rewrite)
  it('allows ADD COLUMN without DEFAULT', () => {
    assert.doesNotThrow(() => validateStatement('ALTER TABLE users ADD COLUMN bio TEXT'));
  });

  // Rejected: PL/pgSQL function — DSQL only supports SQL-language functions
  it('rejects multi-line PL/pgSQL function with dollar-quoting', () => {
    assert.throws(
      () => validateStatement(`
        CREATE FUNCTION increment(val INT) RETURNS INT AS $$
        BEGIN
          RETURN val + 1;
        END;
        $$ LANGUAGE plpgsql
      `),
      { name: 'DsqlValidationError' }
    );
  });

  // Allowed: keyword appears in a column name — not a real usage of the feature
  it('allows column named "references_count"', () => {
    assert.doesNotThrow(() => validateStatement(
      'CREATE TABLE stats (id TEXT PRIMARY KEY, references_count INT)'
    ));
  });

  // Allowed: keyword in a WHERE clause value (string literal)
  it('allows TRUNCATE as a string value in INSERT', () => {
    assert.doesNotThrow(() => validateStatement(
      "INSERT INTO audit_log (action) VALUES ('TRUNCATE')"
    ));
  });

  // Allowed: keyword inside a block comment should be ignored
  it('allows FOREIGN KEY inside block comment', () => {
    assert.doesNotThrow(() => validateStatement(
      "/* TODO: add FOREIGN KEY later */\nCREATE TABLE t (id TEXT PRIMARY KEY)"
    ));
  });

  // Allowed: dollar-quoted body containing restricted keywords (it's a string)
  it('allows restricted keywords inside dollar-quoted string body', () => {
    assert.doesNotThrow(() => validateStatement(
      "INSERT INTO templates (body) VALUES ($tmpl$CREATE TRIGGER foo$tmpl$)"
    ));
  });

  // Rejected: COLLATE in column definition — DSQL only supports C collation
  it('rejects COLLATE in column definition', () => {
    assert.throws(
      () => validateStatement('CREATE TABLE t (name TEXT COLLATE "en_US.utf8")'),
      { name: 'DsqlValidationError' }
    );
  });

  // Rejected: SET TRANSACTION ISOLATION LEVEL — DSQL is fixed at Repeatable Read
  it('rejects changing isolation level to READ COMMITTED', () => {
    assert.throws(
      () => validateStatement('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'),
      { name: 'DsqlValidationError' }
    );
  });

  // Rejected: CREATE EXTENSION — DSQL has no extension support
  it('rejects CREATE EXTENSION IF NOT EXISTS', () => {
    assert.throws(
      () => validateStatement('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'),
      { name: 'DsqlValidationError' }
    );
  });
});

describe('TransactionTracker — complex scenarios', () => {
  // DML-first then DDL: real-world mistake of inserting seed data then altering schema
  it('rejects DML followed by DDL (seed then alter)', () => {
    const t = new TransactionTracker();
    t.recordStatement("INSERT INTO config (key, val) VALUES ('version', '2')");
    assert.throws(
      () => t.recordStatement('ALTER TABLE config ADD COLUMN updated_at TIMESTAMP'),
      { name: 'DsqlValidationError' }
    );
  });

  // DDL-first then DML: creating a table then immediately inserting — not allowed in same tx
  it('rejects DDL followed by DML (create then insert)', () => {
    const t = new TransactionTracker();
    t.recordStatement('CREATE TABLE t (id TEXT PRIMARY KEY)');
    assert.throws(
      () => t.recordStatement("INSERT INTO t (id) VALUES ('1')"),
      { name: 'DsqlValidationError' }
    );
  });

  // Row limit: accumulates across multiple execute calls within one transaction
  it('accumulates row count across multiple executes', () => {
    const t = new TransactionTracker();
    t.recordStatement('UPDATE users SET active = true');
    t.recordRowCount(1500);
    t.recordStatement('UPDATE users SET verified = true');
    t.recordRowCount(1500);
    // At exactly 3000 we're fine, one more tips it over
    assert.throws(() => t.recordRowCount(1), { name: 'TransactionRowLimitExceededException' });
  });

  // SELECT doesn't count as DDL or DML — can coexist with either
  it('allows SELECT mixed with DML', () => {
    const t = new TransactionTracker();
    t.recordStatement('SELECT * FROM users');
    t.recordStatement("INSERT INTO users (id) VALUES ('1')");
    assert.doesNotThrow(() => t.recordStatement('SELECT count(*) FROM users'));
  });

  // Reset allows reuse across multiple transactions
  it('reset allows DDL after prior DML', () => {
    const t = new TransactionTracker();
    t.recordStatement("INSERT INTO t VALUES ('1')");
    t.recordRowCount(100);
    t.reset();
    // After reset, DDL is allowed again
    assert.doesNotThrow(() => t.recordStatement('CREATE TABLE t2 (id TEXT)'));
  });
});

// ─── stripLiteralsAndComments — positional parameters ────────────────────────
// PostgreSQL dollar-quote tags are `$$` or `$tag$` (tag starts with a
// letter/underscore). Positional params like `$1` must NOT be treated as
// dollar-quote openers — they should pass through so validation rules can
// inspect the rest of the statement.

describe('stripLiteralsAndComments — positional parameters', () => {
  it('preserves a single positional parameter verbatim', () => {
    const out = stripLiteralsAndComments('SELECT * FROM t WHERE id = $1');
    assert.equal(out, 'SELECT * FROM t WHERE id = $1');
  });

  it('preserves text following the first positional parameter', () => {
    // The clause after $1 must survive so later rules can inspect it.
    const out = stripLiteralsAndComments('UPDATE t SET a = $1, b = $2 WHERE id = $3');
    assert.ok(out.includes('b = $2'), `expected "b = $2" to survive, got: ${out}`);
    assert.ok(out.includes('WHERE id = $3'), `expected trailing clause to survive, got: ${out}`);
    assert.equal(out, 'UPDATE t SET a = $1, b = $2 WHERE id = $3');
  });

  it('does not collapse content between two positional parameters into a literal', () => {
    const out = stripLiteralsAndComments('INSERT INTO t (a, b) VALUES ($1, $2)');
    assert.ok(!out.includes('__LITERAL__'), `params must not be treated as a literal, got: ${out}`);
    assert.ok(out.includes('$1'), 'first param should remain');
    assert.ok(out.includes('$2'), 'second param should remain');
    assert.equal(out, 'INSERT INTO t (a, b) VALUES ($1, $2)');
  });

  it('preserves a keyword that appears after a positional parameter', () => {
    const out = stripLiteralsAndComments('SELECT * FROM t WHERE id = $1 ORDER BY name COLLATE "en_US"');
    assert.ok(out.includes('COLLATE'), `COLLATE after a param must survive stripping, got: ${out}`);
    assert.equal(out, 'SELECT * FROM t WHERE id = $1 ORDER BY name COLLATE "en_US"');
  });

  it('still strips genuine dollar-quoted strings ($$ ... $$)', () => {
    const out = stripLiteralsAndComments('SELECT $$ raw FOREIGN KEY text $$ AS x');
    assert.ok(!out.includes('FOREIGN KEY'), `dollar-quoted body must be stripped, got: ${out}`);
    assert.equal(out, "SELECT '__LITERAL__' AS x");
  });

  it('still strips genuine tagged dollar-quoted strings ($tag$ ... $tag$)', () => {
    const out = stripLiteralsAndComments('SELECT $body$ TRUNCATE foo $body$ AS x');
    assert.ok(!out.includes('TRUNCATE'), `tagged dollar-quoted body must be stripped, got: ${out}`);
    assert.equal(out, "SELECT '__LITERAL__' AS x");
  });

  it('handles a positional parameter immediately followed by a real dollar-quoted string', () => {
    // `$1` is a param; the `$$...$$` after it is a real literal that must be stripped.
    const out = stripLiteralsAndComments('SELECT $1, $$ FOREIGN KEY $$ AS note');
    assert.ok(out.includes('$1'), 'positional param should remain');
    assert.ok(!out.includes('FOREIGN KEY'), `dollar-quoted body must be stripped, got: ${out}`);
    assert.equal(out, "SELECT $1, '__LITERAL__' AS note");
  });

  it('preserves multi-digit positional parameters ($10, $11)', () => {
    const out = stripLiteralsAndComments('SELECT * FROM t WHERE a = $10 AND b = $11');
    assert.ok(out.includes('$10'), 'multi-digit param $10 should remain');
    assert.ok(out.includes('$11'), 'multi-digit param $11 should remain');
    assert.equal(out, 'SELECT * FROM t WHERE a = $10 AND b = $11');
  });
});

describe('validateStatement — unsupported features after bind parameters', () => {
  it('rejects COLLATE that appears after a positional parameter', () => {
    assert.throws(
      () => validateStatement('SELECT * FROM t WHERE id = $1 ORDER BY name COLLATE "en_US"'),
      { name: 'DsqlValidationError' }
    );
  });

  it('rejects TRUNCATE that appears after a positional parameter', () => {
    assert.throws(
      () => validateStatement('DELETE FROM audit WHERE id = $1; TRUNCATE other'),
      { name: 'DsqlValidationError' }
    );
  });

  it('rejects REFERENCES that appears after a positional parameter', () => {
    assert.throws(
      () => validateStatement('INSERT INTO t (a) VALUES ($1) /* then */ ; CREATE TABLE c (id TEXT REFERENCES t(id))'),
      { name: 'DsqlValidationError' }
    );
  });

  it('rejects a foreign key in a parameterized multi-column INSERT context', () => {
    // Two params surrounding the violation — the classic real-world shape.
    assert.throws(
      () => validateStatement('CREATE TABLE c (a TEXT DEFAULT $1, post_id TEXT REFERENCES posts(id), b TEXT DEFAULT $2)'),
      { name: 'DsqlValidationError' }
    );
  });

  it('still allows a clean parameterized query with no unsupported features', () => {
    assert.doesNotThrow(() => validateStatement('UPDATE accounts SET balance = $1 WHERE id = $2'));
    assert.doesNotThrow(() => validateStatement('INSERT INTO users (id, name, email) VALUES ($1, $2, $3)'));
    assert.doesNotThrow(() => validateStatement('SELECT * FROM users WHERE id = ANY($1) ORDER BY name'));
  });

  it('still allows genuinely-quoted keywords even when params are present', () => {
    // The keyword is inside a real literal; presence of $1 must not change that.
    assert.doesNotThrow(() => validateStatement("INSERT INTO audit (id, action) VALUES ($1, 'TRUNCATE')"));
  });
});

describe('validateStatement — index key sort order', () => {
  it('rejects DESC on an index key', () => {
    assert.throws(
      () => validateStatement('CREATE INDEX idx ON persons (user_id, last_encounter_at DESC)'),
      /sort order/i,
    );
  });

  it('rejects DESC on a CREATE INDEX ASYNC key', () => {
    assert.throws(
      () => validateStatement('CREATE INDEX ASYNC idx_persons_user_recent ON persons (user_id, last_encounter_at DESC)'),
      /sort order/i,
    );
  });

  it('rejects an explicit ASC on an index key', () => {
    assert.throws(() => validateStatement('CREATE INDEX idx ON t (col ASC)'), /sort order/i);
  });

  it('allows NULLS FIRST / NULLS LAST on an index key (supported by DSQL)', () => {
    assert.doesNotThrow(() => validateStatement('CREATE INDEX ASYNC idx ON t (col NULLS FIRST)'));
    assert.doesNotThrow(() => validateStatement('CREATE INDEX ASYNC idx ON t (col NULLS LAST)'));
  });

  it('allows a plain CREATE INDEX without sort order', () => {
    assert.doesNotThrow(() => validateStatement('CREATE INDEX idx ON persons (user_id, last_encounter_at)'));
  });

  it('allows a partial index whose WHERE mentions a column like "description"', () => {
    assert.doesNotThrow(() => validateStatement('CREATE INDEX idx ON t (name) WHERE description IS NOT NULL'));
  });

  it('allows an expression index without sort order', () => {
    assert.doesNotThrow(() => validateStatement('CREATE INDEX idx ON t ((lower(name)))'));
  });

  it('does not flag ORDER BY ... DESC in a SELECT (no false positive outside CREATE INDEX)', () => {
    assert.doesNotThrow(() => validateStatement('SELECT * FROM persons ORDER BY last_encounter_at DESC'));
  });
});
