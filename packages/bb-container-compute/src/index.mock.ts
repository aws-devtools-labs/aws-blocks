// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-dev (mock) and types entry point for `ContainerCompute`.
 *
 * Local dev runs the backend in-process with no container, so — as at runtime —
 * there is nothing for a compute to provision or execute. The mock reuses the
 * inert runtime handle: it constructs and its `setEnv` is a no-op. Event blocks
 * assigned to a container run their handlers in-process locally, exactly as they
 * do on the default compute, so a container assignment is transparent in dev.
 */
export { ContainerCompute } from './index.aws.js';
export type { ContainerComputeProps } from './types.js';
