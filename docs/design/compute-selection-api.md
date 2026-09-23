# Compute selection API Design

## Context

AWS Blocks team is in the midst of building options to run work on various types and configurations of compute. The current default is to run all work on single lambda, including all API requests, async jobs, and cron jobs. The "Multi-compute" project will give customers the option of construction a `Compute` building block and **injecting it** into different workloads. (Once every workload supports compute, `compute` could also be injected at the `Scope` level.)

## Problem

The original design called for each "type" of `Compute` to be instantiated using Building Block names that "leak" the underlying service names into the IFC layer. This design asks customers to choose specific `Compute` blocks based on what they know of the underlying services, which is antithetical to the design philosophy of AWS Blocks.

## Goals/Constraints

There are two overarching design goals in the AWS Blocks ecosystem to bear in mind.

1. Building Blocks are **"Cloud"** Building Blocks; ***not*** *"AWS"* Building Blocks.
2. Power users should always be able to "drop" into CDK to customize and extend.

Specific to Multi-compute:

3. The design MUST NOT impede "bring your own compute" in the near future.

And a proposed goal of this specific are of concern:

4. The design MUST NOT obfuscate the "general type" or "category" of `Compute` being used.

This proposed fourth goal stands on the assumption that customers both CAN, SHOULD, and DESIRE TO understand the difference between broad categories of compute. (See Appendix A for more detail.)

## Proposed Solution

The proposed solution is a single `Compute` Block or factory that clearly asks customers to state the *type* of `Compute` they want as an attribute. The `type` (or possibly `category`) will communicate everything that both new and advanced customers need to know about the cost, scaling, and performance implications.

---

## Design

The design has three parts: a set of **options common to all** compute (the category and the tuning attributes), how a compute is **consumed** by a workload such as `AsyncJob`, and the **declaration surface** itself — the one part the options below actually differ on. The common options and the consumption contract are the same no matter which declaration surface we choose, so they are settled first and the options section is left to argue only the surface.

### Compute categories

The category is the one thing a customer must state. It names the general kind of compute, not the AWS service.

```ts
type ComputeCategory =
  | 'ephemeral'    // pay-as-you-go, per-request, short-lived (Lambda today)
  | 'container'    // long-running / long-lived process (Fargate today)
  | 'dedicated';   // reserved capacity (EC2/EKS later)
```

### Common options

Every option below accepts the same tuning attributes. The category selects the compute; these configure it. Attributes that don't apply to a category are a synth-time error rather than silently ignored, so a customer can't set `cpu` on an `ephemeral` compute and wonder why nothing changed.

```ts
interface ComputeOptions {
  /** The general kind of compute. Required — never inferred from other attributes. */
  category: ComputeCategory;

  /** Memory (MB). Applies to all categories. */
  memory?: number;

  /** vCPU units. `container`/`dedicated` only. */
  cpu?: number;

  /** Max concurrent units of work per instance. `container`/`dedicated` only; the per-task cost lever. */
  maxConcurrency?: number;

  /** Custom image. `container`/`dedicated` only. */
  image?: string;
}
```

Note what is *not* here: there is no `timeout` on the compute. Time limits are a property of work, not of compute (Appendix A). A ceiling could live on an `ephemeral` compute because the platform enforces one anyway, but hoisting it onto every category is the contradiction goal 4 rules out. Timeouts live on the workload — see below.

### How `AsyncJob` consumes a `Compute`

A workload takes a `compute` and its own `timeoutSeconds`, regardless of which option we pick for declaring the compute. This is additive to the existing `AsyncJobOptions`.

```ts
interface AsyncJobOptions<T> {
  handler: (payload: T, ctx: AsyncJobContext) => Promise<void>;
  // ...existing options (schema, maxRetries, batchSize, trackStatus)...

  /** Where this job runs. Omit to use the app default (ephemeral). */
  compute?: Compute;

  /**
   * Wall-clock limit for one delivery, in seconds. A property of THIS work, not
   * of the compute it shares. Enforced by the runtime (on a container, by
   * terminating the worker); on an ephemeral compute it is bounded by the
   * platform ceiling. A per-job value may only tighten that ceiling, never
   * raise it — a job asking for more than the compute can offer is a synth error.
   */
  timeoutSeconds?: number;
}
```

```ts
const reports = /* one of the options below */;

const nightly = new AsyncJob(scope, 'nightly-report', {
  compute: reports,
  timeoutSeconds: 60 * 30,   // this job may run 30 min
  handler: async (payload) => { /* ... */ },
});

const quick = new AsyncJob(scope, 'thumbnail', {
  compute: reports,          // same compute, different deadline
  timeoutSeconds: 30,        // this job must finish in 30s
  handler: async (payload) => { /* ... */ },
});
```

Two jobs share one `container` compute and set their own deadlines. Neither can outlive the compute; each can be stricter than it. That is the whole point of putting the timeout on the job.

---

## Options — declaration surface

This is the one part the options differ on. Each produces the same core `Compute` type settled above, so any of them can be injected into `new AsyncJob(..., { compute })`. A power user can always bypass the sugar and construct a concrete compute directly (goal 2). The options differ only in the front-door ergonomics.

### Option 1 — one `Compute` block, `category` attribute

```ts
import { Compute } from '@aws-blocks/blocks';

const reports = new Compute(scope, 'reports', { category: 'container', memory: 2048, cpu: 1024 });
const api     = new Compute(scope, 'api', { category: 'ephemeral', memory: 512 });
```

Same `new X(scope, id, options)` shape as every other block. Category is a required field, so the choice is explicit and greppable. One class, one options type.

### Option 2 — category factory methods

```ts
import { Compute } from '@aws-blocks/blocks';

const reports = Compute.container(scope, 'reports', { memory: 2048, cpu: 1024 });
const api     = Compute.ephemeral(scope, 'api', { memory: 512 });
```

The category is the method name. Autocomplete lists the categories, the choice can't be misspelled, and each method exposes only the attributes valid for its category (no `cpu` on `ephemeral`). Adding a category later is a new method (additive).

### Option 3 — concrete blocks, no category abstraction

```ts
import { LambdaCompute, ContainerCompute } from '@aws-blocks/blocks';

const reports = new ContainerCompute(scope, 'reports', { memory: 2048, cpu: 1024 });
const api     = new LambdaCompute(scope, 'api', { memory: 512 });
```

The category *is* the class. Maximum control and clarity for power users, but the class name leaks the service tier and the customer must know which class maps to which category. This is the original design the Problem section rejects for the default path, kept here as the always-available power-user escape (goal 2), not the recommended front door.

### Option 4 — provider for the "don't care" path, concrete blocks for control

```ts
import { ComputeProvider, ContainerCompute } from '@aws-blocks/blocks';

// "give me something sensible" — resolves to the app default (ephemeral today)
const simple  = ComputeProvider.provide('simple');

// "I care about the details" — full control
const complex = new ContainerCompute(scope, 'reports', { memory: 2048, cpu: 1024, maxConcurrency: 4 });

new ApiNamespace(scope, 'api', { compute: simple, /* ... */ });
new AsyncJob(scope, 'reports', { compute: complex, handler });
```

Two doors: a zero-config provider for customers who don't want to think about compute, and direct construction for customers who do. Both yield a `Compute`. This is the shape in PR #573. It satisfies "don't obfuscate the category" only at the concrete-block door; the provider door states no category at all, which reads as "default" rather than "hidden."

### Recommendation

**Option 2 (category factory methods).** It states the category unmissably (goal 4), keeps one coherent surface that produces the core `Compute` type, and exposes only the attributes each category can honor. It reads as Cloud-not-AWS (`Compute.container`, not `FargateService`), and Option 3's concrete classes remain available underneath for power users (goal 2) and for "bring your own compute" (goal 3).

Option 1 is the close runner-up and is simpler to implement; the only thing it gives up is per-category attribute narrowing (an `ephemeral` compute would accept `cpu` in the type and reject it at synth, rather than not offering it at all). Option 4's provider can be layered on top of either 1 or 2 later as the zero-config door without changing the category surface.

Whichever we pick, the compute produced must extend `Scope` (so workloads and finalize steps get a `fullId`, tree position, and registry entry), and the `AsyncJob` `compute` + `timeoutSeconds` surface above is the same.

---

## Appendix A - Why favor explicit compute types

Customers may not be experts in the underlying AWS services or may not care to tinker; but they understand the difference between a *short lived container*, a *long lived container*, and *dedicated hardware*. This document assumes that customers broadly understand the cost and performance implications of each of these and that the implications can be easily documented for customers who *don't* understand. In contrast, hiding the decision behind opaque attributes like `requiredMemoryMB` and `requiredTimeout` creates an interface that contradicts the overarching design goals in two ways.

**Firstly**, it forces even semi-knowledable customers to reverse engineer their decisions. Customers who understand they want the "pay-as-you" go `Compute` option would need to understand *more* about the AWS services than if we just clearly forced them to deliberately choose an `short-lived`, `pay-as-you-go`, or similar.

**Secondly**, some attributes would need to be "hoisted" into `Compute` that are not inherent properties of all types of `Compute`. Anything related to "time limits" becomes meaningless at the `Compute` layer once the 15 minute Lambda timeout is exceeded, for example. For Lambda (or "ephemeral" or "short-lived") compute, a ceiling could be set on the `Compute` itself, but the more "appropriate" place to establish timeouts may be on "job" definitions themselves. This is especially true for customers running a variety of jobs on anything other than Lambda &mdash; a customer SHOULD NOT be forced to give *carte blanche* permission for any job running on a shared container to run for hours in order to allow ONE or TWO jobs permission to do so.

Time limits were proposed as a deciding factor for which compute is selected by the `Compute` block. But, time limits aren't a property of compute (generally). They're a property of "work."

These contradictions preclude options that *completely* hide the compute type selection. Hiding the AWS service is AWS Block's job. Hiding an entire category of technical **concepts** is not the point.
