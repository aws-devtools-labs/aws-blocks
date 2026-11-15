# Blocks Application

Full-stack TypeScript application with AWS Blocks.

## For Coding Agents

**CRITICAL: Always read documentation from `node_modules/@aws-blocks/blocks/README.md` to understand the Building Block system and available APIs.**

**After making code changes, always run `npm run typecheck` to verify TypeScript types are correct.**

## Documentation Location

**All Blocks documentation is in `node_modules/@aws-blocks/blocks/README.md`:**

The Blocks package handles infrastructure, backend logic, APIs, storage, authentication, and more through Building Blocks. Read the README to discover available Building Blocks and their usage.

## For Humans

**Hover in IDE:** Import a Building Block and hover over it to see comprehensive docstrings with usage, best practices, and performance characteristics.

## Commands

```bash
npm run typecheck   # Check TypeScript types (run after code changes)
npm test            # typecheck, then the local e2e tests (starts its own dev server on :3001)
npm run dev         # Local dev (long-running - use background job)
npm run sandbox     # Deploy to AWS sandbox
npm run deploy      # Deploy to production
```

## Architecture

- **Backend:** `aws-blocks/index.ts` - Define APIs and Building Blocks
- **Frontend:** `src/index.ts` - Import backend APIs directly (type-safe)
- **Infrastructure:** Inferred from code, works locally and on AWS

**Read `node_modules/@aws-blocks/blocks/README.md` for complete documentation.**
