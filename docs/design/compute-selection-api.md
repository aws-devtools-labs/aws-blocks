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

> **Open — type names.** These names are placeholders. We need terms for the
> two shipping types that read as a consistent set with the future ones and don't
> mix axes: `serverless` names a billing model, `container` names a packaging
> model, `vm` names a machine, `kubernetes` names a technology. Find a naming
> axis (lifecycle? isolation level?) that fits all four, and settle better terms
> for `serverless` and `container` in particular. The alternative-tags column
> holds candidates. (Terminology research is a to-do.)

### Compute options

Each type has its own options. Options that don't apply to a type are absent from its interface, so an unsupported attribute is a static compile-time error rather than a deploy time error.

A container's CPU and memory are not independent: each vCPU size permits only a fixed set of memory values. `ContainerSize` encodes that as a discriminated union. Invalid pairs (`0.25` vCPU with 16GB) cannot be represented, and the IDE will help funnel human coders into valid combinations.

```ts
/**
 * Valid container vCPU + memory (MB) combinations. Each vCPU permits only its
 * listed memory values. Invalid pairs fail at build time.
 */
type ContainerSize =
  | { vcpu: 0.25; memory: 512 | 1024 | 2048 }
  | { vcpu: 0.5; memory: 1024 | 2048 | 3072 | 4096 }
  | { vcpu: 1; memory: 2048 | 3072 | 4096 | 5120 | 6144 | 7168 | 8192 }
  | { vcpu: 2; memory: 4096 | 5120 | /* 1GB steps */ 15360 | 16384 }
  | { vcpu: 4; memory: 8192 | 9216 | /* 1GB steps */ 29696 | 30720 }
  | { vcpu: 8; memory: 16384 | 20480 | /* 4GB steps */ 57344 | 61440 }
  | { vcpu: 16; memory: 32768 | 40960 | /* 8GB steps */ 114688 | 122880 };

interface ServerlessComputeOptions {
  /** Memory (MB). CPU scales with memory on a serverless compute. */
  memory?: number;
  /**
   * The maximum number of seconds an assigned job can run on this compute.
   * The maximum possible setting is 900.
   */
  maxTimeoutSeconds?: number;
}

interface ContainerComputeOptions {
  /** A valid vCPU + memory combination. */
  size?: ContainerSize;
  /** Instance-count bounds and scaling strategy. See the scaling note below. */
  scaling?: ContainerScaling;
  /** Custom container image (ECR URI or build context). */
  image?: string;
}

type ContainerScaling = {
  /** Minimum running instances. Default 1. */
  minInstances: number;
  /** Maximum running instances. Default 1 (no scaling). */
  maxInstances: number;
  /**
   * One or more signals that drive scaling. With several, scale-out satisfies
   * whichever signal demands the most instances; scale-in happens only when all
   * agree it is safe. Leave empty for Blocks to assign sane defaults.
   */
  strategy?: ScalingSignal | ScalingSignal[];
};

type ScalingSignal =
  | { on: 'cpu'; targetPercent: number }
  | { on: 'memory'; targetPercent: number }
  | { on: 'queue-depth'; backlogPerInstance: number };
```

Not all forms of compute have inherent time limits. A job's time limit is primarily a property of work, not of compute (Appendix A). Where a compute type *does* have an inherent ceiling ("serverless") whose platform caps every function at 15 minutes, that ceiling sets absolute maximum runtime. Individual workloads additionally specify their own max runtimes which must be *under* the ceiling enforced by the compute. Since containers and VMs have no ceiling, the only relevant limit is the limit defined on the job.

### How `AsyncJob` consumes a `Compute`

A workload takes a `compute` and a universal `timeoutSeconds`, additive to the existing `AsyncJobOptions`. We have options for how to let customers define per-instance **concurrency**. Those are presented later in the doc.

```ts
interface AsyncJobOptions<T> {
  handler: (payload: T, ctx: AsyncJobContext) => Promise<void>;
  // ...existing options (schema, maxRetries, batchSize, trackStatus)...

  /** Where this job runs. Omit to use the app default (serverless). */
  compute?: Compute;

  /**
   * Wall-clock limit for one delivery in seconds.
   */
  timeoutSeconds?: number;

  // maxConcurrencyPerInstance — placement is the "Concurrency Options" decision below.
}
```

Example usage:

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

### Option 1 &mdash; `new Compute` with `type: ComputeType` (SELECTED)

In this option, we present a single `Compute` block with a required `type` field. This fits the `new X(scope, id, options)` shape that other Building Block use, so it composes uniformly and gets a `fullId`, tree position, and registry entry.

```ts
import { Compute } from '@aws-blocks/blocks';

const reports = new Compute(scope, 'reports', { type: 'container', size: { vcpu: 1, memory: 2048 } });
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

const reports = Compute.container(scope, 'reports', { size: { vcpu: 1, memory: 2048 } });
const api     = Compute.serverless(scope, 'api', { memory: 512 });
```

This is nearly identical to Option 1 except the compute type is a factory method instead of a `type` property in the `options` parameter. This technically reduces "keystrokes", but breaks the Building Block instantiation pattern.

### Option 3 &mdash; distinct blocks per type

```ts
import { ServerlessCompute, ContainerCompute } from '@aws-blocks/blocks';

const reports = new ContainerCompute(scope, 'reports', { size: { vcpu: 1, memory: 2048 } });
const api     = new ServerlessCompute(scope, 'api', { memory: 512 });
```

Each class is named by the compute type (`ContainerCompute`, `ServerlessCompute`) and takes that type's options (`ContainerComputeOptions`, `ServerlessComputeOptions`). It multiplies the block surface to one class per type, and "which types exist" is a matter of which classes are importable rather than one `type` union. (Service-named variants like `EcsCompute` and `LambdaCompute` are contrary to the Blocks goals. Examples discussed in Appendix B.).

This option is not technically a violation of current Blocks goals, but it is a "spiritually" contradiction with recent decisions to consolidate where possible. (Examples being in the `Auth` block and *possibly* the `Database` block(s).)

### Customizing and extending

As usual, a customer who wants finer control sets more of the same options (`size`, `scaling`, `image`) and can drop into raw CDK and/or vendorize for anything the options don't cover (goal 2).

---

## Concurrency Options

We need to decide how a a compute and job combination accounts for concurrency. The tension is that `container`, `ec2`, and `kubernetes` options will all have the concept of threads or processes that we could leverage. And, `concurrency` isn't strictly a function of how many threads or processes are assigned to a job or handler. Further complicating the story, time limits aren't strictly enforcible outside of `serverless` unless we restrict each thread to a concurrency of **one**. (You can "ask" a running job to stop, but unless it's bound 1-to-1 with a thread or process, you cannot forcefully terminate it without collateral damage.)

This is now decided: **Option 4** (below). The option write-ups below were AI-drafted.

### Option 1 — on the compute

```ts
const worker = new Compute(scope, 'worker', {
  type: 'container',
  size: { vcpu: 1, memory: 2048 },
  maxConcurrencyPerInstance: 4,
});

new AsyncJob(scope, 'reports', { compute: worker, handler });
```

Concurrency is a property of the compute. Simple to type (it only exists on `ContainerComputeOptions`, so serverless never sees it). But it forces every job sharing that compute to accept the same concurrency — the carte-blanche problem (Appendix A): job A and job B on one container can't have different parallelism, and tuning one changes the ceiling for the other.

### Option 2 — on the job, conditioned by the compute's type

```ts
new AsyncJob(scope, 'reports', {
  compute: containerWorker,       // TS infers a container compute
  maxConcurrencyPerInstance: 4,   // allowed
  handler,
});

new AsyncJob(scope, 'emails', {
  compute: serverlessDefault,     // TS infers serverless
  maxConcurrencyPerInstance: 4,   // COMPILE ERROR — serverless has no per-instance cap
  handler,
});
```

Concurrency is per-job (each job sets its own), and `AsyncJobOptions` is generic over the injected compute's type so the knob only appears when the compute enforces it. The default compute cannot be given a setting it ignores — it is a compile error, not a silently-dropped property. Keeps the one-object ergonomics; costs a conditional/generic type on `AsyncJobOptions`.

### Option 3 — a mapper object that joins jobs to compute

```ts
const compute = new Compute(scope, 'worker', { type: 'container', size: { vcpu: 1, memory: 2048 } });

// The mapper carries per-job execution policy and is only constructible against
// compute types that honor it.
const reports = new ExecutionStrategy(compute, { maxConcurrencyPerInstance: 4, timeoutSeconds: 600 });

new AsyncJob(scope, 'reports', { execution: reports, handler });
```

A third construct (`ExecutionStrategy` / `ExecutionPolicy`) maps a job to a compute and carries the execution knobs, constructible only against compute types that support them. Per-job (no carte blanche) and reusable across jobs as a named profile. Costs a third object to wire per workload and a less obvious "where does this setting live" story; earns its keep only if execution profiles are shared across many jobs.

### Option 4 — on the job, (v)CPU concurrency multiplier (SELECTED)

```ts
const worker = new Compute(scope, 'worker', {
  type: 'container',
  size: { vcpu: 2, memory: 2048 },
});

new AsyncJob(scope, 'reports', {
  compute: containerWorker,   // TS infers a container compute
  maxConcurrencyPerCPU: 4,    // allowed. 4 x 2 vCPU = 8 concurrent per instance
  handler,
});

new AsyncJob(scope, 'emails', {
  compute: serverlessDefault, // TS infers serverless
  maxConcurrencyPerCPU: 4,    // COMPILE ERROR — serverless has no per-instance cap
  handler,
});
```

Like Option 2, concurrency is per-job and compute-conditional (the knob only exists when the compute is one that has vCPUs to multiply against, so serverless rejects it at compile time). The difference is the unit: instead of an absolute per-instance count, the job states concurrency **per vCPU**, and Blocks multiplies by the compute's `size.vcpu` to get the per-instance figure. This ties a job's parallelism to the compute it lands on, so the same job scales its concurrency with the instance size rather than being pinned to an absolute number that a customer must re-tune when they resize the box.

**v1 scope.** We deliberately do not expose threading control or a soft-vs-hard time-limit choice yet. So for now **one unit of concurrency is one thread**, which keeps hard time limits enforceable (a job bound 1:1 to a thread can be forcibly terminated). What `maxConcurrencyPerCPU` *does* give the customer is control over how IO-bound vs CPU-bound their work is: IO-bound work that spends most of its time awaiting can set a higher value; CPU-bound work sets 1 (or omits it).

**Rounding.** `size.vcpu` can be fractional and concurrency must be a whole number ≥ 1, so:

```
perInstanceConcurrency = max(1, ceil(maxConcurrencyPerCPU × size.vcpu))
```

`ceil` because rounding up never silently drops below the requested ratio; `max(1, …)` because a container always runs at least one unit of work. Examples: `0.25 vCPU × 8 = 2`; `0.25 vCPU × 1 = 1` (a quarter-vCPU box still runs one thread). A consequence is that at fractional vCPUs the "per CPU" ratio rounds up — a `0.25` vCPU compute runs at least one thread regardless of the multiplier — so treat `maxConcurrencyPerCPU` as a target that floors at one thread per instance, not an exact multiplier at the low end.

### Recommendation

**Option 4 (selected.)** It keeps concurrency where it belongs — per-job and compute-conditional, so the default (serverless) compute can't be handed a knob it ignores (compile error, not a silent no-op) — while expressing the amount as a multiplier of the compute's vCPUs rather than an absolute count. Effective per-instance concurrency is `max(1, ceil(maxConcurrencyPerCPU × size.vcpu))`, so resizing the compute scales a job's parallelism with it instead of stranding a hand-tuned absolute. Option 2 was the runner-up (same placement, absolute count); Option 1 reintroduces carte blanche across co-located jobs; Option 3's mapper is only worth its extra construct if reusable named profiles become a real requirement.

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