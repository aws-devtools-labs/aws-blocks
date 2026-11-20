# Swift demo backend

Full-stack TypeScript application with AWS CDK Blocks.

Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more).

## Commands

```bash
npm run dev         # Local dev: API on :3001 and the web frontend (long-running)
npm run spec        # Write cdk-blocks/blocks.spec.json for the Swift code generator (run after npm run dev has started)
npm run typecheck   # Check TypeScript types (run after code changes)
npm test            # typecheck, then the local e2e tests (starts its own dev server on :3001)
npm run sandbox     # Deploy to AWS sandbox
npm run deploy      # Deploy to production
```

## Architecture

- **Backend:** `cdk-blocks/index.ts` - Define APIs and Building Blocks
- **Frontend:** `src/index.ts` - Import backend APIs directly (type-safe)
- **Infrastructure:** Inferred from code, works locally and on AWS

**Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more).**
