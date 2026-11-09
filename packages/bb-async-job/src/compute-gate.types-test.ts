// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Type tests for how `AsyncJob`'s `compute` option and the container-only
 * `maxConcurrencyPerCPU` knob interact with the payload generic `T`.
 *
 * The compile IS the test — no runtime assertions. A `@ts-expect-error` line
 * asserts the next statement is a type error; if that error ever disappears,
 * `tsc --build` fails on the now-unsatisfied directive. A plain (un-commented)
 * statement asserts the opposite: it must compile.
 *
 * `AsyncJobOptions<T>` is a discriminated union on `compute`: a container compute
 * carries `maxConcurrencyPerCPU`; a serverless compute (or none) types it `never`.
 * The compute kind is inferred from the `compute` argument — there is no second
 * type parameter — so `T` stays first-class and `new AsyncJob<Payload>(…)` with a
 * container compute still compiles. These cases pin that behavior (both the
 * schema-inferred-`T` path and the explicit-`T` path), and that the knob is a
 * compile error without a container compute (it is also guarded at synth).
 *
 * @internal
 */

import type { ScopeParent } from '@aws-blocks/core';
import type { ComputeProvider } from '@aws-blocks/core/cdk/internal';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { AsyncJob } from './index.mock.js';

declare const scope: ScopeParent;
type Payload = { to: string };

// A container compute and a serverless one, as the public `ComputeProvider<K>`
// contract the options union keys on. (Declared, not constructed — this is a
// type test; the real `Compute`/`ContainerCompute` satisfy `ComputeProvider<K>`.)
declare const container: ComputeProvider<'container'>;
declare const serverless: ComputeProvider<'serverless'>;
// A StandardSchemaV1 for the primary path: T is inferred FROM the schema, so no
// explicit type parameter is supplied — the main way customers set a payload type.
declare const schema: StandardSchemaV1<Payload>;

// ─────────────────────────────────────────────────────────────────────────────
// (0a) PRIMARY PATH — schema + container + knob, all inferred (no type params).
//      T comes from the schema; the container kind comes from the compute arg.
//      MUST COMPILE with the knob allowed.
// ─────────────────────────────────────────────────────────────────────────────
function schemaOnContainerWithKnob() {
	new AsyncJob(scope, 'j0a', {
		schema,
		compute: container,
		handler: async (_p: Payload) => {},
		maxConcurrencyPerCPU: 4,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// (0b) schema + serverless + knob — MUST be a COMPILE error (knob is container-only).
// ─────────────────────────────────────────────────────────────────────────────
function schemaOnServerlessWithKnobIsError() {
	// @ts-expect-error — maxConcurrencyPerCPU is container-only.
	new AsyncJob(scope, 'j0b', {
		schema,
		compute: serverless,
		handler: async (_p: Payload) => {},
		maxConcurrencyPerCPU: 4,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) xyos #1 — explicit payload generic + container compute. MUST COMPILE.
//     This failed on the prior design (TS2322: Compute<'container'> not
//     assignable to ComputeProvider<'serverless'>), because supplying `T`
//     stopped `C` from being inferred and it fell back to the serverless default.
//     The no-second-generic union removes that failure mode.
// ─────────────────────────────────────────────────────────────────────────────
function explicitPayloadOnContainer() {
	new AsyncJob<Payload>(scope, 'j1', {
		compute: container,
		handler: async (_p: Payload) => {},
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) explicit payload generic + container + the container-only knob. MUST COMPILE.
// ─────────────────────────────────────────────────────────────────────────────
function explicitPayloadOnContainerWithKnob() {
	new AsyncJob<Payload>(scope, 'j2', {
		compute: container,
		handler: async (_p: Payload) => {},
		maxConcurrencyPerCPU: 4,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// (3) inferred payload + container + knob. MUST COMPILE (today's happy path).
// ─────────────────────────────────────────────────────────────────────────────
function inferredPayloadOnContainerWithKnob() {
	new AsyncJob(scope, 'j3', {
		compute: container,
		handler: async (_p: Payload) => {},
		maxConcurrencyPerCPU: 4,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// (4) Simone #4 — the container-only knob on a SERVERLESS compute.
//     We WANT this to be a compile error (plus the existing synth guard).
//     If a design can only reject it at synth, this directive goes unused and
//     the test will tell us (TS "unused @ts-expect-error").
// ─────────────────────────────────────────────────────────────────────────────
function knobOnServerlessIsError() {
	// @ts-expect-error — maxConcurrencyPerCPU is container-only (error attaches to
	// the whole options arg, since the serverless union arm types the knob `never`).
	new AsyncJob<Payload>(scope, 'j4', {
		compute: serverless,
		handler: async (_p: Payload) => {},
		maxConcurrencyPerCPU: 4,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// (5) the knob with NO compute (app default is serverless). WANT a compile error.
// ─────────────────────────────────────────────────────────────────────────────
function knobWithNoComputeIsError() {
	// @ts-expect-error — no compute → serverless arm → knob typed `never`.
	new AsyncJob<Payload>(scope, 'j5', {
		handler: async (_p: Payload) => {},
		maxConcurrencyPerCPU: 4,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// (6) serverless compute, no knob, explicit payload. MUST COMPILE.
// ─────────────────────────────────────────────────────────────────────────────
function explicitPayloadOnServerless() {
	new AsyncJob<Payload>(scope, 'j6', {
		compute: serverless,
		handler: async (_p: Payload) => {},
	});
}

export {
	schemaOnContainerWithKnob,
	schemaOnServerlessWithKnobIsError,
	explicitPayloadOnContainer,
	explicitPayloadOnContainerWithKnob,
	inferredPayloadOnContainerWithKnob,
	knobOnServerlessIsError,
	knobWithNoComputeIsError,
	explicitPayloadOnServerless,
};
