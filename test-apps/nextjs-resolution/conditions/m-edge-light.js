// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Stub: stands in for the RPC client. Only `react-server` gets the real backend.

export const MARKER = 'cond:edge-light';
export async function roundTrip() {
	return { wrote: false, read: 'stub:edge-light' };
}
export async function dbRoundTrip() {
	return { latest: 'stub:edge-light', count: -1 };
}
