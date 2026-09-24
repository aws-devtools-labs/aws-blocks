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
The design has three parts: the **compute types** a customer chooses from, the **options** that configure each type, and how a compute is **consumed** by a workload such as `AsyncJob`. The options and the consumption contract hold across all three API options below; those options differ only in how the customer states the type.

### Compute types

Blocks supports three compute types:

| Type | Model | Alternative Tags | Backed by | Status |
| --- | --- | --- | --- | --- |
| `serverless` | Pay-as-you-go, per-request, short-lived | `ephemeral`, `on-demand`, `function` | Lambda | today |
| `container` | Long-running / long-lived process | `long-running`, `service`, `worker` | Fargate | today |
| `vm` | An instance you manage | `virtual-machine`, `instance`, `dedicated` | EC2 | future |
| `kubernetes` | Container orchestration on a cluster | `cluster`, `k8s`, `orchestrated` | EKS | future |

### Compute options

Each type has its own options. Options that don't apply to a type are absent from its interface, so an unsupported attribute is a compile error rather than a runtime surprise.

```ts
/** Valid vCPU sizes: a fixed set the platform accepts, not an open number. */
type Vcpu = 0.25 | 0.5 | 1 | 2 | 4 | 8 | 16;

interface ServerlessComputeOptions {
  /** Memory (MB). CPU scales with memory on a serverless compute. */
  memory?: number;
}

interface ContainerComputeOptions {
  /** Memory (MB). */
  memory?: number;
  /** vCPUs. Paired with memory into a valid task size. */
  vcpu?: Vcpu;
  /** Max concurrent units of work per instance; the per-task cost lever. */
  maxConcurrency?: number;
  /** Custom container image (ECR URI or build context). */
  image?: string;
}
```

`vcpu` and `memory` are coupled: each vCPU size permits only a range of memory values, so an invalid pair (`0.25` vCPU with 16GB) is a synth error naming the valid range. A single `size` enum of named CPU+memory combos is an alternative that makes invalid pairs unrepresentable, trading granularity for guaranteed validity.

There is no timeout on a compute. Time limits are a property of work, not of compute (Appendix A), so they live on the workload — see below.

> `image` on serverless: Lambda supports container images, but they must implement the Lambda Runtime API and are not the same artifact as a Fargate image. A custom serverless image is an advanced case deferred for now; Blocks builds the serverless bundle.

### How `AsyncJob` consumes a `Compute`

A workload takes a `compute` and its own `timeoutSeconds`. This is additive to the existing `AsyncJobOptions`.

```ts
interface AsyncJobOptions<T> {
  handler: (payload: T, ctx: AsyncJobContext) => Promise<void>;
  // ...existing options (schema, maxRetries, batchSize, trackStatus)...

  /** Where this job runs. Omit to use the app default (serverless). */
  compute?: Compute;

  /**
   * Wall-clock limit for one delivery, in seconds. A property of the work, not
   * the compute. Enforced by the runtime (on a container, by terminating the
   * worker); on a serverless compute it is bounded by the platform ceiling. A
   * per-job value may only tighten the compute's ceiling, never raise it; a
   * larger value is a synth error.
   */
  timeoutSeconds?: number;
}
```

```ts
const reports = /* a Compute from one of the options below */;

const nightly = new AsyncJob(scope, 'nightly-report', {
  compute: reports,
  timeoutSeconds: 60 * 30,   // may run 30 min
  handler: async (payload) => { /* ... */ },
});

const quick = new AsyncJob(scope, 'thumbnail', {
  compute: reports,          // same compute
  timeoutSeconds: 30,        // must finish in 30s
  handler: async (payload) => { /* ... */ },
});
```

Two jobs share one compute and set their own deadlines. Each may be stricter than the compute's ceiling; neither may exceed it.

---

## API Options

Each option below produces a `Compute` object that can be injected into "job"-type blocks like `AsyncJob`. The differences hinge on how customers navigate imports and instantiate the `Compute`.

### Option 1 &mdash; `new Compute` with `type: ComputeType` (RECOMMENDED)

In this option, we present a single `Compute` block with a required `type` field. This fits the `new X(scope, id, options)` shape that other Building Block use, so it composes uniformly and gets a `fullId`, tree position, and registry entry.

```ts
import { Compute } from '@aws-blocks/blocks';

const reports = new Compute(scope, 'reports', { type: 'container', memory: 2048, vcpu: 1 });
const api     = new Compute(scope, 'api',     { type: 'serverless', memory: 512 });

new AsyncJob(scope, 'reports', { compute: reports, timeoutSeconds: 60 * 30, handler });
```

The `options` parameter is a discriminated union on `type`, so each type offers only its own options and an unsupported attribute is a compile error:

```ts
type ComputeType = 'serverless' | 'container' | 'vm' | 'kubernetes';

type ComputeOptions =
  | ({ type: 'serverless' } & ServerlessComputeOptions)
  | ({ type: 'container' } & ContainerComputeOptions);
  // vm and kubernetes added when they land
```

### Option 2 &mdash; type as a factory method

```ts
import { Compute } from '@aws-blocks/blocks';

const reports = Compute.container(scope, 'reports', { memory: 2048, vcpu: 1 });
const api     = Compute.serverless(scope, 'api', { memory: 512 });
```

Each method takes that type's options directly (`Compute.container` takes `ContainerComputeOptions`, `Compute.serverless` takes `ServerlessComputeOptions`), so the type is fixed by the method and the discriminant disappears. Autocomplete lists the types and the choice can't be misspelled. The cost is departing from the `new X(scope, id, options)` shape other blocks use, and one method per type to document.

### Option 3 &mdash; distinct blocks per type

```ts
import { ServerlessCompute, ContainerCompute } from '@aws-blocks/blocks';

const reports = new ContainerCompute(scope, 'reports', { memory: 2048, vcpu: 1 });
const api     = new ServerlessCompute(scope, 'api', { memory: 512 });
```

Each class is named by the compute type (`ContainerCompute`, `ServerlessCompute`) and takes that type's options (`ContainerComputeOptions`, `ServerlessComputeOptions`). It multiplies the block surface to one class per type, and "which types exist" is a matter of which classes are importable rather than one `type` union. Service-named variants (`EcsCompute`, `LambdaCompute`) are discarded for naming the service — see Appendix B.

### Customizing and extending

A customer who wants finer control sets more of the same options (`memory`, `vcpu`, `maxConcurrency`, `image`) and can drop into raw CDK for anything the options don't cover (goal 2). This is the same customization surface every block exposes, filled in further.

### On `Scope`

The produced compute extends `Scope`, so workloads and finalize steps get a `fullId`, tree position, and registry entry. The concrete computes already extend `Scope` in the container-jobs branch. A zero-config provider (PR #573's `ComputeProvider.provide()`) can return a `Scope`-backed compute typed as an opaque handle, so producing the core `Compute` and being a `Scope` are compatible. The `AsyncJob` `compute` + `timeoutSeconds` surface is identical across all options.

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