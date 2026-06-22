// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — OtelTracer is server-side only.
// No-op implementation: startSegment still runs the wrapped fn (with a no-op segment),
// everything else is inert, so bundlers don't pull the OTel SDK into the browser.

import type { Segment, StartSegmentOptions, Context } from './types.js';

export type {
	Segment,
	AnnotationValue,
	StartSegmentOptions,
	OtelTracerOptions,
	SpanKind,
	Link,
	Tracer,
	Context,
} from './types.js';

const NO_OP_SEGMENT: Segment = {
	addAnnotation() {},
	addMetadata() {},
	addEvent() {},
	addError() {},
	setHttpStatus() {},
};

export class OtelTracer {
	constructor(..._args: any[]) {}
	async startSegment<T>(_name: string, fn: (segment: Segment) => Promise<T>, _options?: StartSegmentOptions): Promise<T> {
		return fn(NO_OP_SEGMENT);
	}
	addAnnotation(): void {}
	addMetadata(): void {}
	addEvent(): void {}
	getTraceId(): string | null { return null; }
	inject(): void {}
	extract(_carrier: Record<string, string>): Context { return {} as Context; }
	get rawTracer(): any { return { startSpan: () => ({}), startActiveSpan: (_n: any, _o: any, fn: any) => fn({}) }; }
}
