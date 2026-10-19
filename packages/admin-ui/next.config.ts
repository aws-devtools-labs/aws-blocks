// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
	// The dashboard is served by a local custom server (src/server/start.ts)
	// that binds to 127.0.0.1 and gates /api with a session token.
};

export default nextConfig;
