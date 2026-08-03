// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Stub: stands in for the RPC client. Only `react-server` gets the real backend.

module.exports = {
	MARKER: 'cond:require',
	roundTrip: async () => ({ wrote: false, read: 'stub:require' }),
	dbRoundTrip: async () => ({ latest: 'stub:require', count: -1 }),
};
