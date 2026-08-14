// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Runtime } from 'aws-cdk-lib/aws-lambda';

/**
 * Single source of truth for the Node.js Lambda runtime used by the hosting
 * package's OWN Lambda functions (the KVS-writer custom resource, the ISR
 * cache-seed provider, etc.). Set every such `Function` runtime to this rather
 * than hardcoding `Runtime.NODEJS_*_X`, so the package moves in lockstep when
 * the runtime is bumped.
 *
 * Scope: this governs ONLY hosting-owned handlers. It deliberately does NOT
 * govern the SSR/edge bundles the adapters emit (Astro/Nuxt/OpenNext), which
 * pin `nodejs20.x` to match the Node version the framework compiled the bundle
 * against — bumping those independently of the bundle would break them. That is
 * why the adapters emit a literal rather than importing this constant.
 *
 * Mirrors `@aws-blocks/core`'s `DEFAULT_NODE_RUNTIME`; kept local because
 * hosting does not depend on core. Bump both together. This controls only the
 * AWS-managed runtime that executes deployed handlers — independent of the Node
 * version the CLI / CDK synth runs on.
 */
export const DEFAULT_NODE_RUNTIME = Runtime.NODEJS_24_X;
