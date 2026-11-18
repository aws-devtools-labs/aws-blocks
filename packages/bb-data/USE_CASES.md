# bb-data Use Cases

Real-world scenarios for a production app with a team of developers.

---

## 1. Creating a New Table

**Scenario:** Developer needs to add a `comments` table for a new feature.

**Workflow:**
```bash
# 1. Create migration file
touch migrations/003_create_comments.sql
```

```sql
-- migrations/003_create_comments.sql
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_comments_post_id ON comments(post_id);
```

```bash
# 2. Run migration locally
npx bb-data migrate ./migrations

# 3. Regenerate types
npx bb-data generate-types ./types/database.ts

# 4. Use in code with full type safety
```

**Production considerations:**
- Migration runs during deploy pipeline
- Team reviews SQL in PR
- Rollback migration should exist (003_create_comments_down.sql)

---

## 2. Adding a Column to Existing Table

**Scenario:** Add `email_verified` boolean to `users` table.

**Workflow:**
```sql
-- migrations/004_add_email_verified.sql
ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT false;
```

```bash
npx bb-data migrate ./migrations
npx bb-data generate-types ./types/database.ts
```

**Production considerations:**
- Non-breaking change (has default value)
- Existing rows get `false`
- No downtime required

---

## 3. Renaming a Column (Breaking Change)

**Scenario:** Rename `users.name` to `users.display_name`.

**Workflow:**
```sql
-- migrations/005_rename_name_column.sql
ALTER TABLE users RENAME COLUMN name TO display_name;
```

**Production considerations:**
- Breaking change - all code referencing `name` must update
- Coordinate with team: merge migration + code changes together
- Consider two-phase approach for zero-downtime:
  1. Add new column, backfill, update code to write both
  2. Switch reads to new column
  3. Drop old column

---

## 4. Adding Foreign Key Relationship

**Scenario:** Link `orders` to `users`.

**Workflow:**
```sql
-- migrations/006_add_orders_user_fk.sql
ALTER TABLE orders ADD COLUMN user_id INTEGER REFERENCES users(id);
CREATE INDEX idx_orders_user_id ON orders(user_id);
```

**Production considerations:**
- Nullable initially (existing orders have no user)
- Backfill data if needed
- Make NOT NULL in separate migration after backfill

---

## 5. Creating Indexes for Performance

**Scenario:** Queries on `orders.status` are slow.

**Workflow:**
```sql
-- migrations/007_add_orders_status_index.sql
CREATE INDEX CONCURRENTLY idx_orders_status ON orders(status);
```

**Production considerations:**
- `CONCURRENTLY` prevents table lock (Postgres-specific)
- Monitor index creation on large tables
- May need to run manually on prod for very large tables

---

## 6. Data Migration (Backfill)

**Scenario:** Populate new `users.slug` column from `users.name`.

**Workflow:**
```sql
-- migrations/008_add_user_slug.sql
ALTER TABLE users ADD COLUMN slug VARCHAR(255);

UPDATE users SET slug = LOWER(REPLACE(name, ' ', '-'));

ALTER TABLE users ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX idx_users_slug ON users(slug);
```

**Production considerations:**
- Test on staging with production-like data volume
- Large tables: batch updates to avoid long locks
- Consider running UPDATE separately from schema change

---

## 7. Dropping a Table

**Scenario:** Remove deprecated `legacy_logs` table.

**Workflow:**
```sql
-- migrations/009_drop_legacy_logs.sql
DROP TABLE IF EXISTS legacy_logs;
```

**Production considerations:**
- Ensure no code references the table
- Consider soft-delete first (rename to `_deprecated_legacy_logs`)
- Keep backup/export if data might be needed

---

## 8. Team Collaboration: Merge Conflicts

**Scenario:** Two developers create migrations at the same time.

**Problem:**
- Dev A: `003_add_comments.sql`
- Dev B: `003_add_tags.sql`

**Solution:**
- Renumber on merge: Dev B becomes `004_add_tags.sql`
- Migration runner tracks applied migrations by name, not number
- Numbers are for ordering only

**Best practice:**
- Use timestamps instead of numbers: `20240115_120000_add_comments.sql`
- Or use a migration lock table to prevent conflicts

---

## 9. Seeding Development Data

**Scenario:** New developer needs sample data locally.

**Workflow:**
```bash
# Separate from migrations
npx bb-data seed ./seeds
```

```sql
-- seeds/001_sample_users.sql
INSERT INTO users (name, email) VALUES
  ('Alice', 'alice@example.com'),
  ('Bob', 'bob@example.com');
```

**Production considerations:**
- Seeds are dev-only, never run in production
- Keep seeds idempotent (use `ON CONFLICT DO NOTHING`)

---

## 10. Viewing Migration Status

**Scenario:** Check which migrations have run.

**Workflow:**
```bash
npx bb-data status ./migrations
```

Output:
```
✓ 001_create_users.sql (applied 2024-01-10)
✓ 002_create_posts.sql (applied 2024-01-12)
✗ 003_add_comments.sql (pending)
```

---

## 11. Rolling Back a Migration

**Scenario:** Migration 005 broke something, need to revert.

**Workflow:**
```bash
npx bb-data rollback ./migrations --to 004
```

**Production considerations:**
- Requires down migrations to exist
- Some changes aren't reversible (dropped data)
- Test rollback in staging first

---

## 12. CI/CD Pipeline Integration

**Scenario:** Automate migrations in deployment.

**Pipeline:**
```yaml
deploy:
  steps:
    - name: Run migrations
      run: npx bb-data migrate ./migrations --env production
    
    - name: Deploy application
      run: ./deploy.sh
```

**Production considerations:**
- Run migrations before deploying new code
- Use migration lock to prevent concurrent runs
- Have rollback plan ready
- Consider blue-green deployments for zero-downtime

---

---

## 13. Backend Team Vending APIs to Frontend Team

**Scenario:** Backend team owns the database and exposes typed APIs. Frontend team consumes them without direct DB access.

### Team Structure

```
┌─────────────────────────────────────────────────────────────┐
│                      Backend Team                           │
│  - Owns database schema                                     │
│  - Writes migrations                                        │
│  - Exposes API endpoints                                    │
│  - Generates and publishes types                            │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ Published types + API contract
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      Frontend Team                          │
│  - Consumes typed API client                                │
│  - No direct database access                                │
│  - No knowledge of SQL/migrations                           │
└─────────────────────────────────────────────────────────────┘
```

### Backend Team Workflow

**1. Define schema and migrations:**
```sql
-- migrations/001_create_products.sql
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  price_cents INTEGER NOT NULL,
  inventory INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**2. Apply the migration locally and generate internal types** (next to the API code, which imports them as `../types/database.js`):
```bash
npx bb-data migrate ./migrations
npx bb-data generate-types ./backend/types/database.ts
```

**3. Create API layer with explicit contracts:**
<!-- doc-snippet: skip — imports ../types/database.js, the file step 2 generates -->
```typescript
// backend/api/products.ts
import { Scope, ApiNamespace } from '@aws-blocks/core';
import { Database, createKyselyAdapter, sql } from '@aws-blocks/bb-data';
import type { Database as DB } from '../types/database.js';

const scope = new Scope('products');
// migrationsPath is relative to the project root, where you run the dev server and deploy.
const database = new Database(scope, 'products', { migrationsPath: './migrations' });
// Typed reads through Kysely, using the generated table types.
const db = createKyselyAdapter<DB>(database);

// Define API response types (what frontend sees)
export interface Product {
  id: number;
  name: string;
  priceCents: number;
  inStock: boolean;
}

export interface CreateProductInput {
  name: string;
  priceCents: number;
  inventory?: number;
}

export const productsApi = new ApiNamespace(scope, 'products', () => ({
  async list(): Promise<Product[]> {
    const rows = await db
      .selectFrom('products')
      .select(['id', 'name', 'price_cents', 'inventory'])
      .execute();
    
    // Transform DB shape to API shape
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      priceCents: row.price_cents,
      inStock: (row.inventory ?? 0) > 0,
    }));
  },

  async create(input: CreateProductInput): Promise<Product> {
    // The generated types list `id` as a required column (it has no `Generated<>`
    // wrapper), so insert with SQL and let the SERIAL default fill it in.
    const row = await database.queryOne<Pick<DB['products'], 'id' | 'name' | 'price_cents' | 'inventory'>>(
      sql`INSERT INTO products (name, price_cents, inventory)
          VALUES (${input.name}, ${input.priceCents}, ${input.inventory ?? 0})
          RETURNING id, name, price_cents, inventory`,
    );
    if (!row) throw new Error('INSERT … RETURNING returned no row');

    return {
      id: row.id,
      name: row.name,
      priceCents: row.price_cents,
      inStock: (row.inventory ?? 0) > 0,
    };
  },

  async getById(id: number): Promise<Product | null> {
    const row = await db
      .selectFrom('products')
      .select(['id', 'name', 'price_cents', 'inventory'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      priceCents: row.price_cents,
      inStock: (row.inventory ?? 0) > 0,
    };
  },
}));
```

**4. Publish API types as a package:**
```typescript
// @mycompany/api-types/products.ts (published package)
export interface Product {
  id: number;
  name: string;
  priceCents: number;
  inStock: boolean;
}

export interface CreateProductInput {
  name: string;
  priceCents: number;
  inventory?: number;
}

export interface ProductsApi {
  list(): Promise<Product[]>;
  create(input: CreateProductInput): Promise<Product>;
  getById(id: number): Promise<Product | null>;
}
```

### Frontend Team Workflow

**1. Install the types package:**
```bash
npm install @mycompany/api-types
```

**2. Use typed API client:**
<!-- doc-snippet: fragment — imports productsApi from the backend file above, which is not aws-blocks/index.ts -->
```typescript
// frontend/src/products.ts
// The typed client proxy is auto-generated from your backend's ApiNamespace
// exports — return types are inferred end-to-end, no shared types package needed.
import { productsApi } from 'aws-blocks';

// Fully typed - frontend has no idea about SQL
async function loadProducts() {
  return await productsApi.list();
}

async function addProduct(name: string, price: number) {
  // Type error if wrong shape
  return await productsApi.create({
    name,
    priceCents: price * 100,
  });
}
```

### Key Principles

**1. API types ≠ Database types**
```typescript
// Database (internal)          // API (external)
interface ProductsTable {       interface Product {
  id: Generated<number>;          id: number;
  name: string;                   name: string;
  price_cents: number;            priceCents: number;  // camelCase
  inventory: number | null;       inStock: boolean;    // derived field
  created_at: Generated<Date>;    // no created_at exposed
}
```

**2. Backend controls the contract**
- Frontend never sees `price_cents` (snake_case DB column)
- Frontend gets `inStock` boolean, not raw `inventory` count
- Backend can change DB schema without breaking frontend (as long as API contract holds)

**3. Versioning strategy**
```typescript
// v1 - original
export const productsApiV1 = API('products/v1', () => ({ ... }));

// v2 - breaking change
export const productsApiV2 = API('products/v2', () => ({ ... }));
```

### Schema Change Coordination

**Non-breaking (backend only):**
- Add nullable column
- Add index
- Rename internal column (update API layer mapping)

**Breaking (requires coordination):**
- Remove field from API response
- Change field type
- Rename API field

**Workflow for breaking changes:**
1. Backend adds new API version (v2)
2. Backend publishes new types package
3. Frontend migrates to v2
4. Backend deprecates v1
5. Backend removes v1 after migration period

---

## 14. Monorepo with Shared Types

**Scenario:** Backend and frontend in same repo, types shared directly.

### Structure
```
myapp/
├── packages/
│   ├── api-types/           # Shared types (no runtime code)
│   │   └── src/
│   │       └── products.ts
│   ├── backend/
│   │   ├── migrations/
│   │   ├── types/
│   │   │   └── database.ts  # Generated, internal
│   │   └── src/
│   │       └── api/
│   │           └── products.ts
│   └── frontend/
│       └── src/
│           └── products.ts
└── package.json
```

### Workflow
```bash
# Backend developer
cd packages/backend
npx bb-data migrate ./migrations
npx bb-data generate-types ./types/database.ts

# Update API types (shared)
# Edit packages/api-types/src/products.ts

# Frontend automatically gets new types via workspace
cd packages/frontend
# Types are already available
```

---

## Summary: What's Needed for Production

| Feature | Current State | Needed |
|---------|---------------|--------|
| Run migrations | ✅ Local | ⬜ Production (Data API/direct) |
| Generate types | ✅ Works | ✅ Works |
| Migration status | ⬜ Not implemented | ⬜ Needed |
| Rollback | ⬜ Not implemented | ⬜ Needed |
| Seeding | ⬜ Not implemented | ⬜ Nice to have |
| Migration locking | ⬜ Not implemented | ⬜ Needed for teams |
| Timestamp-based naming | ⬜ Not implemented | ⬜ Nice to have |
| API types generation | ⬜ Not implemented | ⬜ Nice to have |
| API versioning | ⬜ Manual | ⬜ Could be automated |

| Feature | Current State | Needed |
|---------|---------------|--------|
| Run migrations | ✅ Local | ⬜ Production (Data API/direct) |
| Generate types | ✅ Works | ✅ Works |
| Migration status | ⬜ Not implemented | ⬜ Needed |
| Rollback | ⬜ Not implemented | ⬜ Needed |
| Seeding | ⬜ Not implemented | ⬜ Nice to have |
| Migration locking | ⬜ Not implemented | ⬜ Needed for teams |
| Timestamp-based naming | ⬜ Not implemented | ⬜ Nice to have |
