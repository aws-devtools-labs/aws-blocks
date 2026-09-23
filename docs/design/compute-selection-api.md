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

The design has three parts: a set of **options common to all** compute (the type and the tuning attributes), how a compute is **consumed** by a workload such as `AsyncJob`, and the **declaration surface** itself — the one part the options below actually differ on. The common options and the consumption contract are the same no matter which declaration surface we choose, so they are settled first and the options section is left to argue only the surface.

### Compute types

The type is the one thing a customer must state. It names the general kind of compute, not the AWS service.

```ts
type ComputeType =
  | 'ephemeral'    // pay-as-you-go, per-request, short-lived (Lambda today)
  | 'container'    // long-running / long-lived process (Fargate today)
  | 'dedicated';   // reserved capacity (EC2/EKS later)
```

### Common options

Every option below accepts the same tuning attributes. The type selects the compute; these configure it. Attributes that don't apply to a type are a synth-time error rather than silently ignored, so a customer can't set `vcpu` on an `ephemeral` compute and wonder why nothing changed.

```ts
/** Valid vCPU sizes. Not an open number: the platform allows only a fixed set. */
type Vcpu = 0.25 | 0.5 | 1 | 2 | 4 | 8 | 16;

interface ComputeOptions {
  /** The general kind of compute. Required — never inferred from other attributes. */
  type: ComputeType;

  /** Memory (MB). Applies to all types. */
  memory?: number;

  /** vCPUs. `container`/`dedicated` only. A closed set, not an arbitrary number. */
  vcpu?: Vcpu;

  /** Max concurrent units of work per instance. `container`/`dedicated` only; the per-task cost lever. */
  maxConcurrency?: number;

  /** Custom image. `container`/`dedicated` only. */
  image?: string;
}
```

`vcpu` is a closed union, not an open `number`, because the container platform accepts only a fixed set of sizes. `vcpu` and `memory` are also **coupled** — each vCPU size permits only a range of memory values — so an invalid pair (e.g. `0.25` vCPU with 16GB) is a synth-time error naming the valid range, not a silent clamp. (An alternative worth weighing in review: collapse both into a single `size` enum of named CPU+memory combos, so an invalid pair is impossible by construction. That trades granularity for guaranteed validity.)

Note what is *not* here: there is no `timeout` on the compute. Time limits are a property of work, not of compute (Appendix A). A ceiling could live on an `ephemeral` compute because the platform enforces one anyway, but hoisting it onto every type is the contradiction goal 4 rules out. Timeouts live on the workload — see below.

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

## API Options

Each option below produces a `Compute` object that can be injected into "job"-type blocks like `AsyncJob`. The differences hinge on how customers navigate imports and instantiate the `Compute`.

### Option 1 &mdash; `new Compute` with `type: ComputeType` (RECOMMENDED)

In this option, we present a single `Compute` block with a required `type` field. This fits the `new X(scope, id, options)` shape that other Building Block use, so it composes uniformly and gets a `fullId`, tree position, and registry entry.

```ts
import { Compute } from '@aws-blocks/blocks';

const reports = new Compute(scope, 'reports', { type: 'container', memory: 2048, vcpu: 1 });
const api     = new Compute(scope, 'api',     { type: 'ephemeral', memory: 512 });

new AsyncJob(scope, 'reports', { compute: reports, timeoutSeconds: 60 * 30, handler });
```

The `options` parameter shares the common `ComputeOptions` type and adds `type: ComputeType`:

```ts

```

### Option 2 &mdash; type as a factory method

```ts
import { Compute } from '@aws-blocks/blocks';

const reports = Compute.container(scope, 'reports', { memory: 2048, vcpu: 1 });
const api     = Compute.ephemeral(scope, 'api', { memory: 512 });
```

The type becomes the method name. Autocomplete lists the types, the choice can't be misspelled, and each method exposes only the attributes valid for its type (no `vcpu` on `ephemeral`). Adding a type later is a new method (additive). The cost is departing from the uniform `new X(scope, id, options)` shape every other block uses, and a slightly larger surface (one method per type) to document.

### Option 3 &mdash; distinct blocks per type

```ts
import { EphemeralCompute, ContainerCompute } from '@aws-blocks/blocks';

const reports = new ContainerCompute(scope, 'reports', { memory: 2048, vcpu: 1 });
const api     = new EphemeralCompute(scope, 'api', { memory: 512 });
```

The type *is* the class, named by the general kind of compute (`ContainerCompute`, `EphemeralCompute`) rather than the service. Explicit and discoverable, but it multiplies the block surface (one class per type) and makes "which types exist" a matter of knowing which classes to import rather than reading one `type` union. Service-named variants (`EcsCompute`, `LambdaCompute`) are discarded outright for leaking the service into the IFC layer (goals 1 and 4) — see Appendix B.

### Customizing and extending

Whichever option we choose, a customer who wants finer control configures the compute through the same options (`memory`, `vcpu`, `maxConcurrency`, `image`), and can drop into raw CDK for anything the options don't cover (goal 2). This is ordinary Blocks customization, not an escape from Blocks — the same way any block exposes configuration and a CDK drop-through. Nothing here is a separate "power-user" path; it is the same surface with more of it filled in.

### On `Scope`

The produced compute extends `Scope`, so workloads and finalize steps get a `fullId`, tree position, and registry entry. This is a live decision, not a constraint: the concrete computes already extend `Scope` in the container-jobs branch. A future zero-config provider (PR #573's `ComputeProvider.provide()`) can still return a `Scope`-backed compute typed as an opaque handle, so "produces the core `Compute`" and "is a `Scope`" are not in tension. The `AsyncJob` `compute` + `timeoutSeconds` surface is the same across all options.

---

## Appendix A - Why favor explicit compute types

Customers may not be experts in the underlying AWS services or may not care to tinker; but they understand the difference between a *short lived container*, a *long lived container*, and *dedicated hardware*. This document assumes that customers broadly understand the cost and performance implications of each of these and that the implications can be easily documented for customers who *don't* understand. In contrast, hiding the decision behind opaque attributes like `requiredMemoryMB` and `requiredTimeout` creates an interface that contradicts the overarching design goals in two ways.

**Firstly**, it forces even semi-knowledable customers to reverse engineer their decisions. Customers who understand they want the "pay-as-you" go `Compute` option would need to understand *more* about the AWS services than if we just clearly forced them to deliberately choose an `short-lived`, `pay-as-you-go`, or similar.

**Secondly**, some attributes would need to be "hoisted" into `Compute` that are not inherent properties of all types of `Compute`. Anything related to "time limits" becomes meaningless at the `Compute` layer once the 15 minute Lambda timeout is exceeded, for example. For Lambda (or "ephemeral" or "short-lived") compute, a ceiling could be set on the `Compute` itself, but the more "appropriate" place to establish timeouts may be on "job" definitions themselves. This is especially true for customers running a variety of jobs on anything other than Lambda &mdash; a customer SHOULD NOT be forced to give *carte blanche* permission for any job running on a shared container to run for hours in order to allow ONE or TWO jobs permission to do so.

Time limits were proposed as a deciding factor for which compute is selected by the `Compute` block. But, time limits aren't a property of compute (generally). They're a property of "work."

These contradictions preclude options that *completely* hide the compute type selection. Hiding the AWS service is AWS Block's job. Hiding an entire category of technical **concepts** is not the point.

---

## Appendix B - Discarded Options

Several patterns were raised before this doc and are ruled out by goals 1 and 4. Both **derive** the compute type from requested attributes (time limits, memory) instead of asking the customer to state it.

```ts
// Sub-option 1: Using distinct BB for each compute service
// Ruled out by goals 1 and 4, since it names the service.
const compute = new EcsCompute(scope, 'reports', { timeoutSeconds: 1800, memoryMb: 2048 });

// Sub-option 2: Using a `Compute` constructor
// Ruled out by goal 4
const compute = new Compute(scope, 'reports', { timeoutSeconds: 1800, memoryMb: 2048 });

// Sub-option 3: As a Factory function
// Ruled out by goal 4
const compute = ComputeProvider.provide('reports', { timeoutSeconds: 1800, memoryMb: 2048 });
const compute = chooseCompute('reports', { timeoutSeconds: 1800, memoryMb: 2048 });
```

The *proposed* options are also more open-ended. I.e., if we later find that customers *do* want to be completely ignorant of where their code runs, we can explore explicit `automatic` or `inferred` options:

```ts
const compute = new Compute(scope, 'reports', { type: 'inferred', timeoutSeconds: 1800 });
```