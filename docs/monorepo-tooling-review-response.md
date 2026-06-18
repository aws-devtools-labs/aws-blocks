# Re: "State of the Art for a TypeScript Library Monorepo in Mid-2026"

A response to the external tooling-review doc, validated against the actual state of
`aws-blocks` (June 2026).

## Summary

As a survey of the mid-2026 tooling landscape the doc is useful and most of its general
claims hold. But it validates an assumption about our repo that doesn't — and that
assumption is load-bearing for its top recommendations. The corrections below ground the
next pass in what `aws-blocks` actually is.

## The framing is wrong: we're not greenfield

The doc repeatedly says "small, library-focused greenfield repo," "near-zero migration
cost," "you have no legacy to fix." None of that holds. `aws-blocks` is:

- **24 published packages**, all live on npm at `0.1.x` under the `latest` tag.
- A real monorepo with CDK constructs, native (Kotlin/Maven) bindings, 20+ test-apps, a
  custom `tsx` publish pipeline, api-extractor API-report gating, and 17 CI workflows.
- A **public** repo (`aws-devtools-labs/aws-blocks`), not private — so the doc's "Trusted
  Publishing needs a public repo, you'll keep tokens" caveat is backwards for us.
- On **Node 22** (`.nvmrc`), not the "Node 24+" the Trusted Publishing section assumes.

Because the doc never inspected the repo, it also missed that we already use api-extractor
for API surface, `node --test` (not a missing test runner), `noUndeclaredDependencies` as a
Biome error (we already enforce the no-phantom-deps property pnpm sells), and husky purely
as a git-secrets scanner.

## The real correction: separate two cost axes the doc merged

Almost every "do it now while it's free" pitch fails because it tags two different things
with the same "greenfield = cheap" label.

**Axis 1 — consumer-contract changes.** These shape the published artifact and create
lock-in once we hit 1.0. Here the pre-release argument is strong and we should move before
1.0:

- `exports`-map / publint / attw correctness
- `nodenext` vs `bundler` for shipped `.d.ts`
- the ESM-only commitment
- `isolatedDeclarations`, to the extent it shapes the public API surface

**Axis 2 — internal tooling swaps.** pnpm, Vitest, lefthook, knip, Turborepo. None of these
touch the published artifact, so being pre-release doesn't lower their cost at all — a
2MB-lockfile pnpm migration or a 24-package `node:test`→Vitest swap costs the same now as at
3.0. Judge these on ROI whenever, with no urgency tax.

The doc's actual mistake wasn't the recommendations — it was pricing the Axis-2 migrations
as "near-zero because greenfield." They're not zero, and pre-release status doesn't make
them so.

## What we're acting on

- **Now (cheap *and* locks-in-able):** wire `publint` + `@arethetypeswrong/cli --pack` into
  the publish dry-run and fix the `exports` maps. Concrete bug this catches:
  `@aws-blocks/core`'s `.` entry has no `types` condition, and `./server` maps both `import`
  and `require` to the same ESM file — exactly the masquerading pattern attw flags.
- **Before 1.0:** decide `nodenext` + the ESM-only commitment; evaluate
  `isolatedDeclarations` for the API-discipline benefit (aware it will fight our `bundler`
  resolution and `z.infer`-style cross-module inference).
- **Deferred, on merits only:** pnpm, Vitest, lefthook, knip, Turborepo. Good ideas, no
  pre-release urgency.

## Net

Keep the landscape survey — it's solid. But drop the greenfield framing and re-cost the
recommendations against a published, pre-1.0, 24-package public monorepo on Node 22. The
high-value items for us (the exports/attw gate, module-resolution decisions) were buried
next to the big migrations as if they were the same kind of bet. They aren't.
