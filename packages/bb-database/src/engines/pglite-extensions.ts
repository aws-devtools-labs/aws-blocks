// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Extension } from '@electric-sql/pglite';
import { amcheck } from '@electric-sql/pglite/contrib/amcheck';
import { bloom } from '@electric-sql/pglite/contrib/bloom';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { cube } from '@electric-sql/pglite/contrib/cube';
import { dict_int } from '@electric-sql/pglite/contrib/dict_int';
import { dict_xsyn } from '@electric-sql/pglite/contrib/dict_xsyn';
import { earthdistance } from '@electric-sql/pglite/contrib/earthdistance';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { hstore } from '@electric-sql/pglite/contrib/hstore';
import { intarray } from '@electric-sql/pglite/contrib/intarray';
import { isn } from '@electric-sql/pglite/contrib/isn';
import { lo } from '@electric-sql/pglite/contrib/lo';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { moddatetime } from '@electric-sql/pglite/contrib/moddatetime';
import { pg_buffercache } from '@electric-sql/pglite/contrib/pg_buffercache';
import { pg_freespacemap } from '@electric-sql/pglite/contrib/pg_freespacemap';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_visibility } from '@electric-sql/pglite/contrib/pg_visibility';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { seg } from '@electric-sql/pglite/contrib/seg';
import { tablefunc } from '@electric-sql/pglite/contrib/tablefunc';
import { tcn } from '@electric-sql/pglite/contrib/tcn';
import { tsm_system_rows } from '@electric-sql/pglite/contrib/tsm_system_rows';
import { tsm_system_time } from '@electric-sql/pglite/contrib/tsm_system_time';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgErrorCode } from '../errors.js';

/**
 * The contrib extensions a local `aurora` cluster loads into PGlite, keyed by the name `CREATE EXTENSION` takes.
 *
 * The set is what PGlite 0.5 ships AND Aurora PostgreSQL 16 and 17 list as supported, so a migration that runs
 * locally also runs on AWS. Left out, though PGlite ships them:
 * - `file_fdw`, `pageinspect`, `pg_surgery`, `pg_walinspect`: Aurora does not list them.
 * - `auto_explain`: a module loaded with `LOAD`, not created as an extension; Aurora sets it in a parameter group.
 * - `pg_stat_statements`: PGlite adds it to `shared_preload_libraries` in the data directory's
 *   `postgresql.conf`, and the directory then fails to open without it (`npm run db -- status` opens it that way).
 *
 * `vector` (pgvector) is not in PGlite 0.5's package; it fails locally, see {@link explainMissingExtension}.
 * `moddatetime`'s bundle also holds `autoinc`, `insert_username` and `refint`, which Aurora lists too (as
 * `contrib-spi`): they can be created locally and on AWS without a key of their own here.
 *
 * Loaded eagerly, so a data directory whose migrations created any of them opens again, and a test that creates
 * one at runtime works. Measured on PGlite 0.5.11 (Apple M3 Pro, Node 22, median of six runs): reopening an
 * existing directory takes about 150 ms with no extension and 330 ms with this set; a new directory, about
 * 1.4 s either way, the `initdb` dominating. A `dsql` cluster loads none.
 */
export const AURORA_LOCAL_EXTENSIONS: Readonly<Record<string, Extension>> = {
	amcheck,
	bloom,
	btree_gin,
	btree_gist,
	citext,
	cube,
	dict_int,
	dict_xsyn,
	earthdistance,
	fuzzystrmatch,
	hstore,
	intarray,
	isn,
	lo,
	ltree,
	moddatetime,
	pg_buffercache,
	pg_freespacemap,
	pg_trgm,
	pg_visibility,
	pgcrypto,
	seg,
	tablefunc,
	tcn,
	tsm_system_rows,
	tsm_system_time,
	unaccent,
	'uuid-ossp': uuid_ossp,
};

// PostgreSQL's text when an extension's control file is missing (SQLSTATE 0A000, feature_not_supported).
const NOT_AVAILABLE = /^extension "([^"]+)" is not available/;

/**
 * Adds to the message of PostgreSQL's "extension "x" is not available" error that the extension is missing from
 * PGlite, the local database, and which extensions are available locally. The error object is kept, so its
 * SQLSTATE and its place under the block's re-tagged error are unchanged; other errors pass through untouched.
 */
export function explainMissingExtension(e: unknown): unknown {
	if (!(e instanceof Error) || pgErrorCode(e) !== '0A000') return e;
	const name = NOT_AVAILABLE.exec(e.message)?.[1];
	if (name === undefined || name in AURORA_LOCAL_EXTENSIONS) return e;
	e.message +=
		`. PGlite, the local database of an aurora cluster, does not include extension "${name}". ` +
		`The extensions available locally are ${Object.keys(AURORA_LOCAL_EXTENSIONS).join(', ')}.`;
	return e;
}
