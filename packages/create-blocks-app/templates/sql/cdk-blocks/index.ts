/**
 * Backend — cdk-blocks/index.ts
 *
 * PostgreSQL-backed API on the Database Building Block.
 *
 * A relational notebooks → notes model with a foreign key, per-user ownership,
 * parameterized queries (injection-safe), and a multi-statement transaction.
 * Runs on PGlite locally and Aurora DSQL when deployed — no code change.
 *
 * ─── IMPORTANT ───────────────────────────────────────────────────────────────
 * Do NOT use local files, in-memory arrays, or ad-hoc databases for persistence.
 * Use Building Blocks for cloud persistence and other common cloud abstractions.
 * They work locally with automatic mocks and deploy to AWS with zero configuration.
 *
 * The schema lives in cdk-blocks/migrations/main/*.sql — numbered files that run
 * once, automatically, on first query locally and on deploy in AWS.
 *
 * Building Block docs: npm run docs lists the blocks;
 * npm run docs <Block>... prints their docs (--help for more)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  ApiNamespace,
  Scope,
  ApiError,
  Auth,
  Database,
  DatabaseErrors,
  isBlocksError,
  sql,
} from 'aws-cdk-blocks';

const scope = new Scope('my-app');

// ─── Auth ────────────────────────────────────────────────────────────────────
// Email + password sign-in (npm run docs Auth).
// Sign-up confirms the email address with a 6-digit code; once the caller
// submits it they are signed in automatically. On AWS, Cognito emails the code.
const auth = new Auth(scope, 'auth', {
  // Users sign in with their email, matched ignoring case. Both are fixed when
  // the user pool is created, and this is also the pool shape Amplify's client
  // libraries expect, so a frontend can later sign in with them too.
  users: { signInWith: ['email'], caseSensitive: false },
  // Local dev only: no email is sent, so print the code in the `npm run dev`
  // terminal. Ignored on AWS.
  codeDelivery: async (username, code, purpose) => {
    console.log(`[auth] ${purpose} code for ${username}: ${code}`);
  },
});
export const authApi = auth.createApi();

// ─── Database ──────────────────────────────────────────────────────────────
// With no options the block owns an Aurora DSQL cluster: serverless PostgreSQL
// with no VPC to manage. Locally it is PGlite with the same DSQL rules, so SQL
// the cluster would reject fails on your machine first.
//
// Schema lives in cdk-blocks/migrations/main/*.sql: the directory is named after
// the block id ('main') and is resolved from the project root (the dir you run
// `npm run dev` / `npm run deploy` in). The files are written for Aurora DSQL;
// see "Migrations" in `npm run docs Database`.
const db = new Database(scope, 'main');

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
        sql`INSERT INTO notebooks (id, owner, name) VALUES (${id}, ${user.userSub}, ${name})`,
      );
    } catch (e: unknown) {
      // The (owner, name) unique index rejects a duplicate name for this user.
      if (isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)) {
        throw new ApiError(`You already have a notebook named "${name}"`, 409, { name: 'NotebookNameConflictException' });
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
          WHERE owner = ${user.userSub}
          ORDER BY created_at DESC`,
    );
  },

  /** Add a note to one of the caller's notebooks. */
  async addNote(notebookId: string, body: string) {
    const user = await auth.requireAuth(context);
    // Ownership check: only insert if the notebook belongs to the caller.
    const notebook = await db.queryOne<Notebook>(
      sql`SELECT id FROM notebooks WHERE id = ${notebookId} AND owner = ${user.userSub}`,
    );
    if (!notebook) throw new ApiError('Notebook not found', 404, { name: 'NotebookNotFoundException' });
    const id = newId();
    await db.execute(
      sql`INSERT INTO notes (id, notebook_id, owner, body)
          VALUES (${id}, ${notebookId}, ${user.userSub}, ${body})`,
    );
    return { id, notebookId };
  },

  /** List the notes in one of the caller's notebooks, oldest first. */
  async listNotes(notebookId: string) {
    const user = await auth.requireAuth(context);
    return await db.query<Note>(
      sql`SELECT id, notebook_id, owner, body, created_at FROM notes
          WHERE notebook_id = ${notebookId} AND owner = ${user.userSub}
          ORDER BY created_at ASC`,
    );
  },

  /**
   * Delete a notebook and all its notes in one transaction — either both the
   * notes and the notebook go, or neither does. The notes go first: the foreign
   * key does not cascade, so a notebook that still has notes cannot be deleted.
   *
   * Aurora DSQL never waits on a lock. When another request changes the same
   * rows, one commit fails with a conflict, and `retryOnConflict` runs the
   * callback again. That is safe here: the callback only deletes. One
   * transaction can change at most 3,000 rows, so delete a larger notebook's
   * notes in batches first.
   */
  async deleteNotebook(notebookId: string) {
    const user = await auth.requireAuth(context);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`DELETE FROM notes WHERE notebook_id = ${notebookId} AND owner = ${user.userSub}`,
      );
      await tx.execute(
        sql`DELETE FROM notebooks WHERE id = ${notebookId} AND owner = ${user.userSub}`,
      );
    }, { retryOnConflict: true });
    return { success: true };
  },
}));
