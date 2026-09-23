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

4. The design SHOULD NOT obfuscate the "general type" or "category" of `Compute` being used.

This proposed fourth goal stands on the assumption that most customers understand the difference between broad categories of compute. They may not be experts in the underlying AWS services or may not care to tinker; but they understand the difference between a *short lived container*, a *long lived container*, and *dedicated hardware*. This document assumes that customers broadly understand the cost and performance implications of each of these and that the implications can be easily documented for customers who *don't* understand.

Ultimately, I would argue that putting the "what kind of compute" decision behind opaque "attributes" like `requiredMemoryMB` and `requiredTimeout` creates interfaces that contradict the overarching design goals in two ways.

**Firstly**, it forces even semi-knowledable customers to reverse engineer their decisions. Customers who understand they want the "pay-as-you" go `Compute` option would need to understand *more* about the AWS services than if we just clearly forced them to deliberately choose an `short-lived`, `pay-as-you-go`, or similar.

**Secondly**, some attributes would need to be "hoisted" into `Compute` that are not inherent properties of all types of `Compute`. Anything related to "time limits" becomes meaningless at the `Compute` layer once the 15 minute Lambda timeout is exceeded, for example. For Lambda (or "ephemeral" or "short-lived") compute, a ceiling could be set on the `Compute` itself, but the more "appropriate" place to establish timeouts may be on "job" definitions themselves. This is especially true for customers running a variety of jobs on anything other than Lambda &mdash; a customer SHOULD NOT be forced to give *carte blanche* permission for any job running on a shared container to run for hours in order to allow ONE or TWO jobs permission to do so.

Time limits were proposed as a deciding factor for which compute is selected by the `Compute` block. But, time limits aren't a property of compute (generally). They're a property of "work."

So, I propose that these two contradictions rule out some options previously discussed *ad hoc* in Slack, small groups, etc.

## Proposed Solution

The proposed solution is a single `Compute` Block or factory that clearly asks customers to state the *type* of `Compute` they want as an attribute. The `type` (or possibly `category`) will communicate everything that both new and advanced customers need to know about the cost, scaling, and performance implications.


---

## Question 1 — how you declare a compute

Two interfaces exist in open PRs, plus a couple of variants worth naming.

### Option A — `new Compute(scope, id, caps)` (PR #574, this branch)

A constructor. Returns the concrete backing compute (a branded `LambdaCompute` or
`ContainerCompute`); the customer holds a `ComputeHandle` and passes it to a
handler-bearing block.

```ts
const worker = new Compute(scope, 'worker', { timeoutSeconds: 1800, memory: 2048 });
const jobs   = new AsyncJob(scope, 'jobs', { compute: worker, handler });
```

- Capabilities: `timeoutSeconds`, `memory`, `cpu`, `longLived`, `image`, `maxConcurrency`,
	`scaling` (reserved).
- Resolves **now**: `selectComputeKind()` picks Lambda vs container from the caps. Container
	is a real fulfillment on this branch.
- Nothing exceeds a limit and "fails" — a bigger requirement selects a bigger compute.
	Clamps nothing.

Pros
- Selection is live today (Lambda + container), so the interface is exercised, not
	just declared.
- Constructor is the same shape as every other block (`new X(scope, id, opts)`),
	so it reads consistently and gets a `fullId`, tree position, registry entry.
- Attribute set already covers container-only dials (cpu, longLived, image,
	concurrency) that a serverless-only vocabulary has no place for.

Cons
- Constructor returning a *different* class than the one named is a mild
	surprise (JS return-override). It works and is typed as a handle, but it's a
	raised eyebrow in review.
- Richer attribute set is more surface to commit to now.

### Option B — `ComputeProvider.provide(id, requirements, scope?)` (PR #573)

A factory. Returns the condition-resolved compute as an opaque handle. Requirements
are the minimal serverless-shaped pair.

```ts
const reports = ComputeProvider.provide('reports', { timeoutSeconds: 240, memoryMb: 1024 });
```

- Requirements: `timeoutSeconds`, `memoryMb` (note `memoryMb`, not `memory`).
- Resolves to serverless **only** today; a requirement beyond serverless limits
	**throws** (fail-fast, names the field/value/ceiling) rather than selecting a
	bigger compute — because there is no other fulfillment in its branch.
- Validation is pure and runs in every condition (local dev fails the same as
	synth).

Pros
- Smallest surface; declares intent without naming a service; easy to review.
- Fail-fast-with-a-named-ceiling is a good error UX when there genuinely is no
	bigger compute to pick.
- Factory that returns an opaque handle avoids the return-override sleight of hand.

Cons
- "Select by requirements" is aspirational in this PR — today it validates and
	configures one fulfillment. The selection claim isn't tested against a second
	fulfillment.
- Vocabulary is serverless-shaped (`timeoutSeconds`, `memoryMb`) with no room for
	container-only dials (cpu, long-lived, image, concurrency). Those have to be
	added later, and `memoryMb` vs our `memory` is a naming fork to reconcile.
- "Fails rather than selects" is the opposite policy from Option A. Once a second
	fulfillment exists, the *same* over-limit input must flip from "throw" to
	"select container." That's a behavior change to a shipped surface.

### Option C — one surface, provider semantics, capability vocabulary (merge of A+B)

Keep #573's `provide()` factory shape (opaque handle, no return-override, pure
validation in every condition) but adopt #574's fuller capability vocabulary and
its **select-don't-fail** policy the moment a second fulfillment exists.

```ts
const worker = ComputeProvider.provide('worker', { timeoutSeconds: 1800, memory: 2048 });
```

- One attribute vocabulary (settle `memory` vs `memoryMb` once).
- Validation still fails-fast when *no* fulfillment can satisfy the request; it
	*selects* when a larger one can. Same rule, both PRs, no later flip.
- Container attributes (cpu, longLived, image, maxConcurrency, scaling) live in
	the same vocabulary from day one, ignored while only serverless exists.

Pros
- Removes the competing-interfaces problem before it hardens: one factory, one
	vocabulary, one selection policy.
- Keeps the better bits of each — B's handle/validation ergonomics, A's real
	selection and container dials.

Cons
- Requires reconciling the two PRs rather than merging both as-is (coordination
	cost now to avoid a breaking reconciliation later).

### Option D — status quo: ship both

`new Compute()` and `ComputeProvider.provide()` both exist.

- Two ways to do the same thing, with different names, attribute spellings
	(`memory` vs `memoryMb`), and opposite over-limit policies (select vs throw).
- Whichever the assignment surface (`{ compute }`) consumes wins by attrition;
	the other becomes legacy. Predictably confusing; not recommended.

---

## Recommendation for Question 1

Option C. The two PRs are solving the same problem with different shapes, and the
cheapest time to converge is before either is consumed by the assignment surface.
Concretely: adopt #573's `provide()` factory and validation ergonomics, adopt
#574's capability vocabulary and select-don't-fail policy, and settle the
`memory`/`memoryMb` spelling once. Fail-fast is retained for the genuine
no-fulfillment-fits case; it is not used to reject a request a larger compute
could serve.

If C is too much coordination right now, prefer A over B on the single ground
that A's selection is real and tested against two fulfillments today, whereas B's
is declared but unexercised — and B's serverless-shaped vocabulary and
throw-on-over-limit policy are the two things most likely to need a breaking
change once containers land.

---

## Question 2 — should `AsyncJob` also have a timeout?

Context: the compute already carries `timeoutSeconds`, which the container poller
enforces by terminating the worker. The question is whether a job additionally
sets its own timeout.

### The case for a per-job timeout

- A compute is shared across handlers (a scope-level or reused compute can back
	several jobs/namespaces). Different jobs on the same compute may want different
	deadlines. Only a per-job value expresses that.
- It reads naturally at the job call site — the place you reason about how long
	*this* work should take.

### The case against (or for keeping it subordinate)

- The compute timeout is a *capacity/cost* bound (it's what selects a container
	and what sizes/limits the runtime). A per-job value that could *exceed* it would
	be meaningless — the compute can't run longer than its own ceiling.
- Two timeouts invite the question "which wins," which is exactly the ambiguity to
	avoid in a public API.

### Resolution: lesser-of-the-two, with the compute as the hard ceiling

If both are set, the effective deadline is `min(compute.timeoutSeconds,
job.timeoutSeconds)`. Rationale:

- The compute's value is a **ceiling** — a job can ask to be *stricter* (finish
	sooner) but never *looser* (a job can't outlive the runtime that hosts it, and
	on Lambda the platform enforces the function timeout regardless).
- So a per-job timeout is only ever a *tightening*. `min` is the whole rule; there
	is no case where the job value legitimately raises the limit.
- Validation: reject a per-job `timeoutSeconds` greater than the compute's at
	synth with a named error, rather than silently clamping — same fail-fast posture
	as the requirements validation. (Silent `min` is defensible too, but an explicit
	"job asks for 30m on a 15m compute" error is clearer than quietly running 15m.)

This keeps one enforcement mechanism (the compute/worker deadline) and treats the
per-job value as a downward override, so "which wins" has a one-line answer: the
smaller one, and the compute is always the cap.

### Interaction with selection (important)

If we add a per-job timeout, be careful it does **not** feed compute *selection* —
only the compute's own attributes select the compute. A job asking for 30 minutes
should not silently *upgrade* a Lambda compute to a container; that would make the
job's timeout a hidden infrastructure switch. The job timeout tightens an
already-selected compute; it never changes which compute is chosen. (If a customer
wants a container, they express it on the compute, where cost lives.)

---

## Other attributes worth considering (parking lot)

Named here so they're weighed alongside, not to decide now:

- `cpu` — container-only; Lambda derives CPU from memory. Already in A; absent in B.
- `longLived` / persistence — selects a container; also the future WebSocket/stream
	signal. Naming: `longLived` reads as a workload trait; `persistent` reads as
	storage. Prefer `longLived`.
- `image` — BYO container image; intrinsically a container request.
- `maxConcurrency` — per-task cost lever (jobs-in-flight); container-only.
- `scaling` (min/max tasks, backlog-per-task) — reserved for task autoscaling;
	additive.
- `ephemeralStorageMb` / disk — not yet needed; note as a likely future serverless
	*and* container dial.
- `architecture` (arm64/x86) — exists internally on Lambda today; could surface as
	a capability once there's a reason to.

Guidance: whatever vocabulary we settle, keep serverless-satisfiable attributes
(`timeoutSeconds`, `memory`) separate in the docs from container-only ones (`cpu`,
`longLived`, `image`, `maxConcurrency`, `scaling`) so it's obvious which attributes
can force a container.
