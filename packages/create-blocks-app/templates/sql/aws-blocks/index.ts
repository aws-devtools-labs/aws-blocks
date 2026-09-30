/**
 * Backend — aws-blocks/index.ts
 *
 * PostgreSQL-backed API on the Database Building Block.
 *
 * A relational notebooks → notes model with a foreign key, per-user ownership,
 * parameterized queries (injection-safe), and a multi-statement transaction.
 * Runs on PGlite locally and Aurora Serverless v2 when deployed — no code change.
 *
 * ─── IMPORTANT ───────────────────────────────────────────────────────────────
 * Do NOT use local files, in-memory arrays, or ad-hoc databases for persistence.
 * Use Building Blocks for cloud persistence and other common cloud abstractions.
 * They work locally with automatic mocks and deploy to AWS with zero configuration.
 *
 * The schema lives in aws-blocks/migrations/*.sql — numbered files that run once,
 * automatically, on first query locally and on deploy in AWS.
 *
 * For the full list of blocks and how to use them, see:
 *   node_modules/@aws-blocks/blocks/README.md
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  ApiNamespace,
  Scope,
  AuthBasic,
  Database,
  DatabaseErrors,
  isBlocksError,
  sql,
} from '@aws-blocks/blocks';

const scope = new Scope('my-app');

// ─── Auth ────────────────────────────────────────────────────────────────────
const auth = new AuthBasic(scope, 'auth', {
  passwordPolicy: { minLength: 8 },
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
});
export const authApi = auth.createApi();

// ─── Database ──────────────────────────────────────────────────────────────
// Schema lives in aws-blocks/migrations/*.sql. migrationsPath is resolved from
// the project root at synth time (the dir you run `npm run deploy` / cdk in).
const db = new Database(scope, 'main', {
  migrationsPath: './aws-blocks/migrations',
});

// Row shapes returned by the queries below. These mirror the migration DDL;
// the database is the source of truth, these are just the read types.
interface Notebook {
  id: string;
  owner: string;
  name: string;
  created_at: string;
}
interface Note {
  id: string;
  notebook_id: string;
  owner: string;
  body: string;
  created_at: string;
}

const newId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ─── API ─────────────────────────────────────────────────────────────────────
export const api = new ApiNamespace(scope, 'api', (context) => ({

  /** Create a notebook owned by the caller. Names are unique per owner. */
  async createNotebook(name: string) {
    const user = await auth.requireAuth(context);
    const id = newId();
    try {
      await db.execute(
        sql`INSERT INTO notebooks (id, owner, name) VALUES (${id}, ${user.username}, ${name})`,
      );
    } catch (e: unknown) {
      // The (owner, name) unique index rejects a duplicate name for this user.
      if (isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)) {
        throw new Error(`You already have a notebook named "${name}"`);
      }
      throw e;
    }
    return { id, name };
  },

  /** List the caller's notebooks, newest first. */
  async listNotebooks() {
    const user = await auth.requireAuth(context);
    return await db.query<Notebook>(
      sql`SELECT id, owner, name, created_at FROM notebooks
          WHERE owner = ${user.username}
          ORDER BY created_at DESC`,
    );
  },

  /** Add a note to one of the caller's notebooks. */
  async addNote(notebookId: string, body: string) {
    const user = await auth.requireAuth(context);
    // Ownership check: only insert if the notebook belongs to the caller.
    const notebook = await db.queryOne<Notebook>(
      sql`SELECT id FROM notebooks WHERE id = ${notebookId} AND owner = ${user.username}`,
    );
    if (!notebook) throw new Error('Notebook not found');
    const id = newId();
    await db.execute(
      sql`INSERT INTO notes (id, notebook_id, owner, body)
          VALUES (${id}, ${notebookId}, ${user.username}, ${body})`,
    );
    return { id, notebookId };
  },

  /** List the notes in one of the caller's notebooks, oldest first. */
  async listNotes(notebookId: string) {
    const user = await auth.requireAuth(context);
    return await db.query<Note>(
      sql`SELECT id, notebook_id, owner, body, created_at FROM notes
          WHERE notebook_id = ${notebookId} AND owner = ${user.username}
          ORDER BY created_at ASC`,
    );
  },

  /**
   * Delete a notebook and all its notes in one transaction — either both the
   * notes and the notebook go, or neither does. (The FK also cascades, but
   * doing it explicitly shows the transaction API.)
   */
  async deleteNotebook(notebookId: string) {
    const user = await auth.requireAuth(context);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`DELETE FROM notes WHERE notebook_id = ${notebookId} AND owner = ${user.username}`,
      );
      await tx.execute(
        sql`DELETE FROM notebooks WHERE id = ${notebookId} AND owner = ${user.username}`,
      );
    });
    return { success: true };
  },
}));
